/**
 * Main video player component.
 *
 * Contains:
 * - Video frame canvas (background layer)
 * - Skeleton overlay canvas (foreground layer with interaction)
 * - Seekbar for frame navigation
 *
 * Mirrors SLEAP's QtVideoPlayer.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { debugFlags } from "../panels/DebugPanel";
import { Seekbar } from "./Seekbar";
import { ContextMenu } from "./ContextMenu";
import {
  renderInstances,
  renderCentroids,
  hitTestNode,
  hitTestInstance,
  renderSelectedNodeHighlights,
  renderHoveredNodeHighlight,
  renderHoverInstanceBBox,
  renderMarqueeRect,
  nodesInRect,
  makeNodeKey,
  parseNodeKey,
  type RenderedInstance,
  type RenderedNode,
} from "../../canvas/SkeletonRenderer";
import { instanceVisible, instanceShowsNonVisible } from "@/lib/instanceVisibility";
import { useQcVisibility } from "@/hooks/useQcVisibility";
import { getPaletteColor, getInstanceColor, rgbToCSS } from "../../lib/colorPalettes";
import { COLORMAPS } from "../../lib/colormaps";
import { renderTrails } from "../../canvas/TrailRenderer";
import {
  commandContext,
  ConvertPredictionToInstance,
  BeginEdit,
  DeletePredictionsByArea,
  SeedCentroid,
  DeleteSelectedInstance,
  GoNextSuggestion,
} from "../../commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toImageCoords, toSourceCoords } from "@/lib/cropTransform";
import {
  isVideoMissing,
  resolveVideoFile,
  videoIssue,
  ensureVideoBackend,
} from "../../lib/resolveVideos";
import { Film } from "lucide-react";

/**
 * Clone an instance's points into plain objects — used to adopt a predicted
 * centroid as a fresh user Instance during a Phase-2 keypoint pass (mirrors the
 * ConvertPredictionToInstance clone). Element-assign, never spread the columnar
 * PointView.
 */
function clonePointsForAdopt(points: Instance["points"]) {
  return points.map((p) => ({
    xy: [p.xy[0], p.xy[1]] as [number, number],
    visible: p.visible,
    complete: p.complete,
    name: p.name,
    score: p.score,
  }));
}

export function VideoPlayer() {
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const insetCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const crosshairRef = useRef<HTMLDivElement>(null);

  // State from store
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const labels = useAppStore((s) => s.labels);
  const selectedInstance = useAppStore((s) => s.instance);
  const showInstances = useAppStore((s) => s.showInstances);
  const showLabels = useAppStore((s) => s.showLabels);
  const showEdges = useAppStore((s) => s.showEdges);
  const showNonVisibleNodes = useAppStore((s) => s.showNonVisibleNodes);
  const hiddenInstances = useAppStore((s) => s.hiddenInstances);
  const viewOnlyInstance = useAppStore((s) => s.viewOnlyInstance);
  const showNonVisibleOverride = useAppStore((s) => s.showNonVisibleOverride);
  const colorPredicted = useAppStore((s) => s.colorPredicted);
  const fit = useAppStore((s) => s.fit);
  const edgeStyle = useAppStore((s) => s.edgeStyle);
  const markerSize = useAppStore((s) => s.markerSize);
  const nodeLabelSize = useAppStore((s) => s.nodeLabelSize);
  const palette = useAppStore((s) => s.palette);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const trailLength = useAppStore((s) => s.trailLength);
  const lutMin = useAppStore((s) => s.lutMin);
  const lutMax = useAppStore((s) => s.lutMax);
  const autoContrast = useAppStore((s) => s.autoContrast);
  const frameHistogram = useAppStore((s) => s.frameHistogram);
  const colormap = useAppStore((s) => s.colormap);
  const rotation = useAppStore((s) => s.rotation);

  // Per-frame auto-contrast levels: percentile-clipped min/max from the frame
  // histogram. Only applied when `autoContrast` is on; the manual lutMin/lutMax
  // are left untouched so toggling is instant and non-destructive.
  const [autoLutMin, autoLutMax] = useMemo(() => {
    if (!frameHistogram) return [0, 255] as [number, number];
    let total = 0;
    for (let i = 0; i < 256; i++) total += frameHistogram[i];
    if (total === 0) return [0, 255] as [number, number];
    const clip = 0.005; // ignore the darkest/brightest 0.5% (hot/dead pixels)
    const loTarget = total * clip;
    const hiTarget = total * (1 - clip);
    let cum = 0;
    let lo = 0;
    for (let i = 0; i < 256; i++) {
      cum += frameHistogram[i];
      if (cum >= loTarget) {
        lo = i;
        break;
      }
    }
    cum = 0;
    let hi = 255;
    for (let i = 0; i < 256; i++) {
      cum += frameHistogram[i];
      if (cum >= hiTarget) {
        hi = i;
        break;
      }
    }
    if (hi <= lo) hi = Math.min(255, lo + 1);
    return [lo, hi] as [number, number];
  }, [frameHistogram]);
  const defaultToPan = useAppStore((s) => s.defaultToPan);
  const fitSelection = useAppStore((s) => s.fitSelection);
  const areaDeleteMode = useAppStore((s) => s.areaDeleteMode);
  const showCrosshair = useAppStore((s) => s.showCrosshair);

  // Local zoom/pan state
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  // Ref tracks latest zoom/pan for synchronous access in wheel handler,
  // avoiding stale closures and React batching issues with nested setState.
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  viewRef.current = { zoom, panX, panY };
  const [isDragging, setIsDragging] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [isCmdHeld, setIsCmdHeld] = useState(false);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const [isZoomDragging, setIsZoomDragging] = useState(false);
  // XOR: defaultToPan reverses the meaning of space for pan vs select
  const shouldPan = defaultToPan !== isSpaceHeld;
  const zoomDragStart = useRef<{
    clientX: number; clientY: number;
    zoom: number; panX: number; panY: number;
    anchorX: number; anchorY: number;
  } | null>(null);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragNodeInfo, setDragNodeInfo] = useState<{
    instanceIdx: number;
    nodeIdx: number;
  } | null>(null);

  // Multi-node selection state (local/ephemeral)
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [interactionMode, setInteractionMode] = useState<"idle" | "marquee" | "dragging">("idle");
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
  const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(null);
  // Area-delete rectangle state
  const [areaDeleteStart, setAreaDeleteStart] = useState<{ x: number; y: number } | null>(null);
  const [areaDeleteEnd, setAreaDeleteEnd] = useState<{ x: number; y: number } | null>(null);
  const [isAreaDeleting, setIsAreaDeleting] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<{
    instanceIdx: number;
    nodeIdx: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const shiftHeldOnMouseDown = useRef(false);

  // Track the last scene position during drag for delta calculations (alt-drag)
  const lastDragPos = useRef<{ x: number; y: number } | null>(null);

  // Track drag-start screen position for anchoring tooltip + inset
  const dragStartClient = useRef<{ clientX: number; clientY: number } | null>(null);

  // Track cursor scene position for placement-mode inset
  const cursorScene = useRef<{ x: number; y: number } | null>(null);

  // Track whether an undo snapshot has been taken for the current rotation gesture
  const rotationSnapshotTaken = useRef(false);

  // Double-tap spacebar zoom cycle
  const lastSpaceDownTime = useRef(0);
  const zoomMode = useRef<"free" | "fit-content" | "fit-frame">("free");
  const savedFreeView = useRef({ zoom: 1, panX: 0, panY: 0 });

  // Track frame canvas dimensions so overlay can sync after async frame load
  const [frameDims, setFrameDims] = useState<[number, number]>([0, 0]);
  // Counter to trigger frame canvas re-render when a new bitmap is loaded (even same dims)
  const [bitmapVersion, setBitmapVersion] = useState(0);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    instanceIdx: number | null;
    nodeIdx: number | null;
  } | null>(null);

  // Rendered instances cache
  const renderedInstancesRef = useRef<RenderedInstance[]>([]);

  // Store frame as ImageBitmap so we can re-draw with transforms
  const frameBitmapRef = useRef<OffscreenCanvas | null>(null);

  // Track container dimensions for fit-to-window rendering
  const [containerSize, setContainerSize] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      setContainerSize((prev) => (prev[0] === w && prev[1] === h ? prev : [w, h]));
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Track spacebar hold for pan mode + double-tap zoom cycle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        // Don't hijack space when typing in an input/textarea
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        // In centroid-seeding mode, Space advances to the next frame instead of
        // pan/zoom (which owns Space elsewhere). Mirrors the top-bar button.
        if (useAppStore.getState().labelingMode === "seed") {
          e.preventDefault();
          const s = useAppStore.getState();
          if (s.labels && s.labels.suggestions.length > 0) {
            commandContext.execute(GoNextSuggestion);
          } else {
            s.incrementFrameIdx(1);
          }
          return;
        }
        e.preventDefault();

        const now = performance.now();
        const elapsed = now - lastSpaceDownTime.current;
        lastSpaceDownTime.current = now;

        if (elapsed < 300) {
          // Double-tap detected: cycle zoom modes
          const currentMode = zoomMode.current;

          if (currentMode === "free") {
            // Save current view before cycling
            savedFreeView.current = { ...viewRef.current };

            // fit-content: zoom to fit all visible instance nodes
            const instances = renderedInstancesRef.current;
            const allNodes = instances.flatMap((inst) =>
              inst.nodes.filter((n) => n.visible)
            );
            if (allNodes.length > 0) {
              const container = containerRef.current;
              if (container) {
                const cRect = container.getBoundingClientRect();
                const cw = cRect.width;
                const ch = cRect.height;
                const fw = frameBitmapRef.current?.width ?? 0;
                const fh = frameBitmapRef.current?.height ?? 0;
                if (fw > 0 && fh > 0) {
                  const bs = Math.min(cw / fw, ch / fh);
                  const ox = (cw - fw * bs) / 2;
                  const oy = (ch - fh * bs) / 2;

                  const xs = allNodes.map((n) => n.x);
                  const ys = allNodes.map((n) => n.y);
                  const pad = 50;
                  const minX = Math.min(...xs) - pad;
                  const maxX = Math.max(...xs) + pad;
                  const minY = Math.min(...ys) - pad;
                  const maxY = Math.max(...ys) + pad;
                  const bboxW = maxX - minX;
                  const bboxH = maxY - minY;

                  if (bboxW > 0 && bboxH > 0) {
                    const newZoom = Math.min(cw / (bboxW * bs), ch / (bboxH * bs), 10);
                    const centerX = (minX + maxX) / 2;
                    const centerY = (minY + maxY) / 2;
                    const newPanX = cw / 2 - ox - centerX * bs * newZoom;
                    const newPanY = ch / 2 - oy - centerY * bs * newZoom;

                    viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
                    setZoom(newZoom);
                    setPanX(newPanX);
                    setPanY(newPanY);
                    zoomMode.current = "fit-content";
                  }
                }
              }
            }
          } else if (currentMode === "fit-content") {
            // fit-frame: reset to zoom=1, centered
            viewRef.current = { zoom: 1, panX: 0, panY: 0 };
            setZoom(1);
            setPanX(0);
            setPanY(0);
            zoomMode.current = "fit-frame";
          } else {
            // fit-frame -> free: restore saved view
            const saved = savedFreeView.current;
            viewRef.current = { ...saved };
            setZoom(saved.zoom);
            setPanX(saved.panX);
            setPanY(saved.panY);
            zoomMode.current = "free";
          }
          return;
        }

        setIsSpaceHeld(true);
      }
      if (e.key === "Meta" || e.key === "Control") {
        setIsCmdHeld(true);
      }
      if (e.key === "Shift" && !e.repeat) {
        setIsShiftHeld(true);
        useAppStore.getState().bumpOverlayVersion();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpaceHeld(false);
      }
      if (e.key === "Meta" || e.key === "Control") {
        setIsCmdHeld(false);
      }
      if (e.key === "Shift") {
        setIsShiftHeld(false);
        useAppStore.getState().bumpOverlayVersion();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // Toggle node visibility with 'v' key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code !== "KeyV" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const lf = useAppStore.getState().labeledFrame;
      if (!lf) return;

      if (selectedNodes.size > 0) {
        // Toggle selected nodes
        e.preventDefault();
        commandContext.execute(BeginEdit);
        let visibleCount = 0;
        for (const key of selectedNodes) {
          const { instanceIdx, nodeIdx } = parseNodeKey(key);
          const point = lf.instances[instanceIdx]?.points[nodeIdx];
          if (point?.visible) visibleCount++;
        }
        const makeVisible = visibleCount <= selectedNodes.size / 2;
        for (const key of selectedNodes) {
          const { instanceIdx, nodeIdx } = parseNodeKey(key);
          const point = lf.instances[instanceIdx]?.points[nodeIdx];
          if (point) point.visible = makeVisible;
        }
        useAppStore.getState().markChanged();
        useAppStore.getState().touchFrame();
        useAppStore.getState().bumpOverlayVersion();
      } else if (hoveredNode) {
        // Toggle hovered node
        e.preventDefault();
        commandContext.execute(BeginEdit);
        const point = lf.instances[hoveredNode.instanceIdx]?.points[hoveredNode.nodeIdx];
        if (point) {
          point.visible = !point.visible;
          useAppStore.getState().markChanged();
          useAppStore.getState().touchFrame();
          useAppStore.getState().bumpOverlayVersion();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodes, hoveredNode]);

  // Delete/Backspace: delete instances when all their visible nodes are selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.metaKey || e.ctrlKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // In keypointPass, Backspace is the pass step-back key — don't also let it
      // delete a (possibly stale-selected) instance out from under the sweep.
      if (useAppStore.getState().labelingMode === "keypointPass") return;
      if (selectedNodes.size === 0) return;

      const lf = useAppStore.getState().labeledFrame;
      if (!lf) return;

      const selectedByInstance = new Map<number, Set<number>>();
      for (const key of selectedNodes) {
        const { instanceIdx, nodeIdx } = parseNodeKey(key);
        if (!selectedByInstance.has(instanceIdx)) {
          selectedByInstance.set(instanceIdx, new Set());
        }
        selectedByInstance.get(instanceIdx)!.add(nodeIdx);
      }

      const instancesToDelete: number[] = [];
      for (const [instanceIdx, selectedNodeIdxs] of selectedByInstance) {
        const instance = lf.instances[instanceIdx];
        if (!instance) continue;

        let visibleCount = 0;
        for (const point of instance.points) {
          if (!isNaN(point.xy[0]) && !isNaN(point.xy[1])) {
            visibleCount++;
          }
        }

        if (visibleCount > 0 && selectedNodeIdxs.size >= visibleCount) {
          instancesToDelete.push(instanceIdx);
        }
      }

      if (instancesToDelete.length === 0) return;

      e.preventDefault();
      commandContext.execute(BeginEdit);

      instancesToDelete.sort((a, b) => b - a);
      for (const idx of instancesToDelete) {
        lf.instances.splice(idx, 1);
      }

      setSelectedNodes(new Set());
      const store = useAppStore.getState();
      if (store.instance && !lf.instances.includes(store.instance)) {
        store.setInstance(null);
      }
      store.setLabeledFrame(lf.instances.length > 0 ? lf : null);
      store.markChanged();
      store.touchFrame();
      store.bumpOverlayVersion();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodes]);

  // Compute fit-to-window base scale and centering offsets
  const [cw, ch] = containerSize;
  const [fw, fh] = frameDims;
  // For 90/270 rotation, swap effective dimensions for fitting
  const isRotated90 = rotation === 90 || rotation === 270;
  const displayW = isRotated90 ? fh : fw;
  const displayH = isRotated90 ? fw : fh;
  const baseScale = displayW > 0 && displayH > 0 ? Math.min(cw / displayW, ch / displayH) : 1;
  const offsetX = displayW > 0 && displayH > 0 ? (cw - displayW * baseScale) / 2 : 0;
  const offsetY = displayW > 0 && displayH > 0 ? (ch - displayH * baseScale) / 2 : 0;

  // Load the current frame (convert to ImageBitmap, trigger dimension update)
  useEffect(() => {
    if (!video) {
      // Release the scrub gate even when we can't read, so the seekbar loop
      // never jams waiting on a read that will never happen.
      useAppStore.getState().set("frameLoading", false);
      return;
    }

    let cancelled = false;
    const t0 = performance.now();
    if (debugFlags.logSeeking) console.debug(`[seek] requesting frame ${frameIdx}`);

    (async () => {
      try {
        // Lazy video backends: the decoder is deferred at load (open one video,
        // not all N). Open it on first view, then read. ensureVideoBackend clears
        // lazyPath after opening, so this whole block is skipped from then on.
        if (!video.backend) {
          const meta = video.backendMetadata as
            | Record<string, unknown>
            | undefined;
          if (typeof meta?.lazyPath === "string") {
            const { readFile } = await import("@tauri-apps/plugin-fs");
            await ensureVideoBackend(video, readFile);
          }
          if (cancelled) return;
          if (!video.backend) {
            useAppStore.getState().set("frameLoading", false);
            return;
          }
        }
        // While scrubbing, skip the backend's read-ahead prefetch: those frames
        // are scrubbed past (wasted) and their reads saturate a slow mount,
        // slowing the frame we actually want (~3.6x on the VAST mount). Mirrors
        // PyQt's worker, which does no read-ahead while scrubbing.
        const framesBefore = video.shape?.[0] ?? null;
        const frame = await video.getFrame(frameIdx, {
          prefetch: !useAppStore.getState().isScrubbing,
        });
        // A deferred embedded backend (lazyVideoMetadata) reads its per-video
        // metadata on this first getFrame and corrects video.shape[0] to the true
        // source frame count — nudge the store so the seekbar/status bar re-read
        // the real extent instead of the JSON-seeded (labeled-count) stand-in.
        if ((video.shape?.[0] ?? null) !== framesBefore) {
          useAppStore.getState().markVideoUpdated();
        }
        if (debugFlags.logSeeking) console.debug(`[seek] getFrame(${frameIdx}) returned ${frame?.constructor?.name ?? "null"} in ${(performance.now() - t0).toFixed(1)}ms`);
        if (cancelled || !frame) {
          if (debugFlags.logSeeking && cancelled) console.debug(`[seek] frame ${frameIdx} cancelled`);
          return;
        }

        // Copy the backend's frame into an OffscreenCanvas we own via a fast GPU
        // blit (drawImage) / putImageData — NOT createImageBitmap(). The MP4
        // backend caches & reuses the returned ImageBitmap, so we can't hold or
        // close it; the old defensive `createImageBitmap(frame)` clone did that
        // but is pathologically slow in WKWebView (~300 ms for a 1280x1024 frame,
        // which dominated every seek). A drawImage into our own canvas is ~1-5 ms
        // and leaves the backend's cache untouched.
        let bmp: OffscreenCanvas;

        if (frame instanceof ImageBitmap) {
          bmp = new OffscreenCanvas(frame.width, frame.height);
          bmp.getContext("2d")?.drawImage(frame, 0, 0);
        } else if (frame instanceof ImageData) {
          bmp = new OffscreenCanvas(frame.width, frame.height);
          bmp.getContext("2d")?.putImageData(frame, 0, 0);
        } else if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
          const bytes =
            frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
          const shape = video.shape;
          if (!shape) return;
          const [, h, w] = shape;
          const imageData = new ImageData(new Uint8ClampedArray(bytes), w, h);
          bmp = new OffscreenCanvas(w, h);
          bmp.getContext("2d")?.putImageData(imageData, 0, 0);
        } else {
          return;
        }

        if (cancelled) {
          if (debugFlags.logSeeking) console.debug(`[seek] frame ${frameIdx} cancelled after decode`);
          return;
        }

        // Histogram is computed OFF this path — see the debounced effect below.
        // It needs a full-frame getImageData (a GPU->CPU readback that costs
        // ~200-340ms in WKWebView); running it here blocked every seek. The frame
        // now paints immediately and the histogram catches up when nav settles.
        frameBitmapRef.current = bmp;
        setFrameDims((prev) => (prev[0] === bmp.width && prev[1] === bmp.height ? prev : [bmp.width, bmp.height]));
        setBitmapVersion((v) => v + 1);
        if (debugFlags.logSeeking) console.debug(`[seek] frame ${frameIdx} rendered (${bmp.width}x${bmp.height}) total ${(performance.now() - t0).toFixed(1)}ms`);
      } catch (err) {
        console.error("Failed to render frame:", err);
      } finally {
        // Release the scrub serialization gate so the seekbar drag loop can
        // issue the next frame. Set unconditionally: during a scrub only one
        // read is in flight at a time (the loop won't issue while loading), and
        // for non-scrub seeks this is a harmless no-op.
        useAppStore.getState().set("frameLoading", false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [video, frameIdx, overlayVersion]);

  // Frame histogram, computed OFF the seek path. A full-frame getImageData is a
  // GPU->CPU readback (~200-340ms in WKWebView) — doing it inline blocked every
  // jump. Keyed on bitmapVersion and debounced, so rapid arrow/scrub navigation
  // pays it once (when nav settles), never per intermediate frame. Skipped while
  // scrubbing. `bmp` is now an OffscreenCanvas we own, so we read straight from
  // its context (no extra canvas/drawImage).
  useEffect(() => {
    if (useAppStore.getState().isScrubbing) return;
    const id = setTimeout(() => {
      const bmp = frameBitmapRef.current;
      const offCtx = bmp?.getContext("2d");
      if (!bmp || !offCtx) return;
      const d = offCtx.getImageData(0, 0, bmp.width, bmp.height).data;
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) hist[d[i + 1]]++;
      useAppStore.getState().set("frameHistogram", hist);
    }, 150);
    return () => clearTimeout(id);
  }, [bitmapVersion]);

  // Render the frame with fit-to-window base transform + user zoom/pan
  useEffect(() => {
    const canvas = frameCanvasRef.current;
    const bmp = frameBitmapRef.current;
    if (!canvas || !bmp) return;

    const [cw, ch] = containerSize;
    if (cw === 0 || ch === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(offsetX + panX, offsetY + panY);
    ctx.scale(baseScale * zoom, baseScale * zoom);
    // Apply virtual rotation
    if (rotation === 90) {
      ctx.translate(fh, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      ctx.translate(fw, fh);
      ctx.rotate(Math.PI);
    } else if (rotation === 270) {
      ctx.translate(0, fw);
      ctx.rotate((3 * Math.PI) / 2);
    }
    ctx.imageSmoothingEnabled = baseScale * zoom <= 2;
    try {
      // Auto-contrast overrides the manual LUT with per-frame percentile levels.
      const effLutMin = autoContrast ? autoLutMin : lutMin;
      const effLutMax = autoContrast ? autoLutMax : lutMax;
      const needsLUT = effLutMin > 0 || effLutMax < 255;
      const cmapLUT = COLORMAPS[colormap] ?? null;
      if (needsLUT || cmapLUT) {
        const offscreen = new OffscreenCanvas(bmp.width, bmp.height);
        const offCtx = offscreen.getContext("2d")!;
        offCtx.drawImage(bmp, 0, 0);
        const imgData = offCtx.getImageData(0, 0, bmp.width, bmp.height);
        const d = imgData.data;
        const range = effLutMax - effLutMin || 1;
        for (let i = 0; i < d.length; i += 4) {
          let r = d[i], g = d[i + 1], b = d[i + 2];
          if (needsLUT) {
            r = Math.max(0, Math.min(255, ((r - effLutMin) / range) * 255));
            g = Math.max(0, Math.min(255, ((g - effLutMin) / range) * 255));
            b = Math.max(0, Math.min(255, ((b - effLutMin) / range) * 255));
          }
          if (cmapLUT) {
            // Use luminance of the (possibly LUT-adjusted) pixel to index colormap
            const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            const c = cmapLUT[Math.max(0, Math.min(255, lum))];
            r = c[0]; g = c[1]; b = c[2];
          }
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
        offCtx.putImageData(imgData, 0, 0);
        ctx.drawImage(offscreen, 0, 0);
      } else {
        ctx.drawImage(bmp, 0, 0);
      }
    } catch {
      // Bitmap was closed (detached) by a racing frame load — skip, next frame will redraw
    }
    ctx.restore();
  }, [frameDims, containerSize, zoom, panX, panY, baseScale, offsetX, offsetY, bitmapVersion, lutMin, lutMax, autoContrast, autoLutMin, autoLutMax, colormap, rotation]);

  // Find the current labeled frame and update store
  useEffect(() => {
    if (!labels || !video) {
      useAppStore.getState().setLabeledFrame(null);
      return;
    }

    const frames = labels.find({ video, frameIdx });
    const lf = frames.length > 0 ? frames[0] : null;
    useAppStore.getState().setLabeledFrame(lf);
  }, [labels, video, frameIdx]);

  // Render skeleton overlay
  const labeledFrame = useAppStore((s) => s.labeledFrame);

  // Drive QC display modes: reactively write per-instance visibility flags into
  // the transient store based on the current frame's instances. Manual mode is a
  // no-op, leaving the per-instance columns in control.
  useQcVisibility(labeledFrame?.instances ?? []);

  // Clear multi-node selection on frame change
  useEffect(() => {
    setSelectedNodes(new Set());
    setHoveredNode(null);
    setInteractionMode("idle");
    setMarqueeStart(null);
    setMarqueeEnd(null);
  }, [frameIdx, labeledFrame]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    // Use container dimensions for canvas size
    const [cw, ch] = containerSize;
    if (cw === 0 || ch === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    if (!labeledFrame || !showInstances) {
      renderedInstancesRef.current = [];
      return;
    }

    // Build renderable instances
    const tracks = labels?.tracks ?? [];
    const vis = { showInstances, hiddenInstances, viewOnlyInstance, showNonVisibleOverride };
    const instances: RenderedInstance[] = labeledFrame.instances.map(
      (inst, idx) => {
        const isPredicted = inst instanceof PredictedInstance;
        const skeleton = inst.skeleton;
        const color = getInstanceColor(
          palette, distinctlyColor, idx, inst.track, tracks, isPredicted, colorPredicted
        );

        // Per-node colors when distinctlyColor === "node"
        const nodeColors = distinctlyColor === "node" && !(isPredicted && !colorPredicted)
          ? skeleton.nodes.map((_, nIdx) => getPaletteColor(palette, nIdx))
          : undefined;

        // Per-edge colors when distinctlyColor === "edge"
        const edgeIndices = skeleton.edgeIndices;
        const edgeColors = distinctlyColor === "edge" && !(isPredicted && !colorPredicted)
          ? edgeIndices.map((_, eIdx) => getPaletteColor(palette, eIdx))
          : undefined;

        const nodes: RenderedNode[] = inst.points.map((point, nIdx) => {
          // Cropped videos store points in SOURCE coords; translate into the
          // displayed crop-local image space so they overlay the cropped frame.
          // Identity for uncropped videos. (cropped pkg.slp / SLP-2.3)
          const [nx, ny] = toImageCoords(video, point.xy[0], point.xy[1]);
          return {
            x: nx,
            y: ny,
            visible: point.visible && !isNaN(point.xy[0]),
            complete: point.complete,
            name: skeleton.nodes[nIdx]?.name ?? `node_${nIdx}`,
            score: point.score,
          };
        });

        const edges = edgeIndices.map(
          ([srcIdx, dstIdx]) =>
            ({ srcIdx, dstIdx }) as { srcIdx: number; dstIdx: number }
        );

        return {
          nodes,
          edges,
          color,
          nodeColors,
          edgeColors,
          isPredicted,
          isSelected: inst === selectedInstance,
          trackName: inst.track?.name ?? null,
          score: isPredicted ? inst.score : undefined,
          visible: instanceVisible(vis, inst),
          showNonVisible: instanceShowsNonVisible(vis, inst, showNonVisibleNodes),
        };
      }
    );

    renderedInstancesRef.current = instances;

    // Apply fit-to-window base transform + user zoom/pan + rotation
    ctx.save();
    ctx.translate(offsetX + panX, offsetY + panY);
    ctx.scale(baseScale * zoom, baseScale * zoom);
    if (rotation === 90) {
      ctx.translate(fh, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      ctx.translate(fw, fh);
      ctx.rotate(Math.PI);
    } else if (rotation === 270) {
      ctx.translate(0, fw);
      ctx.rotate((3 * Math.PI) / 2);
    }

    // Render motion trails before skeleton instances (behind)
    if (trailLength > 0 && labels && video) {
      renderTrails(
        ctx,
        labels,
        frameIdx,
        video,
        trailLength,
        labels.tracks,
        palette,
        zoom
      );
    }

    const renderOpts = {
      markerSize,
      nodeLabelSize,
      edgeStyle,
      showInstances,
      showLabels,
      showEdges,
      showNonVisibleNodes,
      colorPredicted,
      zoom: baseScale * zoom,
    };

    renderInstances(ctx, instances, renderOpts);

    // First-class centroid annotations (frame.centroids): drawn as amber
    // crosshair rings, distinct from skeleton nodes. Coords go through the same
    // crop transform as instance nodes.
    if (labeledFrame.centroids.length > 0) {
      const renderedCentroids = labeledFrame.centroids.map((c) => {
        const [cx, cy] = toImageCoords(video, c.x, c.y);
        return { x: cx, y: cy, predicted: c.isPredicted };
      });
      renderCentroids(ctx, renderedCentroids, renderOpts);
    }

    // Compute effective selection (includes live marquee preview)
    let effectiveSelection = selectedNodes;
    if (marqueeStart && marqueeEnd) {
      const marqueeHits = nodesInRect(instances, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y);
      if (marqueeHits.size > 0 || selectedNodes.size > 0) {
        effectiveSelection = new Set([...selectedNodes, ...marqueeHits]);
      }
    }

    // Render multi-node selection highlights
    if (effectiveSelection.size > 0) {
      renderSelectedNodeHighlights(ctx, instances, effectiveSelection, renderOpts);
    }

    // Render hover highlights
    if (hoveredNode && instances[hoveredNode.instanceIdx]) {
      renderHoverInstanceBBox(ctx, instances[hoveredNode.instanceIdx], renderOpts);
      renderHoveredNodeHighlight(ctx, instances, hoveredNode.instanceIdx, hoveredNode.nodeIdx, renderOpts);
    }

    // Render marquee selection rectangle
    if (marqueeStart && marqueeEnd) {
      renderMarqueeRect(ctx, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y, baseScale * zoom);
    }

    // Render area-delete rectangle (red dashed)
    if (areaDeleteStart && areaDeleteEnd) {
      const adx1 = areaDeleteStart.x;
      const ady1 = areaDeleteStart.y;
      const adx2 = areaDeleteEnd.x;
      const ady2 = areaDeleteEnd.y;
      ctx.save();
      ctx.strokeStyle = "rgba(255, 60, 60, 0.9)";
      ctx.lineWidth = 2 / (baseScale * zoom);
      ctx.setLineDash([6 / (baseScale * zoom), 4 / (baseScale * zoom)]);
      ctx.fillStyle = "rgba(255, 60, 60, 0.1)";
      ctx.beginPath();
      ctx.rect(
        Math.min(adx1, adx2),
        Math.min(ady1, ady2),
        Math.abs(adx2 - adx1),
        Math.abs(ady2 - ady1)
      );
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }, [
    labeledFrame,
    selectedInstance,
    showInstances,
    showLabels,
    showEdges,
    showNonVisibleNodes,
    hiddenInstances,
    viewOnlyInstance,
    showNonVisibleOverride,
    colorPredicted,
    edgeStyle,
    markerSize,
    nodeLabelSize,
    palette,
    distinctlyColor,
    trailLength,
    zoom,
    panX,
    panY,
    frameDims,
    containerSize,
    baseScale,
    offsetX,
    offsetY,
    overlayVersion,
    selectedNodes,
    hoveredNode,
    marqueeStart,
    marqueeEnd,
    areaDeleteStart,
    areaDeleteEnd,
    labels,
    video,
    frameIdx,
    rotation,
  ]);

  // Check if we're in explicit placement mode
  const labelingMode = useAppStore((s) => s.labelingMode);
  const placementNodeIdx = useAppStore((s) => s.placementNodeIdx);
  const isPlacingNodes = labelingMode === "place" && selectedInstance !== null;

  // Phase-2 keypoint-pass state (drives zoom-to-centroid; click-to-place reads
  // the rest via getState()). The progress HUD is the full-width KeypointPassBar.
  const passCursor = useAppStore((s) => s.passCursor);
  const passWorkList = useAppStore((s) => s.passWorkList);
  const passZoomWindow = useAppStore((s) => s.passZoomWindow);
  const isKeypointPass = labelingMode === "keypointPass";

  // Render zoomed inset during node drag or placement mode
  const INSET_SIZE = useAppStore((s) => s.insetSize);
  const INSET_ZOOM = useAppStore((s) => s.insetZoom);
  useEffect(() => {
    const inset = insetCanvasRef.current;
    if (!inset) return;

    const hideInset = () => {
      inset.style.display = "none";
      inset.style.left = "";
      inset.style.top = "";
      inset.style.right = "";
    };

    const isDragInset = interactionMode === "dragging" && !!dragNodeInfo;
    const isPlaceInset = isPlacingNodes && !!cursorScene.current;
    const isHoldInset = isShiftHeld && !!cursorScene.current;
    if (!isDragInset && !isPlaceInset && !isHoldInset) {
      hideInset();
      return;
    }

    const bmp = frameBitmapRef.current;
    if (!bmp) {
      hideInset();
      return;
    }

    const instances = renderedInstancesRef.current;

    // Determine center point and overlay instance
    let centerX: number, centerY: number;
    let overlayInst: (typeof instances)[number] | null = null;
    let skipNodeIdx = -1;

    if (isDragInset) {
      const inst = instances[dragNodeInfo!.instanceIdx];
      const node = inst?.nodes[dragNodeInfo!.nodeIdx];
      if (!inst || !node) { hideInset(); return; }
      centerX = node.x;
      centerY = node.y;
      overlayInst = inst;
      skipNodeIdx = dragNodeInfo!.nodeIdx;
    } else {
      centerX = cursorScene.current!.x;
      centerY = cursorScene.current!.y;
      // Find the selected instance in rendered instances
      const selIdx = instances.findIndex((i) => i.isSelected);
      if (selIdx !== -1) overlayInst = instances[selIdx];
    }

    inset.style.display = "block";

    // Position: anchor near tooltip for drag, top-right for placement
    const container = containerRef.current;
    if (isDragInset && container && dragStartClient.current) {
      const containerRect = container.getBoundingClientRect();
      const TOOLTIP_OFFSET_X = 16;
      const TOOLTIP_OFFSET_Y = -8;
      const TOOLTIP_HEIGHT_ESTIMATE = 80;
      const GAP = 6;

      const tipLeft =
        dragStartClient.current.clientX - containerRect.left + TOOLTIP_OFFSET_X;
      const tipTop =
        dragStartClient.current.clientY - containerRect.top + TOOLTIP_OFFSET_Y;

      let insetLeft = tipLeft;
      let insetTop = tipTop + TOOLTIP_HEIGHT_ESTIMATE + GAP;

      if (insetTop + INSET_SIZE > containerRect.height) {
        insetTop = tipTop - INSET_SIZE - GAP;
      }

      insetLeft = Math.max(8, Math.min(insetLeft, containerRect.width - INSET_SIZE - 8));
      insetTop = Math.max(8, insetTop);

      inset.style.left = `${insetLeft}px`;
      inset.style.top = `${insetTop}px`;
      inset.style.right = "auto";
    } else {
      inset.style.top = "12px";
      inset.style.right = "12px";
      inset.style.left = "auto";
    }

    const dpr = window.devicePixelRatio || 1;
    inset.width = INSET_SIZE * dpr;
    inset.height = INSET_SIZE * dpr;
    inset.style.width = `${INSET_SIZE}px`;
    inset.style.height = `${INSET_SIZE}px`;

    const ctx = inset.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, INSET_SIZE, INSET_SIZE);

    // Draw magnified frame region centered on the target point
    // Inset zoom is relative to the current viewport zoom level
    const effectiveZoom = INSET_ZOOM * zoom;
    const srcSize = INSET_SIZE / effectiveZoom;
    const sx = centerX - srcSize / 2;
    const sy = centerY - srcSize / 2;

    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(bmp, sx, sy, srcSize, srcSize, 0, 0, INSET_SIZE, INSET_SIZE);
    } catch {
      // Bitmap may be closed
    }

    // Draw nearby edges from the overlay instance
    const toInset = (px: number, py: number) => ({
      ix: (px - sx) * effectiveZoom,
      iy: (py - sy) * effectiveZoom,
    });

    if (overlayInst) {
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      for (const edge of overlayInst.edges) {
        const src = overlayInst.nodes[edge.srcIdx];
        const dst = overlayInst.nodes[edge.dstIdx];
        if (!src?.visible || !dst?.visible) continue;
        const s = toInset(src.x, src.y);
        const d = toInset(dst.x, dst.y);
        const edgeColor = overlayInst.edgeColors
          ? overlayInst.edgeColors[overlayInst.edges.indexOf(edge)]
          : overlayInst.color;
        ctx.strokeStyle = rgbToCSS(edgeColor);
        ctx.beginPath();
        ctx.moveTo(s.ix, s.iy);
        ctx.lineTo(d.ix, d.iy);
        ctx.stroke();
      }

      // Draw other visible nodes as small dots
      ctx.globalAlpha = 0.6;
      for (let nIdx = 0; nIdx < overlayInst.nodes.length; nIdx++) {
        if (nIdx === skipNodeIdx) continue;
        const n = overlayInst.nodes[nIdx];
        if (!n.visible) continue;
        const { ix, iy } = toInset(n.x, n.y);
        if (ix < -10 || ix > INSET_SIZE + 10 || iy < -10 || iy > INSET_SIZE + 10) continue;
        const nodeColor = overlayInst.nodeColors ? overlayInst.nodeColors[nIdx] : overlayInst.color;
        ctx.fillStyle = rgbToCSS(nodeColor);
        ctx.beginPath();
        ctx.arc(ix, iy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Draw crosshair spanning full inset
    const cx = INSET_SIZE / 2;
    const cy = INSET_SIZE / 2;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(INSET_SIZE, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, INSET_SIZE);
    ctx.stroke();
  }, [interactionMode, dragNodeInfo, overlayVersion, bitmapVersion, isPlacingNodes, isShiftHeld, INSET_SIZE, INSET_ZOOM, zoom]);

  // Fit view to instances when 'fit' is enabled and frame/labels change
  // Only re-fit when fit is toggled on or the labeled frame changes,
  // not on container resize or other incidental triggers.
  useEffect(() => {
    if (!fit || !labeledFrame) return;
    const [cw, ch] = containerSize;
    if (cw === 0 || ch === 0) return;
    const [fw, fh] = frameDims;
    if (fw === 0 || fh === 0) return;

    const instances = renderedInstancesRef.current;
    const allNodes = instances.flatMap((inst) =>
      inst.nodes.filter((n) => n.visible)
    );
    if (allNodes.length === 0) return;

    const xs = allNodes.map((n) => n.x);
    const ys = allNodes.map((n) => n.y);
    const pad = 50;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;

    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    if (bboxW <= 0 || bboxH <= 0) return;

    // Zoom relative to baseScale so bbox fills the container
    const newZoom = Math.min(cw / (bboxW * baseScale), ch / (bboxH * baseScale), 10);

    // Center the bounding box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const newPanX = cw / 2 - offsetX - centerX * baseScale * newZoom;
    const newPanY = ch / 2 - offsetY - centerY * baseScale * newZoom;

    viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
    setZoom(newZoom);
    setPanX(newPanX);
    setPanY(newPanY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, labeledFrame]);

  // Fit view to selected instance (one-shot action triggered from menu)
  useEffect(() => {
    if (!fitSelection || !selectedInstance) return;
    // Reset the flag immediately so this is a one-shot action
    useAppStore.getState().set("fitSelection", false);

    const [cw, ch] = containerSize;
    if (cw === 0 || ch === 0) return;

    // Find the rendered instance matching the selected instance
    const instances = renderedInstancesRef.current;
    const selectedRendered = instances.find((ri) => ri.isSelected);
    if (!selectedRendered) return;

    const visibleNodes = selectedRendered.nodes.filter((n) => n.visible);
    if (visibleNodes.length === 0) return;

    const xs = visibleNodes.map((n) => n.x);
    const ys = visibleNodes.map((n) => n.y);
    const pad = 50;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;

    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    if (bboxW <= 0 || bboxH <= 0) return;

    const newZoom = Math.min(cw / (bboxW * baseScale), ch / (bboxH * baseScale), 10);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const newPanX = cw / 2 - offsetX - centerX * baseScale * newZoom;
    const newPanY = ch / 2 - offsetY - centerY * baseScale * newZoom;

    viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
    setZoom(newZoom);
    setPanX(newPanX);
    setPanY(newPanY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSelection]);

  // Mouse handlers for interaction
  const canvasToScene = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      // Convert to rotated scene coordinates
      let sx = (cx - offsetX - panX) / (baseScale * zoom);
      let sy = (cy - offsetY - panY) / (baseScale * zoom);
      // Apply inverse rotation to get frame coordinates
      if (rotation === 90) {
        const fx = sy, fy = fh - sx;
        sx = fx; sy = fy;
      } else if (rotation === 180) {
        sx = fw - sx; sy = fh - sy;
      } else if (rotation === 270) {
        const fx = fw - sy, fy = sx;
        sx = fx; sy = fy;
      }
      return { x: sx, y: sy };
    },
    [zoom, panX, panY, baseScale, offsetX, offsetY, rotation, fw, fh]
  );

  // Constrain pan so at least 25% of the video remains visible
  const constrainPan = useCallback(
    (px: number, py: number, z: number) => {
      const [cw, ch] = containerSize;
      if (displayW === 0 || displayH === 0) return { x: px, y: py };
      const scaledW = displayW * baseScale * z;
      const scaledH = displayH * baseScale * z;
      const minVisible = 0.25;
      const minVisibleX = scaledW * minVisible;
      const minVisibleY = scaledH * minVisible;
      const minPX = minVisibleX - scaledW - offsetX;
      const maxPX = cw - minVisibleX - offsetX;
      const minPY = minVisibleY - scaledH - offsetY;
      const maxPY = ch - minVisibleY - offsetY;
      return {
        x: Math.max(minPX, Math.min(maxPX, px)),
        y: Math.max(minPY, Math.min(maxPY, py)),
      };
    },
    [containerSize, frameDims, baseScale, offsetX, offsetY]
  );

  // Auto-exit placement mode when instance is deselected or frame changes
  useEffect(() => {
    if (labelingMode !== "place") return;
    if (!selectedInstance) {
      useAppStore.getState().exitPlacementMode();
      return;
    }
    // Reset placement target to first unplaced node of new instance
    const firstNaN = selectedInstance.points.findIndex(
      (p) => isNaN(p.xy[0]) || isNaN(p.xy[1])
    );
    if (firstNaN === -1) {
      // No unplaced nodes — exit
      useAppStore.getState().exitPlacementMode();
    } else {
      useAppStore.getState().set("placementNodeIdx", firstNaN);
    }
  }, [selectedInstance, frameIdx, labelingMode]);

  // In centroid-seeding, reset to the full-frame view whenever the frame/video
  // changes (or on entering seed mode), so each new animal is framed at 100%
  // instead of inheriting the previous frame's zoom/pan.
  useEffect(() => {
    if (labelingMode !== "seed") return;
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    setZoom(1);
    setPanX(0);
    setPanY(0);
    zoomMode.current = "fit-frame";
  }, [frameIdx, video, labelingMode]);

  // Phase-2 keypoint pass: frame the current work item by zooming a
  // passZoomWindow-px window onto its centroid. Non-destructive (points stay in
  // source coords — this only moves the viewport), mirroring the fit-to-bbox
  // math above. Keyed on the ITEM (not the full cursor) so advancing node-by-
  // node within an instance keeps whatever zoom the user dialed in; it re-frames
  // only when the item changes or the window is resized. (Rotation isn't
  // compensated here, matching the other fit paths; AL projects run unrotated.)
  const passItemIdx = passCursor?.itemIdx ?? -1;
  useEffect(() => {
    if (!isKeypointPass || passItemIdx < 0) return;
    const item = passWorkList[passItemIdx];
    if (!item) return;
    const [cw, ch] = containerSize;
    if (cw === 0 || ch === 0) return;

    const win = passZoomWindow;
    // centroidXY is in SOURCE coords; the pan math below works in crop-local
    // image space, so map through the crop origin (identity when uncropped).
    const [centerX, centerY] = toImageCoords(video, item.centroidXY[0], item.centroidXY[1]);
    const newZoom = Math.min(cw / (win * baseScale), ch / (win * baseScale), 10);
    const newPanX = cw / 2 - offsetX - centerX * baseScale * newZoom;
    const newPanY = ch / 2 - offsetY - centerY * baseScale * newZoom;

    viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
    setZoom(newZoom);
    setPanX(newPanX);
    setPanY(newPanY);
    zoomMode.current = "free";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKeypointPass, passItemIdx, passZoomWindow, video, containerSize, baseScale, offsetX, offsetY]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle-click panning
      if (e.button === 1) {
        e.preventDefault();
        setIsPanning(true);
        setPanStart({ x: e.clientX - panX, y: e.clientY - panY });
        return;
      }

      if (e.button !== 0) return; // Only left-click for interaction

      // Cmd/Ctrl+pan-mode+left-click: zoom-drag mode
      if (shouldPan && (isCmdHeld || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        const anchorX = rect ? e.clientX - rect.left - offsetX : 0;
        const anchorY = rect ? e.clientY - rect.top - offsetY : 0;
        setIsZoomDragging(true);
        zoomDragStart.current = {
          clientX: e.clientX, clientY: e.clientY,
          zoom, panX, panY, anchorX, anchorY,
        };
        return;
      }

      const { x, y } = canvasToScene(e.clientX, e.clientY);

      // In pan mode, check for node hits first so nodes are still draggable
      if (shouldPan && !areaDeleteMode) {
        const instances = renderedInstancesRef.current;
        const nt = (markerSize * 2) / zoom;
        const hit = hitTestNode(instances, x, y, nt);
        if (hit && !instances[hit.instanceIdx]?.isPredicted) {
          // Node hit in pan mode — fall through to normal node drag handling below
        } else {
          e.preventDefault();
          setIsPanning(true);
          setPanStart({ x: e.clientX - panX, y: e.clientY - panY });
          return;
        }
      }

      // Area-delete mode: start drawing the delete rectangle
      if (areaDeleteMode) {
        e.preventDefault();
        setIsAreaDeleting(true);
        setAreaDeleteStart({ x, y });
        setAreaDeleteEnd({ x, y });
        return;
      }

      const currentInstance = useAppStore.getState().instance;
      shiftHeldOnMouseDown.current = e.shiftKey;

      const store = useAppStore.getState();

      // Centroid-seeding mode: every empty-space click drops a NEW one-node
      // instance (no existing selection required), so we return before the
      // node/instance hit-testing below. Each click is its own undo entry.
      if (store.labelingMode === "seed") {
        e.preventDefault();
        // Option/Alt-drag pans (Space advances frames in seed mode, and plain
        // left-click drops a centroid, so panning needs its own modifier —
        // also works on a trackpad with no middle button).
        if (e.altKey) {
          setIsPanning(true);
          setPanStart({ x: e.clientX - panX, y: e.clientY - panY });
          return;
        }
        const [sx, sy] = toSourceCoords(useAppStore.getState().video, x, y);
        commandContext.execute(SeedCentroid, { x: sx, y: sy });
        store.bumpOverlayVersion();
        return;
      }

      // Phase-2 keypoint-pass mode: left-click places the current pass's target
      // node on the current work-item instance, then advances the cursor. Each
      // placement is its own undo entry (BeginEdit snapshot). Space/pan-mode or
      // Alt-drag pans, so the user can reposition without leaving the mode.
      if (store.labelingMode === "keypointPass") {
        e.preventDefault();
        if (shouldPan || e.altKey) {
          setIsPanning(true);
          setPanStart({ x: e.clientX - panX, y: e.clientY - panY });
          return;
        }
        const cur = store.passCursor;
        const curItem = cur && store.labels ? store.passWorkList[cur.itemIdx] : undefined;
        if (!cur || !curItem || !store.labels) return;
        // The click's canvas→source mapping is only valid on the item's own
        // frame/video — if navigation drifted, snap back instead of placing.
        if (
          store.frameIdx !== curItem.frameIdx ||
          store.labels.videos[curItem.videoIdx] !== store.video
        ) {
          store.syncPassSelection();
          store.bumpOverlayVersion();
          return;
        }
        // Resolve the item's instance FRESH from the frame — never trust
        // store.instance, which an undo, InstancesPanel click, or select-next
        // can point elsewhere (index-based resolution survives undo's cloning).
        const lf = store.labels.find({ video: store.video!, frameIdx: curItem.frameIdx })[0];
        const nIdx = store.passNodeIndices[cur.passIdx]?.[cur.nodeIdx] ?? -1;
        let target = lf?.instances[curItem.instanceIdx] ?? null;
        if (!lf || !target || nIdx < 0 || nIdx >= target.points.length) return;
        commandContext.execute(BeginEdit);
        // A predicted centroid is adopted as a user instance IN PLACE (same
        // index) on first touch, so its keypoints count as ground truth and the
        // work item keeps resolving to it. Undo restores the prediction.
        if (target instanceof PredictedInstance) {
          const adopted = new Instance({
            skeleton: target.skeleton,
            points: clonePointsForAdopt(target.points),
            track: target.track,
          });
          lf.instances.splice(curItem.instanceIdx, 1, adopted);
          target = adopted;
        }
        store.setInstance(target);
        target.points[nIdx].xy = toSourceCoords(useAppStore.getState().video, x, y);
        target.points[nIdx].visible = true;
        target.points[nIdx].complete = true;
        store.markChanged();
        store.touchFrame();
        store.passAdvance();
        store.bumpOverlayVersion();
        return;
      }

      // Node placement mode: place the target node (with undo snapshot)
      if (store.labelingMode === "place" && currentInstance && !("score" in currentInstance)) {
        const targetIdx = store.placementNodeIdx;
        if (targetIdx !== null && targetIdx >= 0 && targetIdx < currentInstance.points.length) {
          commandContext.execute(BeginEdit);
          // Click is in crop-local image space; store back in source coords.
          currentInstance.points[targetIdx].xy = toSourceCoords(
            useAppStore.getState().video,
            x,
            y
          );
          currentInstance.points[targetIdx].visible = true;
          currentInstance.points[targetIdx].complete = true;
          store.markChanged();
          store.touchFrame();

          // Auto-advance to next unplaced node (search forward, then wrap)
          const pts = currentInstance.points;
          const count = pts.length;
          let nextUnplaced = -1;
          for (let offset = 1; offset < count; offset++) {
            const i = (targetIdx + offset) % count;
            if (isNaN(pts[i].xy[0]) || isNaN(pts[i].xy[1])) {
              nextUnplaced = i;
              break;
            }
          }
          if (nextUnplaced !== -1) {
            store.set("placementNodeIdx", nextUnplaced);
          } else {
            // All nodes placed — exit placement mode
            store.exitPlacementMode();
          }

          store.bumpOverlayVersion();
          return;
        }
      }

      const instances = renderedInstancesRef.current;
      const nodeThreshold = (markerSize * 2) / zoom;
      const instanceThreshold = 30 / zoom;

      // Try to hit a node first
      const nodeHit = hitTestNode(instances, x, y, nodeThreshold);
      if (nodeHit) {
        const key = makeNodeKey(nodeHit.instanceIdx, nodeHit.nodeIdx);
        const lf = useAppStore.getState().labeledFrame;

        if (e.shiftKey) {
          // Shift+click: toggle node in selection
          setSelectedNodes((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
          if (lf) useAppStore.getState().setInstance(lf.instances[nodeHit.instanceIdx]);
          return;
        }

        // No shift: check if node is already selected
        const alreadySelected = selectedNodes.has(key);
        if (!alreadySelected) {
          setSelectedNodes(new Set([key]));
        }

        if (lf) useAppStore.getState().setInstance(lf.instances[nodeHit.instanceIdx]);

        // Start dragging if it's a user instance
        const inst = instances[nodeHit.instanceIdx];
        if (!inst.isPredicted) {
          commandContext.execute(BeginEdit);
          setDragNodeInfo(nodeHit);
          setIsDragging(true);
          setInteractionMode("dragging");
          lastDragPos.current = { x, y };
          dragStartClient.current = { clientX: e.clientX, clientY: e.clientY };
        }
        return;
      }

      // Try to hit an instance (by centroid)
      const instHit = hitTestInstance(instances, x, y, instanceThreshold);
      if (instHit !== null) {
        const lf = useAppStore.getState().labeledFrame;
        if (lf) {
          useAppStore.getState().setInstance(lf.instances[instHit]);
          // Select all nodes in this instance
          const inst = instances[instHit];
          const keys = new Set<string>();
          inst.nodes.forEach((n, nIdx) => {
            if (n.visible) keys.add(makeNodeKey(instHit, nIdx));
          });
          if (e.shiftKey) {
            setSelectedNodes((prev) => new Set([...prev, ...keys]));
          } else {
            setSelectedNodes(keys);
          }
        }
        return;
      }

      // No hit: start marquee or deselect
      if (!e.shiftKey) {
        setSelectedNodes(new Set());
        useAppStore.getState().setInstance(null);
      }
      setInteractionMode("marquee");
      setMarqueeStart({ x, y });
      setMarqueeEnd({ x, y });
    },
    [canvasToScene, markerSize, panX, panY, zoom, shouldPan, isCmdHeld, offsetX, offsetY, selectedNodes, areaDeleteMode]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle zoom-drag (Cmd+Space+drag)
      if (isZoomDragging && zoomDragStart.current) {
        const start = zoomDragStart.current;
        const dx = e.clientX - start.clientX;
        const dy = e.clientY - start.clientY;
        // Drag right/down = zoom in, drag left/up = zoom out
        const dragDistance = dx - dy;
        const sensitivity = 0.005;
        const newZoom = Math.max(0.1, Math.min(50, start.zoom * Math.exp(dragDistance * sensitivity)));

        // Keep zoom centered on the initial click point
        const ratio = newZoom / start.zoom;
        const newPanX = start.anchorX - (start.anchorX - start.panX) * ratio;
        const newPanY = start.anchorY - (start.anchorY - start.panY) * ratio;

        viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
        setZoom(newZoom);
        setPanX(newPanX);
        setPanY(newPanY);
        return;
      }

      // Handle panning
      if (isPanning) {
        const rawPx = e.clientX - panStart.x;
        const rawPy = e.clientY - panStart.y;
        const constrained = constrainPan(rawPx, rawPy, zoom);
        viewRef.current.panX = constrained.x;
        viewRef.current.panY = constrained.y;
        setPanX(constrained.x);
        setPanY(constrained.y);
        return;
      }

      // Area-delete mode: update end point
      if (isAreaDeleting && areaDeleteStart) {
        const { x, y } = canvasToScene(e.clientX, e.clientY);
        setAreaDeleteEnd({ x, y });
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // Marquee mode: update end point
      if (interactionMode === "marquee") {
        const { x, y } = canvasToScene(e.clientX, e.clientY);
        setMarqueeEnd({ x, y });
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // Dragging mode: group drag selected nodes
      if (interactionMode === "dragging" && isDragging && dragNodeInfo) {
        const { x, y } = canvasToScene(e.clientX, e.clientY);
        const lf = useAppStore.getState().labeledFrame;
        if (!lf) return;

        const prev = lastDragPos.current;
        if (!prev) {
          lastDragPos.current = { x, y };
          return;
        }

        const dx = x - prev.x;
        const dy = y - prev.y;

        if (e.altKey && selectedNodes.size === 0) {
          // Alt+Drag with no selection: move entire instance
          const instance = lf.instances[dragNodeInfo.instanceIdx];
          if (instance) {
            for (const point of instance.points) {
              if (!isNaN(point.xy[0]) && !isNaN(point.xy[1])) {
                point.xy = [point.xy[0] + dx, point.xy[1] + dy];
              }
            }
          }
        } else if (selectedNodes.size > 1 || e.altKey) {
          // Group drag: move all selected nodes by delta
          for (const key of selectedNodes) {
            const { instanceIdx, nodeIdx } = parseNodeKey(key);
            const inst = lf.instances[instanceIdx];
            if (!inst) continue;
            const point = inst.points[nodeIdx];
            if (point && !isNaN(point.xy[0]) && !isNaN(point.xy[1])) {
              point.xy = [point.xy[0] + dx, point.xy[1] + dy];
            }
          }
        } else {
          // Single node drag
          const instance = lf.instances[dragNodeInfo.instanceIdx];
          const point = instance?.points[dragNodeInfo.nodeIdx];
          if (point) {
            // Drag position is crop-local; store back in source coords.
            point.xy = toSourceCoords(useAppStore.getState().video, x, y);
            point.visible = true;
          }
        }

        // Update hover tooltip — pin at drag-start position, not cursor
        setHoveredNode({
          instanceIdx: dragNodeInfo.instanceIdx,
          nodeIdx: dragNodeInfo.nodeIdx,
          clientX: dragStartClient.current?.clientX ?? e.clientX,
          clientY: dragStartClient.current?.clientY ?? e.clientY,
        });

        lastDragPos.current = { x, y };
        useAppStore.getState().markChanged();
        useAppStore.getState().touchFrame();
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // Idle mode: hover detection
      const { x, y } = canvasToScene(e.clientX, e.clientY);
      cursorScene.current = { x, y };

      // Bump overlay version to update inset on every move
      if (isPlacingNodes || isShiftHeld) {
        useAppStore.getState().bumpOverlayVersion();
      }

      const instances = renderedInstancesRef.current;
      const nodeThreshold = (markerSize * 2) / zoom;
      const hit = hitTestNode(instances, x, y, nodeThreshold);

      if (hit) {
        const prevIdx = hoveredNode?.instanceIdx;
        const prevNode = hoveredNode?.nodeIdx;
        setHoveredNode({
          instanceIdx: hit.instanceIdx,
          nodeIdx: hit.nodeIdx,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        if (prevIdx !== hit.instanceIdx || prevNode !== hit.nodeIdx) {
          useAppStore.getState().bumpOverlayVersion();
        }
      } else if (hoveredNode) {
        setHoveredNode(null);
        useAppStore.getState().bumpOverlayVersion();
      }
    },
    [isDragging, isPanning, isZoomDragging, dragNodeInfo, canvasToScene, panStart, constrainPan, zoom, interactionMode, selectedNodes, markerSize, hoveredNode, offsetX, offsetY, isPlacingNodes, isShiftHeld, isAreaDeleting, areaDeleteStart]
  );

  const handleMouseUp = useCallback(() => {
    // Area-delete mode: execute the delete command
    if (isAreaDeleting && areaDeleteStart && areaDeleteEnd) {
      // Require minimum drag distance (5px in scene coords) to avoid accidental deletes
      const dx = Math.abs(areaDeleteEnd.x - areaDeleteStart.x);
      const dy = Math.abs(areaDeleteEnd.y - areaDeleteStart.y);
      if (dx > 5 && dy > 5) {
        commandContext.execute(DeletePredictionsByArea, {
          x1: areaDeleteStart.x,
          y1: areaDeleteStart.y,
          x2: areaDeleteEnd.x,
          y2: areaDeleteEnd.y,
        });
      }
      setIsAreaDeleting(false);
      setAreaDeleteStart(null);
      setAreaDeleteEnd(null);
      useAppStore.getState().set("areaDeleteMode", false);
      useAppStore.getState().bumpOverlayVersion();
      return;
    }

    if (isZoomDragging) {
      setIsZoomDragging(false);
      zoomDragStart.current = null;
      return;
    }

    if (isPanning) {
      setIsPanning(false);
    }

    if (interactionMode === "marquee" && marqueeStart && marqueeEnd) {
      const instances = renderedInstancesRef.current;
      const newSelection = nodesInRect(instances, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y);
      if (shiftHeldOnMouseDown.current) {
        setSelectedNodes((prev) => new Set([...prev, ...newSelection]));
      } else {
        setSelectedNodes(newSelection);
      }
      setMarqueeStart(null);
      setMarqueeEnd(null);
      setInteractionMode("idle");
      useAppStore.getState().bumpOverlayVersion();
      return;
    }

    if (interactionMode === "dragging" || isDragging) {
      setIsDragging(false);
      setDragNodeInfo(null);
      lastDragPos.current = null;
      dragStartClient.current = null;
      setInteractionMode("idle");
    }
  }, [isDragging, isPanning, isZoomDragging, interactionMode, marqueeStart, marqueeEnd, isAreaDeleting, areaDeleteStart, areaDeleteEnd]);

  // Zoom with mouse wheel (towards pointer), Alt+Scroll for rotation
  // Use native event listener with { passive: false } so preventDefault() works
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Alt+Scroll: rotate selected instance
      if (e.altKey) {
        const currentInstance = useAppStore.getState().instance;
        if (currentInstance && !("score" in currentInstance)) {
          // Take undo snapshot on first rotation tick of a gesture
          if (!rotationSnapshotTaken.current) {
            commandContext.execute(BeginEdit);
            rotationSnapshotTaken.current = true;
          }

          const angle = (e.deltaY > 0 ? 5 : -5) * (Math.PI / 180); // 5 degrees per tick

          // Compute centroid
          const visible = currentInstance.points.filter(
            (p: { xy: number[] }) => !isNaN(p.xy[0]) && !isNaN(p.xy[1])
          );
          if (visible.length > 0) {
            const cx = visible.reduce((s: number, p: { xy: number[] }) => s + p.xy[0], 0) / visible.length;
            const cy = visible.reduce((s: number, p: { xy: number[] }) => s + p.xy[1], 0) / visible.length;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            for (const point of currentInstance.points) {
              if (isNaN(point.xy[0]) || isNaN(point.xy[1])) continue;
              const dx = point.xy[0] - cx;
              const dy = point.xy[1] - cy;
              point.xy = [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
            }

            useAppStore.getState().markChanged();
            useAppStore.getState().touchFrame();
            useAppStore.getState().bumpOverlayVersion();
          }
        }
        return;
      }

      // Reset rotation snapshot tracking when not using alt
      rotationSnapshotTaken.current = false;

      // Normalize deltaY for different input devices
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 40; // line mode
      delta = Math.max(-100, Math.min(100, delta)); // Clamp
      const zoomFactor = Math.exp(-delta * 0.004);

      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Read latest zoom/pan from ref (avoids stale closures with rapid events)
      const prev = viewRef.current;
      const newZoom = Math.max(0.1, Math.min(50, prev.zoom * zoomFactor));
      const ratio = newZoom / prev.zoom;

      // Zoom towards cursor: keep the scene point under the cursor fixed
      const anchorX = mx - offsetX;
      const anchorY = my - offsetY;
      const newPanX = anchorX - (anchorX - prev.panX) * ratio;
      const newPanY = anchorY - (anchorY - prev.panY) * ratio;

      // Eagerly update ref so next wheel event (before React commits) sees latest values
      viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };

      // Update state for rendering (no nested setState, no constrainPan interference)
      setZoom(newZoom);
      setPanX(newPanX);
      setPanY(newPanY);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [offsetX, offsetY]);

  // Double-click: convert predicted instance, or reset zoom/pan
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = canvasToScene(e.clientX, e.clientY);
      const instances = renderedInstancesRef.current;

      // Scale hit test thresholds by 1/zoom
      const nodeThreshold = (markerSize * 2) / zoom;
      const instanceThreshold = 30 / zoom;

      // Check if double-clicking on a node
      const nodeHit = hitTestNode(instances, x, y, nodeThreshold);
      if (nodeHit) {
        const inst = instances[nodeHit.instanceIdx];
        // Predicted: convert to user instance
        if (inst?.isPredicted) {
          commandContext.execute(ConvertPredictionToInstance, {
            instanceIdx: nodeHit.instanceIdx,
          });
          useAppStore.getState().bumpOverlayVersion();
          return;
        }
        // User instance: select all nodes in this instance. Honor THIS
        // instance's occluded-node flag (#2782) so double-select matches what
        // the canvas actually draws, not the global default.
        const keys = new Set<string>();
        inst.nodes.forEach((n, nIdx) => {
          if (n.visible || inst.showNonVisible) keys.add(makeNodeKey(nodeHit.instanceIdx, nIdx));
        });
        if (e.shiftKey) {
          setSelectedNodes((prev) => new Set([...prev, ...keys]));
        } else {
          setSelectedNodes(keys);
        }
        const lf = useAppStore.getState().labeledFrame;
        if (lf) useAppStore.getState().setInstance(lf.instances[nodeHit.instanceIdx]);
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // Check if double-clicking on a predicted instance (by centroid)
      const instHit = hitTestInstance(instances, x, y, instanceThreshold);
      if (instHit !== null && instances[instHit]?.isPredicted) {
        commandContext.execute(ConvertPredictionToInstance, {
          instanceIdx: instHit,
        });
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // No prediction hit - reset zoom/pan only in pan mode
      if (shouldPan) {
        viewRef.current = { zoom: 1, panX: 0, panY: 0 };
        setZoom(1);
        setPanX(0);
        setPanY(0);
      }
    },
    [canvasToScene, markerSize, zoom, shouldPan]
  );

  // Right-click context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const { x, y } = canvasToScene(e.clientX, e.clientY);
      const instances = renderedInstancesRef.current;

      // Phase-2 keypoint pass: right-click marks the current target node as not
      // visible (occluded → a real labeling decision) and advances. No menu.
      if (useAppStore.getState().labelingMode === "keypointPass") {
        const store = useAppStore.getState();
        const cur = store.passCursor;
        const curItem = cur && store.labels ? store.passWorkList[cur.itemIdx] : undefined;
        if (!cur || !curItem || !store.labels) return;
        if (
          store.frameIdx !== curItem.frameIdx ||
          store.labels.videos[curItem.videoIdx] !== store.video
        ) {
          store.syncPassSelection();
          store.bumpOverlayVersion();
          return;
        }
        // Resolve fresh from the frame (see the left-click path) — don't trust
        // store.instance.
        const lf = store.labels.find({ video: store.video!, frameIdx: curItem.frameIdx })[0];
        const nIdx = store.passNodeIndices[cur.passIdx]?.[cur.nodeIdx] ?? -1;
        let inst = lf?.instances[curItem.instanceIdx] ?? null;
        if (!lf || !inst || nIdx < 0 || nIdx >= inst.points.length) return;
        commandContext.execute(BeginEdit);
        // Same adopt-on-touch as left-click: marking a predicted centroid's node
        // occluded is a real labeling decision, so materialize it as user data.
        if (inst instanceof PredictedInstance) {
          const adopted = new Instance({
            skeleton: inst.skeleton,
            points: clonePointsForAdopt(inst.points),
            track: inst.track,
          });
          lf.instances.splice(curItem.instanceIdx, 1, adopted);
          inst = adopted;
        }
        store.setInstance(inst);
        inst.points[nIdx].visible = false;
        inst.points[nIdx].complete = true;
        store.markChanged();
        store.touchFrame();
        store.passAdvance();
        store.bumpOverlayVersion();
        return;
      }

      // Seeding mode: right-click removes the clicked seed (fix a misclick), or
      // undoes the last dropped centroid when clicking empty space. No menu.
      if (useAppStore.getState().labelingMode === "seed") {
        const seedNodeHit = hitTestNode(instances, x, y, markerSize * 2);
        const instIdx = seedNodeHit
          ? seedNodeHit.instanceIdx
          : hitTestInstance(instances, x, y);
        const lf = useAppStore.getState().labeledFrame;
        if (instIdx !== null && lf) {
          useAppStore.getState().setInstance(lf.instances[instIdx]);
          commandContext.execute(DeleteSelectedInstance);
        } else {
          commandContext.undo();
        }
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // Check if right-clicking on a node
      const nodeHit = hitTestNode(instances, x, y, markerSize * 2);
      if (nodeHit) {
        const lf = useAppStore.getState().labeledFrame;
        if (lf) {
          useAppStore.getState().setInstance(lf.instances[nodeHit.instanceIdx]);
        }
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          instanceIdx: nodeHit.instanceIdx,
          nodeIdx: nodeHit.nodeIdx,
        });
        return;
      }

      // Check if right-clicking on an instance
      const instHit = hitTestInstance(instances, x, y);
      if (instHit !== null) {
        const lf = useAppStore.getState().labeledFrame;
        if (lf) {
          useAppStore.getState().setInstance(lf.instances[instHit]);
        }
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          instanceIdx: instHit,
          nodeIdx: null,
        });
        return;
      }

      // Right-click on empty space
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        instanceIdx: null,
        nodeIdx: null,
      });
    },
    [canvasToScene, markerSize]
  );

  // Full-canvas crosshair while zoomed (View ▸ "Crosshair When Zoomed"). Only
  // meaningful zoomed in, where precise keypoint placement matters. Positioned by
  // writing CSS vars straight to the DOM on move — no per-move React re-render.
  const crosshairActive = showCrosshair && zoom > 1;

  const handleCrosshairMove = (e: React.MouseEvent) => {
    const el = crosshairRef.current;
    const cont = containerRef.current;
    if (!el || !cont) return;
    const rect = cont.getBoundingClientRect();
    el.style.setProperty("--cx", `${e.clientX - rect.left}px`);
    el.style.setProperty("--cy", `${e.clientY - rect.top}px`);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Canvas container */}
      <div
        ref={containerRef}
        className={cn(
          "flex-1 relative overflow-hidden bg-background min-h-0",
          isPanning ? "cursor-grabbing" : isZoomDragging ? "cursor-zoom-in" : (shouldPan && isCmdHeld) ? "cursor-zoom-in" : shouldPan ? "cursor-grab" : isDragging ? "cursor-grabbing" : areaDeleteMode ? "cursor-crosshair" : interactionMode === "marquee" ? "cursor-crosshair" : labelingMode === "seed" ? "cursor-cell" : isKeypointPass ? "cursor-cell" : isPlacingNodes ? "cursor-cell" : hoveredNode ? "cursor-pointer" : "cursor-default"
        )}
        onMouseMove={crosshairActive ? handleCrosshairMove : undefined}
        onMouseLeave={
          crosshairActive
            ? () => {
                const el = crosshairRef.current;
                el?.style.setProperty("--cx", "-9999px");
                el?.style.setProperty("--cy", "-9999px");
              }
            : undefined
        }
      >
        {/* Video frame layer */}
        <canvas
          ref={frameCanvasRef}
          className="absolute inset-0"
        />
        {/* Skeleton overlay layer */}
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { handleMouseUp(); setHoveredNode(null); cursorScene.current = null; }}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
        />


        {/* Zoomed inset during node drag */}
        <canvas
          ref={insetCanvasRef}
          className="absolute z-30 pointer-events-none rounded-lg border-2 border-white/30 shadow-lg"
          style={{ display: "none", width: INSET_SIZE, height: INSET_SIZE }}
        />

        {/* Full-canvas crosshair guide (screen-space, follows cursor). Lines are
            positioned via the --cx/--cy CSS vars written on mousemove; starts
            offscreen until the first move. */}
        {crosshairActive && (
          <div
            ref={crosshairRef}
            className="absolute inset-0 z-20 pointer-events-none"
            style={
              { "--cx": "-9999px", "--cy": "-9999px" } as React.CSSProperties
            }
          >
            <div
              className="absolute left-0 right-0 h-px bg-primary/70"
              style={{ top: "var(--cy)" }}
            />
            <div
              className="absolute top-0 bottom-0 w-px bg-primary/70"
              style={{ left: "var(--cx)" }}
            />
          </div>
        )}
        {/* Node hover tooltip */}
        {hoveredNode && labeledFrame && (() => {
          const lfInst = labeledFrame.instances[hoveredNode.instanceIdx];
          if (!lfInst) return null;
          const point = lfInst.points[hoveredNode.nodeIdx];
          if (!point) return null;
          const nodeName = lfInst.skeleton.nodes[hoveredNode.nodeIdx]?.name ?? `node_${hoveredNode.nodeIdx}`;
          const containerRect = containerRef.current?.getBoundingClientRect();
          if (!containerRect) return null;
          const tipX = hoveredNode.clientX - containerRect.left + 16;
          const tipY = hoveredNode.clientY - containerRect.top - 8;
          const nodeScore = point.score;
          const instScore = lfInst instanceof PredictedInstance ? lfInst.score : undefined;
          const isPredicted = lfInst instanceof PredictedInstance;
          const isDragActive = interactionMode === "dragging" && selectedNodes.size > 1;
          return (
            <div
              className="absolute pointer-events-none bg-black/80 text-white text-xs rounded shadow-lg px-2 py-1.5 z-20 leading-relaxed"
              style={{ left: tipX, top: tipY }}
            >
              <div className="font-medium">{nodeName}</div>
              <div className="text-white/70">
                x: {point.xy[0].toFixed(1)}, y: {point.xy[1].toFixed(1)}
              </div>
              <div className="text-white/50">
                {isPredicted ? "predicted" : "user"} · {point.visible ? "visible" : "not visible"}
              </div>
              {nodeScore !== undefined && (
                <div className="text-white/70">conf: {nodeScore.toFixed(3)}</div>
              )}
              {isDragActive && (
                <div className="text-blue-300 mt-0.5">moving {selectedNodes.size} nodes</div>
              )}
              {lfInst.track?.name && (
                <div className="text-white/50 mt-0.5">
                  {lfInst.track.name}
                  {instScore !== undefined && ` (${instScore.toFixed(2)})`}
                </div>
              )}
            </div>
          );
        })()}

        {/* Zoom-level overlay. The frame counter lives in the status bar only
            (was previously duplicated here and beside the seekbar). */}
        {zoom !== 1 && (
          <Badge
            variant="secondary"
            className="absolute bottom-2 left-2 pointer-events-none rounded-md bg-black/60 text-white/80 border-none"
          >
            {(zoom * 100).toFixed(0)}%
          </Badge>
        )}

        {/* Area-delete mode indicator */}
        {areaDeleteMode && (
          <Badge
            variant="destructive"
            className="absolute top-2 left-1/2 -translate-x-1/2 pointer-events-none rounded-md"
          >
            Delete Area: Draw a rectangle to delete predictions · Esc to cancel
          </Badge>
        )}

        {/* Node placement indicator */}
        {isPlacingNodes && selectedInstance && placementNodeIdx !== null && (
          <Badge
            variant="default"
            className="absolute top-2 left-1/2 -translate-x-1/2 pointer-events-none rounded-md"
          >
            Place: {
              selectedInstance.skeleton.nodes[placementNodeIdx]?.name ?? `node ${placementNodeIdx}`
            }
            {" "}[{placementNodeIdx + 1}/{selectedInstance.points.length}]
            {" "}({selectedInstance.points.filter((p) => !isNaN(p.xy[0])).length} placed)
            {" · Tab/Shift+Tab to cycle · Esc to exit"}
          </Badge>
        )}

        {/* Phase-2 keypoint-pass progress lives in the full-width KeypointPassBar
            (top of the video pane), not a floating badge. */}

        {/* Selection count indicator */}
        {selectedNodes.size > 0 && !isPlacingNodes && (
          <Badge
            variant="secondary"
            className="absolute bottom-2 right-2 pointer-events-none rounded-md bg-black/60 text-white/80 border-none"
          >
            {selectedNodes.size} node{selectedNodes.size !== 1 ? "s" : ""} selected
          </Badge>
        )}

        {/* Missing / unsupported-codec video placeholder */}
        {video && isVideoMissing(video) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <div className="flex flex-col items-center gap-3 pointer-events-auto max-w-md px-4 text-center">
              <Film className="h-12 w-12 text-muted-foreground/40" />
              {videoIssue(video) === "unsupported-codec" ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Unsupported video codec
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    {video.backendError?.message
                      ? `${video.backendError.message}. `
                      : ""}
                    This codec (e.g. 10-bit HEVC) can&apos;t be decoded here.
                    Transcode to H.264, e.g.{" "}
                    <code className="rounded bg-muted px-1 py-0.5">
                      ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p out.mp4
                    </code>
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Video file not found
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const ok = await resolveVideoFile(video, labels ?? undefined);
                  // Re-render either way: on success to show the video, on
                  // failure so a newly recorded backendError (e.g. unsupported
                  // codec) updates this placeholder's message.
                  useAppStore.getState().bumpOverlayVersion();
                  if (ok) {
                    useAppStore.getState().setFrameIdx(frameIdx);
                  }
                }}
              >
                Locate Video
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Seekbar */}
      <Seekbar />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          instanceIdx={contextMenu.instanceIdx}
          nodeIdx={contextMenu.nodeIdx}
          selectedNodes={selectedNodes}
          onToggleSelectedNodesVisibility={() => {
            const lf = useAppStore.getState().labeledFrame;
            if (!lf) return;
            commandContext.execute(BeginEdit);
            // Determine majority visibility to decide toggle direction
            let visibleCount = 0;
            for (const key of selectedNodes) {
              const { instanceIdx, nodeIdx } = parseNodeKey(key);
              const point = lf.instances[instanceIdx]?.points[nodeIdx];
              if (point?.visible) visibleCount++;
            }
            const makeVisible = visibleCount <= selectedNodes.size / 2;
            for (const key of selectedNodes) {
              const { instanceIdx, nodeIdx } = parseNodeKey(key);
              const point = lf.instances[instanceIdx]?.points[nodeIdx];
              if (point) point.visible = makeVisible;
            }
            useAppStore.getState().markChanged();
            useAppStore.getState().touchFrame();
            useAppStore.getState().bumpOverlayVersion();
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
