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

import { useRef, useEffect, useCallback, useState } from "react";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { debugFlags } from "../panels/DebugPanel";
import { Seekbar } from "./Seekbar";
import { ContextMenu } from "./ContextMenu";
import {
  renderInstances,
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
import { getPaletteColor, getInstanceColor, rgbToCSS } from "../../lib/colorPalettes";
import { COLORMAPS } from "../../lib/colormaps";
import { renderTrails } from "../../canvas/TrailRenderer";
import {
  commandContext,
  ConvertPredictionToInstance,
  BeginEdit,
} from "../../commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isVideoMissing, resolveVideoFile } from "../../lib/resolveVideos";
import { Film } from "lucide-react";

export function VideoPlayer() {
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const insetCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // State from store
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const labels = useAppStore((s) => s.labels);
  const selectedInstance = useAppStore((s) => s.instance);
  const showInstances = useAppStore((s) => s.showInstances);
  const showLabels = useAppStore((s) => s.showLabels);
  const showEdges = useAppStore((s) => s.showEdges);
  const showNonVisibleNodes = useAppStore((s) => s.showNonVisibleNodes);
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
  const colormap = useAppStore((s) => s.colormap);
  const rotation = useAppStore((s) => s.rotation);
  const defaultToPan = useAppStore((s) => s.defaultToPan);

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
  const frameBitmapRef = useRef<ImageBitmap | null>(null);

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
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpaceHeld(false);
      }
      if (e.key === "Meta" || e.key === "Control") {
        setIsCmdHeld(false);
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
        useAppStore.getState().bumpOverlayVersion();
      } else if (hoveredNode) {
        // Toggle hovered node
        e.preventDefault();
        commandContext.execute(BeginEdit);
        const point = lf.instances[hoveredNode.instanceIdx]?.points[hoveredNode.nodeIdx];
        if (point) {
          point.visible = !point.visible;
          useAppStore.getState().markChanged();
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
    if (!video || !video.backend) return;

    let cancelled = false;
    const t0 = performance.now();
    if (debugFlags.logSeeking) console.debug(`[seek] requesting frame ${frameIdx}`);

    (async () => {
      try {
        const frame = await video.backend!.getFrame(frameIdx);
        if (debugFlags.logSeeking) console.debug(`[seek] getFrame(${frameIdx}) returned ${frame?.constructor?.name ?? "null"} in ${(performance.now() - t0).toFixed(1)}ms`);
        if (cancelled || !frame) {
          if (debugFlags.logSeeking && cancelled) console.debug(`[seek] frame ${frameIdx} cancelled`);
          return;
        }

        let bmp: ImageBitmap;

        if (frame instanceof ImageBitmap) {
          // Clone so we don't close the backend's cached copy
          bmp = await createImageBitmap(frame);
        } else if (frame instanceof ImageData) {
          bmp = await createImageBitmap(frame);
        } else if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
          const bytes =
            frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
          const shape = video.shape;
          if (!shape) return;
          const [, h, w] = shape;
          const imageData = new ImageData(new Uint8ClampedArray(bytes), w, h);
          bmp = await createImageBitmap(imageData);
        } else {
          return;
        }

        if (cancelled) {
          bmp.close();
          if (debugFlags.logSeeking) console.debug(`[seek] frame ${frameIdx} cancelled after decode`);
          return;
        }

        // Compute histogram from raw frame pixels
        {
          const offscreen = new OffscreenCanvas(bmp.width, bmp.height);
          const offCtx = offscreen.getContext("2d");
          if (offCtx) {
            offCtx.drawImage(bmp, 0, 0);
            const imgData = offCtx.getImageData(0, 0, bmp.width, bmp.height);
            const hist = new Uint32Array(256);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
              hist[d[i + 1]]++;
            }
            useAppStore.getState().set("frameHistogram", hist);
          }
        }

        // Close previous bitmap
        frameBitmapRef.current?.close();
        frameBitmapRef.current = bmp;
        setFrameDims((prev) => (prev[0] === bmp.width && prev[1] === bmp.height ? prev : [bmp.width, bmp.height]));
        setBitmapVersion((v) => v + 1);
        if (debugFlags.logSeeking) console.debug(`[seek] frame ${frameIdx} rendered (${bmp.width}x${bmp.height}) total ${(performance.now() - t0).toFixed(1)}ms`);
      } catch (err) {
        console.error("Failed to render frame:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [video, frameIdx, overlayVersion]);

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
      const needsLUT = lutMin > 0 || lutMax < 255;
      const cmapLUT = COLORMAPS[colormap] ?? null;
      if (needsLUT || cmapLUT) {
        const offscreen = new OffscreenCanvas(bmp.width, bmp.height);
        const offCtx = offscreen.getContext("2d")!;
        offCtx.drawImage(bmp, 0, 0);
        const imgData = offCtx.getImageData(0, 0, bmp.width, bmp.height);
        const d = imgData.data;
        const range = lutMax - lutMin || 1;
        for (let i = 0; i < d.length; i += 4) {
          let r = d[i], g = d[i + 1], b = d[i + 2];
          if (needsLUT) {
            r = Math.max(0, Math.min(255, ((r - lutMin) / range) * 255));
            g = Math.max(0, Math.min(255, ((g - lutMin) / range) * 255));
            b = Math.max(0, Math.min(255, ((b - lutMin) / range) * 255));
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
  }, [frameDims, containerSize, zoom, panX, panY, baseScale, offsetX, offsetY, bitmapVersion, lutMin, lutMax, colormap, rotation]);

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

        const nodes: RenderedNode[] = inst.points.map((point, nIdx) => ({
          x: point.xy[0],
          y: point.xy[1],
          visible: point.visible && !isNaN(point.xy[0]),
          complete: point.complete,
          name: skeleton.nodes[nIdx]?.name ?? `node_${nIdx}`,
          score: point.score,
        }));

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

    // Compute effective selection (includes live marquee preview)
    let effectiveSelection = selectedNodes;
    if (marqueeStart && marqueeEnd) {
      const marqueeHits = nodesInRect(instances, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y, showNonVisibleNodes);
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

    ctx.restore();
  }, [
    labeledFrame,
    selectedInstance,
    showInstances,
    showLabels,
    showEdges,
    showNonVisibleNodes,
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
    labels,
    video,
    frameIdx,
    rotation,
  ]);

  // Render zoomed inset during node drag
  const INSET_SIZE = 200;
  const INSET_ZOOM = 4;
  useEffect(() => {
    const inset = insetCanvasRef.current;
    if (!inset) return;

    const hideInset = () => {
      inset.style.display = "none";
      inset.style.left = "";
      inset.style.top = "";
      inset.style.right = "";
    };

    if (interactionMode !== "dragging" || !dragNodeInfo) {
      hideInset();
      return;
    }

    const bmp = frameBitmapRef.current;
    if (!bmp) {
      hideInset();
      return;
    }

    const instances = renderedInstancesRef.current;
    const inst = instances[dragNodeInfo.instanceIdx];
    const node = inst?.nodes[dragNodeInfo.nodeIdx];
    if (!inst || !node) {
      hideInset();
      return;
    }

    inset.style.display = "block";

    // Position inset near the pinned tooltip at drag-start position
    const container = containerRef.current;
    if (container && dragStartClient.current) {
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

      // Flip above tooltip if it would overflow bottom
      if (insetTop + INSET_SIZE > containerRect.height) {
        insetTop = tipTop - INSET_SIZE - GAP;
      }

      // Clamp to container bounds
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

    // Draw magnified frame region centered on the dragged node
    const srcSize = INSET_SIZE / INSET_ZOOM;
    const sx = node.x - srcSize / 2;
    const sy = node.y - srcSize / 2;

    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(bmp, sx, sy, srcSize, srcSize, 0, 0, INSET_SIZE, INSET_SIZE);
    } catch {
      // Bitmap may be closed
    }

    // Draw nearby edges from this instance
    const toInset = (px: number, py: number) => ({
      ix: (px - sx) * INSET_ZOOM,
      iy: (py - sy) * INSET_ZOOM,
    });

    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    for (const edge of inst.edges) {
      const src = inst.nodes[edge.srcIdx];
      const dst = inst.nodes[edge.dstIdx];
      if (!src?.visible || !dst?.visible) continue;
      const s = toInset(src.x, src.y);
      const d = toInset(dst.x, dst.y);
      const edgeColor = inst.edgeColors
        ? inst.edgeColors[inst.edges.indexOf(edge)]
        : inst.color;
      ctx.strokeStyle = rgbToCSS(edgeColor);
      ctx.beginPath();
      ctx.moveTo(s.ix, s.iy);
      ctx.lineTo(d.ix, d.iy);
      ctx.stroke();
    }

    // Draw other visible nodes as small dots
    ctx.globalAlpha = 0.6;
    for (let nIdx = 0; nIdx < inst.nodes.length; nIdx++) {
      if (nIdx === dragNodeInfo.nodeIdx) continue;
      const n = inst.nodes[nIdx];
      if (!n.visible) continue;
      const { ix, iy } = toInset(n.x, n.y);
      if (ix < -10 || ix > INSET_SIZE + 10 || iy < -10 || iy > INSET_SIZE + 10) continue;
      const nodeColor = inst.nodeColors ? inst.nodeColors[nIdx] : inst.color;
      ctx.fillStyle = rgbToCSS(nodeColor);
      ctx.beginPath();
      ctx.arc(ix, iy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw crosshair at center (dragged node position)
    const cx = INSET_SIZE / 2;
    const cy = INSET_SIZE / 2;
    const armLen = 12;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - armLen, cy);
    ctx.lineTo(cx - 4, cy);
    ctx.moveTo(cx + 4, cy);
    ctx.lineTo(cx + armLen, cy);
    ctx.moveTo(cx, cy - armLen);
    ctx.lineTo(cx, cy - 4);
    ctx.moveTo(cx, cy + 4);
    ctx.lineTo(cx, cy + armLen);
    ctx.stroke();

    ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - armLen, cy);
    ctx.lineTo(cx - 4, cy);
    ctx.moveTo(cx + 4, cy);
    ctx.lineTo(cx + armLen, cy);
    ctx.moveTo(cx, cy - armLen);
    ctx.lineTo(cx, cy - 4);
    ctx.moveTo(cx, cy + 4);
    ctx.lineTo(cx, cy + armLen);
    ctx.stroke();
  }, [interactionMode, dragNodeInfo, overlayVersion, bitmapVersion]);

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

  // Check if we're in explicit placement mode
  const labelingMode = useAppStore((s) => s.labelingMode);
  const placementNodeIdx = useAppStore((s) => s.placementNodeIdx);
  const isPlacingNodes = labelingMode === "place" && selectedInstance !== null;

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

      // Pan mode (default or space-toggled): left-click panning
      if (shouldPan) {
        e.preventDefault();
        setIsPanning(true);
        setPanStart({ x: e.clientX - panX, y: e.clientY - panY });
        return;
      }

      const { x, y } = canvasToScene(e.clientX, e.clientY);
      const currentInstance = useAppStore.getState().instance;
      shiftHeldOnMouseDown.current = e.shiftKey;

      // Node placement mode: place the target node (with undo snapshot)
      const store = useAppStore.getState();
      if (store.labelingMode === "place" && currentInstance && !("score" in currentInstance)) {
        const targetIdx = store.placementNodeIdx;
        if (targetIdx !== null && targetIdx >= 0 && targetIdx < currentInstance.points.length) {
          commandContext.execute(BeginEdit);
          currentInstance.points[targetIdx].xy = [x, y];
          currentInstance.points[targetIdx].visible = true;
          currentInstance.points[targetIdx].complete = true;
          store.markChanged();

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
      const nodeHit = hitTestNode(instances, x, y, nodeThreshold, showNonVisibleNodes);
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
    [canvasToScene, markerSize, panX, panY, zoom, shouldPan, isCmdHeld, offsetX, offsetY, selectedNodes, showNonVisibleNodes]
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
            point.xy = [x, y];
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
        useAppStore.getState().bumpOverlayVersion();
        return;
      }

      // Idle mode: hover detection
      const { x, y } = canvasToScene(e.clientX, e.clientY);
      const instances = renderedInstancesRef.current;
      const nodeThreshold = (markerSize * 2) / zoom;
      const hit = hitTestNode(instances, x, y, nodeThreshold, showNonVisibleNodes);

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
    [isDragging, isPanning, isZoomDragging, dragNodeInfo, canvasToScene, panStart, constrainPan, zoom, interactionMode, selectedNodes, markerSize, hoveredNode, showNonVisibleNodes, offsetX, offsetY]
  );

  const handleMouseUp = useCallback(() => {
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
      const newSelection = nodesInRect(instances, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y, showNonVisibleNodes);
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
  }, [isDragging, isPanning, isZoomDragging, interactionMode, marqueeStart, marqueeEnd]);

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
      const nodeHit = hitTestNode(instances, x, y, nodeThreshold, showNonVisibleNodes);
      if (nodeHit) {
        const inst = instances[nodeHit.instanceIdx];
        // Predicted: convert to user instance
        if (inst?.isPredicted) {
          commandContext.execute(ConvertPredictionToInstance, {
            instanceIdx: nodeHit.instanceIdx,
          });
          return;
        }
        // User instance: select all nodes in this instance
        const keys = new Set<string>();
        inst.nodes.forEach((n, nIdx) => {
          if (n.visible || showNonVisibleNodes) keys.add(makeNodeKey(nodeHit.instanceIdx, nIdx));
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

      // Check if right-clicking on a node
      const nodeHit = hitTestNode(instances, x, y, markerSize * 2, showNonVisibleNodes);
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
    [canvasToScene, markerSize, showNonVisibleNodes]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Canvas container */}
      <div
        ref={containerRef}
        className={cn(
          "flex-1 relative overflow-hidden bg-background min-h-0",
          isPanning ? "cursor-grabbing" : isZoomDragging ? "cursor-zoom-in" : (shouldPan && isCmdHeld) ? "cursor-zoom-in" : shouldPan ? "cursor-grab" : isDragging ? "cursor-grabbing" : interactionMode === "marquee" ? "cursor-crosshair" : isPlacingNodes ? "cursor-cell" : hoveredNode ? "cursor-pointer" : "cursor-default"
        )}
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
          onMouseLeave={() => { handleMouseUp(); setHoveredNode(null); }}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
        />


        {/* Zoomed inset during node drag */}
        <canvas
          ref={insetCanvasRef}
          className="absolute z-30 pointer-events-none rounded-lg border-2 border-white/30 shadow-lg"
          style={{ display: "none", width: INSET_SIZE, height: INSET_SIZE }}
        />
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

        {/* Frame info overlay */}
        <Badge
          variant="secondary"
          className="absolute bottom-2 left-2 pointer-events-none rounded-md bg-black/60 text-white/80 border-none"
        >
          Frame {frameIdx}
          {video?.shape && ` / ${video.shape[0] - 1}`}
          {zoom !== 1 && ` | ${(zoom * 100).toFixed(0)}%`}
        </Badge>

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

        {/* Selection count indicator */}
        {selectedNodes.size > 0 && !isPlacingNodes && (
          <Badge
            variant="secondary"
            className="absolute bottom-2 right-2 pointer-events-none rounded-md bg-black/60 text-white/80 border-none"
          >
            {selectedNodes.size} node{selectedNodes.size !== 1 ? "s" : ""} selected
          </Badge>
        )}

        {/* Missing video placeholder */}
        {video && isVideoMissing(video) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <div className="flex flex-col items-center gap-3 pointer-events-auto">
              <Film className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Video file not found</p>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const ok = await resolveVideoFile(video);
                  if (ok) {
                    useAppStore.getState().bumpOverlayVersion();
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
            useAppStore.getState().bumpOverlayVersion();
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
