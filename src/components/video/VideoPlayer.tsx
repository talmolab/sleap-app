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
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { debugFlags } from "../panels/DebugPanel";
import { Seekbar } from "./Seekbar";
import { ContextMenu } from "./ContextMenu";
import { SkeletonBuildBar } from "./SkeletonBuildBar";
import { AnchorPickBar } from "./AnchorPickBar";
import {
  renderInstances,
  hitTestNode,
  hitTestInstance,
  renderSelectedNodeHighlights,
  renderHoveredNodeHighlight,
  renderHoverInstanceBBox,
  renderAnchorCropPreview,
  instanceBBoxCropSize,
  findNodeIdxByName,
  renderMarqueeRect,
  renderRoiRect,
  nodesInRect,
  makeNodeKey,
  parseNodeKey,
  COMPLETE_COLOR,
  INCOMPLETE_COLOR,
  UNCOLORED_PREDICTED_NODE_COLOR,
  type RenderedInstance,
  type RenderedNode,
} from "../../canvas/SkeletonRenderer";
import { instanceVisible, instanceShowsNonVisible } from "@/lib/instanceVisibility";
import { formatShortcut } from "@/lib/formatShortcut";
import { useQcVisibility } from "@/hooks/useQcVisibility";
import {
  getPaletteColor,
  getInstanceColor,
  rgbToCSS,
  hasAssignedTracks,
  resolveColorTarget,
} from "../../lib/colorPalettes";
import { COLORMAPS } from "../../lib/colormaps";
import { renderTrails } from "../../canvas/TrailRenderer";
import {
  commandContext,
  ConvertPredictionToInstance,
  BeginEdit,
  DeletePredictionsByArea,
  DuplicateInstance,
  AddNodeCommand,
  AddEdgeCommand,
  RenameNodeCommand,
} from "../../commands";
import {
  buildBuilderRenderedInstance,
  renderPenStroke,
} from "@/canvas/skeletonBuilderRender";
import { nodesCrossedBySegment } from "@/lib/skeletonPenChain";
import { isValidEdgeSelection } from "@/lib/skeletonEdgeEditing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toImageCoords, toSourceCoords } from "@/lib/cropTransform";
import { shouldPrefetch } from "@/lib/videoPrefetch";
import { expandFrameBytesToRGBA, inferFrameChannels } from "@/lib/videoExport";
import {
  isVideoMissing,
  resolveVideoFile,
  videoIssue,
  ensureVideoBackend,
  relocateMissingImageFrames,
} from "../../lib/resolveVideos";
import { toast } from "@/lib/notify";
import { hintIfPredictionsRemain, hintIfFirstNodeConfirm } from "@/lib/labelingHints";
import { setLabelsAutosaveInteracting } from "@/lib/labelsAutosave";
import { spacePanState } from "@/lib/spacePanTracking";
import { getPlatform, isTauri } from "@/platform/index";
import { Film, Frame, Hand, ImageOff, MousePointer2, Tag } from "lucide-react";

/**
 * First unused `node_${k}` name (k = 0, 1, 2, …) for a fresh builder node, so
 * placing nodes on a blank skeleton yields node_0, node_1, … without collisions.
 *
 * Exported for testing: the number restarts at `node_0` iff the passed node list
 * is empty, so it doubles as a regression check that a delete-and-restart truly
 * hands the builder an emptied `skeleton.nodes`.
 */
export function nextBuilderNodeName(nodes: { name: string }[]): string {
  const names = new Set(nodes.map((n) => n.name));
  let k = 0;
  while (names.has(`node_${k}`)) k++;
  return `node_${k}`;
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
  const showTrackScore = useAppStore((s) => s.showTrackScore);
  const fit = useAppStore((s) => s.fit);
  const edgeStyle = useAppStore((s) => s.edgeStyle);
  const markerSize = useAppStore((s) => s.markerSize);
  const nodeLabelSize = useAppStore((s) => s.nodeLabelSize);
  const palette = useAppStore((s) => s.palette);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const editSeq = useAppStore((s) => s.editSeq);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  // Live "auto" color-mode input: recomputed whenever a new project loads
  // (labels identity change) or any edit lands (editSeq bump, e.g. a track
  // gets assigned/unassigned) — see resolveColorTarget().
  const projectHasTracks = useMemo(
    () => hasAssignedTracks(labels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, editSeq]
  );
  const trailLength = useAppStore((s) => s.trailLength);
  const lutMin = useAppStore((s) => s.lutMin);
  const lutMax = useAppStore((s) => s.lutMax);
  const colormap = useAppStore((s) => s.colormap);
  const rotation = useAppStore((s) => s.rotation);
  const defaultToPan = useAppStore((s) => s.defaultToPan);
  const fitSelection = useAppStore((s) => s.fitSelection);
  const resetViewNonce = useAppStore((s) => s.resetViewNonce);
  const areaDeleteMode = useAppStore((s) => s.areaDeleteMode);
  const showCrosshair = useAppStore((s) => s.showCrosshair);
  // Image-features ROI crop tool (shared with the Suggestions panel).
  const imageFeatureRoiDrawActive = useAppStore((s) => s.imageFeatureRoiDrawActive);
  const setImageFeatureRoi = useAppStore((s) => s.setImageFeatureRoi);
  const imageFeatureRois = useAppStore((s) => s.imageFeatureRois);
  // Visual skeleton builder (2-stage place/connect). Every branch that reads
  // these is guarded by `skeletonBuildMode`, so normal interactions are
  // byte-identical when the builder is off.
  const skeleton = useAppStore((s) => s.skeleton);
  const skeletonBuildMode = useAppStore((s) => s.skeletonBuildMode);
  const skeletonBuildStage = useAppStore((s) => s.skeletonBuildStage);
  const builderPositions = useAppStore((s) => s.builderPositions);
  // Top-down anchor-part picker (Training panel): click a node to select it.
  const pickingAnchor = useAppStore((s) => s.pickingAnchor);
  // Persistent anchor crop preview (Training panel "Preview" toggle) — shown
  // independently of pick mode/hover, for every instance on the current frame.
  const anchorPreviewActive = useAppStore((s) => s.anchorPreviewActive);
  const anchorPreviewNode = useAppStore((s) => s.anchorPreviewNode);

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
  const [interactionMode, setInteractionMode] = useState<"idle" | "marquee" | "dragging" | "roi">("idle");
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
  const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(null);
  // Image-features ROI rubber-band (image-pixel coords; live only while drawing).
  const [roiStart, setRoiStart] = useState<{ x: number; y: number } | null>(null);
  const [roiEnd, setRoiEnd] = useState<{ x: number; y: number } | null>(null);
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
  /**
   * Hovering an instance's body (near its centroid) without landing precisely
   * on one of its nodes (#346) — a lighter-weight sibling to `hoveredNode`'s
   * detailed per-node tooltip. Only tracked when `hoveredNode` is null; the
   * caption it drives ("User Instance" / "Predicted Instance") would be
   * redundant with the "predicted"/"user" line already in that tooltip.
   */
  const [hoveredInstanceIdx, setHoveredInstanceIdx] = useState<{
    idx: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const shiftHeldOnMouseDown = useRef(false);

  // Skeleton builder (place stage): inline rename overlay for a double-clicked
  // node. Scene coords (not client) so the input tracks the node across pan/zoom.
  const [renamingNode, setRenamingNode] = useState<{
    nodeIdx: number;
    x: number;
    y: number;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingNode) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
    // Only refocus/reselect when the node being renamed changes, not on
    // every keystroke (renameValue) or pan/zoom (renamingNode.x/y).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingNode?.nodeIdx]);

  const commitNodeRename = useCallback(() => {
    if (!renamingNode || !skeleton) {
      setRenamingNode(null);
      return;
    }
    const trimmed = renameValue.trim();
    const current = skeleton.nodes[renamingNode.nodeIdx]?.name ?? "";
    const isDuplicate = skeleton.nodes.some(
      (n, i) => n.name === trimmed && i !== renamingNode.nodeIdx
    );
    if (trimmed && !isDuplicate && trimmed !== current) {
      commandContext.execute(RenameNodeCommand, {
        nodeIdx: renamingNode.nodeIdx,
        newName: trimmed,
      });
      // Repaint so the renamed label shows immediately (RenameNode does not
      // bump overlayVersion itself, unlike AddNode/AddEdge).
      useAppStore.getState().bumpOverlayVersion();
    }
    setRenamingNode(null);
  }, [renamingNode, renameValue, skeleton]);

  const cancelNodeRename = useCallback(() => {
    setRenamingNode(null);
  }, []);

  // Track the last scene position during drag for delta calculations (alt-drag)
  const lastDragPos = useRef<{ x: number; y: number } | null>(null);

  // Skeleton-builder transient gesture state (refs so mid-gesture updates don't
  // churn React; redraws are triggered via bumpOverlayVersion).
  const builderDragIdxRef = useRef<number | null>(null); // node being repositioned (place)
  const penStrokeRef = useRef<{ x: number; y: number }[]>([]); // live connect pen path
  const penLastRef = useRef<number | null>(null); // last node the pen touched
  const penActiveRef = useRef<boolean>(false); // a pen stroke is in progress
  const builderHoverIdxRef = useRef<number | null>(null); // builder node under cursor

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
  // The current frame's image couldn't be read (resolved backend, but this one
  // frame's file is missing/unreadable). Drives a non-blocking per-frame
  // placeholder; distinct from a wholly-missing video (see isVideoMissing).
  const [frameImageMissing, setFrameImageMissing] = useState(false);
  // Frame indices whose image failed to read for the CURRENT video, accumulated
  // as the user navigates. "Locate Image…" relocates exactly these against a
  // picked folder — never re-probing the frames that already resolved. Reset
  // whenever the video changes.
  const missingFramesRef = useRef<Set<number>>(new Set());
  const [relocating, setRelocating] = useState(false);
  // Bumped to force the current frame to re-read after a relocation (frameIdx is
  // unchanged, so the read effect wouldn't otherwise re-run).
  const [readNonce, setReadNonce] = useState(0);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    /** Scene/frame coordinates of the click, for "Add Instance" placement. */
    sceneLocation: [number, number];
    instanceIdx: number | null;
    nodeIdx: number | null;
  } | null>(null);

  // Rendered instances cache
  const renderedInstancesRef = useRef<RenderedInstance[]>([]);

  // Store frame as ImageBitmap so we can re-draw with transforms
  const frameBitmapRef = useRef<OffscreenCanvas | null>(null);

  // Previous requested frame index, so the load effect can measure the jump
  // distance and disable read-ahead prefetch on large discrete jumps (which
  // otherwise fire wasted 8-ahead/2-behind reads on a slow mount). null until
  // the first frame is requested. `lastVideoRef` lets us reset it on a video
  // switch so the new video's first frame counts as a fresh first-load.
  const prevFrameIdxRef = useRef<number | null>(null);
  const lastVideoRef = useRef<typeof video>(null);

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

        // Fresh press (not the double-tap case above): reset the drag flag so
        // the pending Space-release suggestion-jump (useKeyboardShortcuts.ts)
        // starts this hold with a clean slate.
        spacePanState.draggedWhileHeld = false;
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

  // The in-progress builder skeleton as a RenderedInstance, reusing the same
  // machinery as real instances for draw + hit-test. `overlayVersion` is a dep
  // because AddNode/AddEdge mutate skeleton.nodes/edges in place (same object
  // identity) and bump it — so the memo recomputes after those edits.
  const builderRI = useMemo(
    () =>
      skeletonBuildMode && skeleton
        ? buildBuilderRenderedInstance(skeleton, builderPositions)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skeletonBuildMode, skeleton, builderPositions, overlayVersion]
  );

  // Keep the store's `visibleSceneRect` in sync with the current viewport, in
  // frame/scene pixel coordinates -- the JS port of PyQt's
  // `QtVideoPlayer.getVisibleRect()`. Transforms the canvas's four corners
  // with the same inverse pan/zoom/rotation math as `canvasToScene` (defined
  // below) and takes their axis-aligned bounding box. `AddInstance`'s random
  // placement reads this so a new instance lands within view.
  useEffect(() => {
    if (cw <= 0 || ch <= 0 || fw <= 0 || fh <= 0) {
      useAppStore.getState().set("visibleSceneRect", null);
      return;
    }
    const toScene = (cx: number, cy: number): [number, number] => {
      let sx = (cx - offsetX - panX) / (baseScale * zoom);
      let sy = (cy - offsetY - panY) / (baseScale * zoom);
      if (rotation === 90) {
        const fx = sy, fy = fh - sx;
        sx = fx; sy = fy;
      } else if (rotation === 180) {
        sx = fw - sx; sy = fh - sy;
      } else if (rotation === 270) {
        const fx = fw - sy, fy = sx;
        sx = fx; sy = fy;
      }
      return [sx, sy];
    };
    const corners = [toScene(0, 0), toScene(cw, 0), toScene(0, ch), toScene(cw, ch)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    useAppStore.getState().set("visibleSceneRect", [
      Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
    ]);
  }, [cw, ch, fw, fh, baseScale, offsetX, offsetY, panX, panY, zoom, rotation]);

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

    // A video switch starts a fresh sequential-viewing session: drop the stale
    // previous index so this first frame is a first-load (prefetch ON), not a
    // giant jump measured against the old video's frame index.
    if (lastVideoRef.current !== video) {
      lastVideoRef.current = video;
      prevFrameIdxRef.current = null;
      // New video: forget the previous one's per-frame "missing" indices.
      missingFramesRef.current = new Set();
    }

    // Read-ahead prefetch decision (see shouldPrefetch): ON for sequential
    // stepping/playback (jump within a couple of frames), OFF for a scrub or a
    // large discrete jump (Next/Prev Suggestion, Next/Prev Labeled Frame,
    // Go-to-frame) whose read-ahead frames are never viewed. Record this
    // request as the baseline for the next one's jump-distance measurement.
    const prevFrameIdx = prevFrameIdxRef.current;
    prevFrameIdxRef.current = frameIdx;
    const prefetch = shouldPrefetch({
      prev: prevFrameIdx,
      next: frameIdx,
      isScrubbing: useAppStore.getState().isScrubbing,
    });

    (async () => {
      try {
        // Fresh read: clear any prior per-frame "image missing" flag; the catch
        // below re-raises it if this frame's image can't be read.
        setFrameImageMissing(false);
        // Lazy video backends: the decoder is deferred at load (open one video,
        // not all N). Open it on first view, then read. ensureVideoBackend clears
        // lazyPath after opening, so this whole block is skipped from then on.
        // Capture the frame count as the seekbar currently sees it BEFORE opening
        // the backend: a lazy/transcoded backend sets video.shape[0] during
        // ensureVideoBackend (not via getFrame), so reading it afterwards would
        // miss the null→real transition and never markVideoUpdated() — leaving the
        // Seekbar's memoized totalFrames stuck (e.g. at 0 → hover always "Frame 1").
        const framesBefore = video.shape?.[0] ?? null;
        if (!video.backend) {
          const meta = video.backendMetadata as
            | Record<string, unknown>
            | undefined;
          if (typeof meta?.lazyPath === "string") {
            // Opens by byte-range internally (RangeSource) — no whole-file read.
            await ensureVideoBackend(video);
          }
          if (cancelled) return;
          if (!video.backend) {
            // No usable backend (missing file, failed lazy open, unsupported
            // codec) — blank the canvas instead of leaving the previously
            // viewed video's frame on screen, which reads as "nothing
            // happened" when a Locate-video placeholder is the only cue.
            frameBitmapRef.current = null;
            setFrameDims((prev) => (prev[0] === 0 && prev[1] === 0 ? prev : [0, 0]));
            setBitmapVersion((v) => v + 1);
            useAppStore.getState().set("frameLoading", false);
            return;
          }
        }
        const frame = await video.getFrame(frameIdx, { prefetch });
        // The frame count can become known here two ways: a deferred embedded
        // backend corrects video.shape[0] on this first getFrame, or a lazy/
        // transcoded backend set it during ensureVideoBackend above. Either way,
        // if it changed from what the seekbar last saw, nudge the store so the
        // seekbar/status bar re-read the real extent (not the JSON-seeded stand-in).
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
          // Raw decoder output may be grayscale (1ch), RGB (3ch), or RGBA
          // (4ch) — infer the real channel count (parity with the export
          // pipeline's decodeExportFrame) instead of assuming 4, which throws
          // a RangeError for anything else.
          const bytes =
            frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
          const shape = video.shape;
          if (!shape) return;
          const [, h, w] = shape;
          const channels = inferFrameChannels(bytes.length, w, h, shape[3]);
          const rgba = expandFrameBytesToRGBA(bytes, w, h, channels);
          const imageData = new ImageData(rgba, w, h);
          bmp = new OffscreenCanvas(w, h);
          bmp.getContext("2d")?.putImageData(imageData, 0, 0);
        } else if (
          frame &&
          typeof frame === "object" &&
          "data" in frame &&
          "width" in frame &&
          "height" in frame
        ) {
          // A plain-object RawFrame (sleap-io.js's GrayscaleVideoBackend /
          // CropVideoBackend can return this for a non-ImageData source):
          // {data, width, height, channels}. Never 4-channel-tight-packed, so
          // it must go through the same RGBA expansion as the raw-bytes case
          // above rather than the final else-branch's silent no-op.
          const raw = frame as {
            data: Uint8Array | Uint8ClampedArray;
            width: number;
            height: number;
            channels?: number;
          };
          const bytes =
            raw.data instanceof Uint8ClampedArray
              ? new Uint8Array(raw.data)
              : raw.data;
          const rgba = expandFrameBytesToRGBA(
            bytes,
            raw.width,
            raw.height,
            raw.channels ?? 1
          );
          const imageData = new ImageData(rgba, raw.width, raw.height);
          bmp = new OffscreenCanvas(raw.width, raw.height);
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
        // A resolved backend whose individual frame file can't be read (e.g. one
        // missing image in an otherwise-located sequence). Blank the canvas —
        // don't leave the previously-viewed frame up, which reads as "nothing
        // happened" — and flag the per-frame placeholder. This is the lazy,
        // at-view-time discovery that replaces the old eager load-time per-frame
        // existence sweep.
        if (!cancelled) {
          frameBitmapRef.current = null;
          setFrameDims((prev) => (prev[0] === 0 && prev[1] === 0 ? prev : [0, 0]));
          setBitmapVersion((v) => v + 1);
          setFrameImageMissing(true);
          // Remember this frame so a later "Locate Image…" can relocate it (and
          // any other frames found missing) without re-probing the whole list.
          missingFramesRef.current.add(frameIdx);
        }
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
  }, [video, frameIdx, readNonce]);

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
    if (!canvas) return;

    const [cw, ch] = containerSize;
    if (cw === 0 || ch === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    if (!bmp) {
      // No frame to show (e.g. the current video's backend failed to
      // resolve) — clear rather than leave the last-drawn video's frame up.
      const clearCtx = canvas.getContext("2d");
      clearCtx?.scale(dpr, dpr);
      clearCtx?.clearRect(0, 0, cw, ch);
      return;
    }

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

  // Drive QC display modes: reactively write per-instance visibility flags into
  // the transient store based on the current frame's instances. Manual mode is a
  // no-op, leaving the per-instance columns in control.
  useQcVisibility(labeledFrame?.instances ?? []);

  // Clear multi-node selection on frame change
  useEffect(() => {
    setSelectedNodes(new Set());
    setHoveredNode(null);
    setHoveredInstanceIdx(null);
    setInteractionMode("idle");
    setMarqueeStart(null);
    setMarqueeEnd(null);
  }, [frameIdx, labeledFrame]);

  // Keep the scratch `builderPositions` index-aligned with the skeleton node
  // list while building. AddNode also syncs inline, but this catches node-count
  // changes from undo/redo (which mutate skeleton.nodes without going through
  // the place path). Guarded by build mode; only writes when lengths diverge, so
  // it can't loop (builderPositions is not a dep).
  useEffect(() => {
    if (!skeletonBuildMode) return;
    const n = skeleton?.nodes.length ?? 0;
    if (useAppStore.getState().builderPositions.length !== n) {
      useAppStore.getState().syncBuilderPositions();
    }
  }, [skeletonBuildMode, skeleton, overlayVersion]);

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

    // Apply the fit + zoom/pan + rotation transform (image-pixel space). Shared
    // so the ROI overlay can be drawn on the early-return path too.
    const applyImageTransform = () => {
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
    };
    // Image-features ROI overlay (persisted region + live rubber-band). Drawn
    // whenever ROI-draw mode is active — independent of instances, so it must
    // render on unlabeled frames / when instances are hidden too. Assumes the
    // image transform is already applied.
    const paintRoi = () => {
      // The persisted region stays visible whenever it exists — even after
      // draw-mode auto-exits once a rectangle is set — so the user can keep it
      // on screen while working on the canvas. It is cleared only when the Image
      // Features view is left (SuggestionsPanel resetImageFeatureRoi).
      const persisted = video ? imageFeatureRois.get(video) : undefined;
      if (persisted) {
        renderRoiRect(
          ctx,
          persisted.x,
          persisted.y,
          persisted.x + persisted.width,
          persisted.y + persisted.height,
          baseScale * zoom
        );
      }
      // The live rubber-band only shows during an active draw.
      if (imageFeatureRoiDrawActive && roiStart && roiEnd) {
        renderRoiRect(ctx, roiStart.x, roiStart.y, roiEnd.x, roiEnd.y, baseScale * zoom);
      }
    };

    // Visual skeleton builder overlay: draw the scratch skeleton (never inserted
    // into labels), the hovered-node highlight, and the live connect pen stroke.
    // Independent of labeled instances, so it must render on the early-return
    // path too. Assumes the image transform is already applied.
    const paintBuilder = () => {
      if (!skeletonBuildMode || !skeleton) return;
      const ri = buildBuilderRenderedInstance(skeleton, builderPositions);
      const bOpts = {
        markerSize,
        nodeLabelSize,
        edgeStyle,
        showInstances: true,
        showLabels: true,
        showEdges: true,
        showNonVisibleNodes: true,
        colorPredicted: false,
        showTrackScore: false,
        zoom: baseScale * zoom,
      };
      renderInstances(ctx, [ri], bOpts);
      const hoverIdx = builderHoverIdxRef.current;
      if (hoverIdx !== null && hoverIdx >= 0) {
        renderHoveredNodeHighlight(ctx, [ri], 0, hoverIdx, bOpts);
      }
      if (skeletonBuildStage === "connect") {
        renderPenStroke(ctx, penStrokeRef.current);
      }
    };

    if (!labeledFrame || !showInstances) {
      renderedInstancesRef.current = [];
      // The ROI + builder overlays are independent of instance rendering — still
      // draw them (persisted region / live rubber-band / scratch skeleton).
      const hasRoi = video ? imageFeatureRois.has(video) : false;
      if (imageFeatureRoiDrawActive || hasRoi || skeletonBuildMode) {
        ctx.save();
        applyImageTransform();
        paintRoi();
        paintBuilder();
        ctx.restore();
      }
      return;
    }

    // Build renderable instances
    const tracks = labels?.tracks ?? [];
    const frameInstanceTracks = labeledFrame.instances.map((i) => i.track);
    const resolvedColorTarget = resolveColorTarget(distinctlyColor, projectHasTracks);
    const vis = { showInstances, hiddenInstances, viewOnlyInstance, showNonVisibleOverride };
    const instances: RenderedInstance[] = labeledFrame.instances.map(
      (inst, idx) => {
        const isPredicted = inst instanceof PredictedInstance;
        const skeleton = inst.skeleton;
        const color = getInstanceColor(
          palette, distinctlyColor, idx, inst.track, tracks, isPredicted, colorPredicted, projectHasTracks, frameInstanceTracks
        );

        // Per-node colors when (resolved) distinctlyColor === "node"
        const nodeColors = resolvedColorTarget === "node" && !(isPredicted && !colorPredicted)
          ? skeleton.nodes.map((_, nIdx) => getPaletteColor(palette, nIdx))
          : undefined;

        // Per-edge colors when (resolved) distinctlyColor === "edge"
        const edgeIndices = skeleton.edgeIndices;
        const edgeColors = resolvedColorTarget === "edge" && !(isPredicted && !colorPredicted)
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
      showTrackScore,
      zoom: baseScale * zoom,
    };

    renderInstances(ctx, instances, renderOpts);

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

      // Anchor-part picker: preview the top-down crop centered on the
      // hovered node, sized off that instance's own bbox (no configured crop
      // size is available here — this is a rough visual guide, not the exact
      // final crop).
      if (pickingAnchor) {
        const hoveredInstance = instances[hoveredNode.instanceIdx];
        renderAnchorCropPreview(
          ctx, instances, hoveredNode.instanceIdx, hoveredNode.nodeIdx,
          instanceBBoxCropSize(hoveredInstance), renderOpts
        );
      }
    }

    // Persistent anchor crop preview (Training panel "Preview" toggle,
    // independent of pick mode/hover): every instance on this frame that has
    // the configured anchor node. `anchorPreviewNode === null` previews
    // "Auto" (bbox center) instead of a specific node.
    if (anchorPreviewActive) {
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        let nodeIdx: number | null = null;
        if (anchorPreviewNode !== null) {
          nodeIdx = findNodeIdxByName(inst, anchorPreviewNode);
          if (nodeIdx === null) continue; // this instance's skeleton lacks the node
        }
        renderAnchorCropPreview(ctx, instances, i, nodeIdx, instanceBBoxCropSize(inst), renderOpts);
      }
    }

    // Render marquee selection rectangle
    if (marqueeStart && marqueeEnd) {
      renderMarqueeRect(ctx, marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y, baseScale * zoom);
    }

    // Image-features ROI overlay (also drawn on the early-return path above).
    paintRoi();

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

    // Skeleton builder overlay (scratch skeleton + hover + pen), on top of the
    // real instances but within the same image transform.
    paintBuilder();

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
    showTrackScore,
    edgeStyle,
    markerSize,
    nodeLabelSize,
    palette,
    distinctlyColor,
    projectHasTracks,
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
    pickingAnchor,
    anchorPreviewActive,
    anchorPreviewNode,
    marqueeStart,
    marqueeEnd,
    roiStart,
    roiEnd,
    imageFeatureRoiDrawActive,
    imageFeatureRois,
    video,
    areaDeleteStart,
    areaDeleteEnd,
    labels,
    video,
    frameIdx,
    rotation,
    skeletonBuildMode,
    skeletonBuildStage,
    builderPositions,
    skeleton,
  ]);

  // Check if we're in explicit placement mode
  const labelingMode = useAppStore((s) => s.labelingMode);
  const placementNodeIdx = useAppStore((s) => s.placementNodeIdx);
  const isPlacingNodes = labelingMode === "place" && selectedInstance !== null;

  // Render zoomed inset during node drag or placement mode
  const INSET_SIZE = useAppStore((s) => s.insetSize);
  const INSET_ZOOM = useAppStore((s) => s.insetZoom);
  const showInset = useAppStore((s) => s.showInset);
  useEffect(() => {
    const inset = insetCanvasRef.current;
    if (!inset) return;

    const hideInset = () => {
      inset.style.display = "none";
      inset.style.left = "";
      inset.style.top = "";
      inset.style.right = "";
    };

    if (!showInset) {
      hideInset();
      return;
    }

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
      // Hold-Shift / placement: overlay ALL instances (see the draw loop below)
      // so hovering shows the keypoints of whatever is under the cursor — not
      // only the selected instance (which previously left the loupe empty when
      // nothing was selected or the cursor was over another instance).
    }

    inset.style.display = "block";

    // Pin the loupe to the top-right corner in every mode (drag, placement,
    // hold-Shift) so it never occludes the point being placed — matches the
    // hold-Shift magnifier the drag case used to diverge from.
    inset.style.top = "12px";
    inset.style.right = "12px";
    inset.style.left = "auto";

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

    // For a node drag, overlay just the dragged instance (and skip the node
    // being dragged — the crosshair marks it). Otherwise (hold-Shift / node
    // placement) overlay ALL instances, so hovering shows the keypoints of
    // whatever is under the cursor. Nodes outside the magnified region are
    // clipped out below, so only nearby keypoints actually draw.
    const insetInstances = isDragInset && overlayInst ? [overlayInst] : instances;
    for (const inst of insetInstances) {
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

      // Draw visible nodes as small dots (skip only the dragged node).
      ctx.globalAlpha = 0.6;
      for (let nIdx = 0; nIdx < inst.nodes.length; nIdx++) {
        if (inst === overlayInst && nIdx === skipNodeIdx) continue;
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

    // Node-name label at the top of the loupe, if a specific node is in view.
    let labelName: string | null = null;
    if (isDragInset) {
      labelName = overlayInst?.nodes[skipNodeIdx]?.name ?? `node_${skipNodeIdx}`;
    } else if (isPlaceInset && placementNodeIdx !== null) {
      labelName =
        skeleton?.nodes[placementNodeIdx]?.name ?? `node_${placementNodeIdx}`;
    } else if (isHoldInset && hoveredNode) {
      labelName =
        skeleton?.nodes[hoveredNode.nodeIdx]?.name ??
        `node_${hoveredNode.nodeIdx}`;
    }

    if (labelName) {
      ctx.font = "600 11px system-ui, -apple-system, sans-serif";
      const paddingX = 6;
      const boxHeight = 16;
      const boxWidth = ctx.measureText(labelName).width + paddingX * 2;
      const boxX = (INSET_SIZE - boxWidth) / 2;
      const boxY = 6;
      const radius = 4;

      ctx.beginPath();
      ctx.moveTo(boxX + radius, boxY);
      ctx.arcTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + boxHeight, radius);
      ctx.arcTo(boxX + boxWidth, boxY + boxHeight, boxX, boxY + boxHeight, radius);
      ctx.arcTo(boxX, boxY + boxHeight, boxX, boxY, radius);
      ctx.arcTo(boxX, boxY, boxX + boxWidth, boxY, radius);
      ctx.closePath();
      // Highlighted (accent-orange) pill, matching the app's primary accent
      // color, so the label pops against the video frame behind it.
      ctx.fillStyle = "#f97316";
      ctx.fill();

      ctx.fillStyle = "#1c1006";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labelName, INSET_SIZE / 2, boxY + boxHeight / 2);
    }
  }, [
    interactionMode,
    dragNodeInfo,
    overlayVersion,
    bitmapVersion,
    isPlacingNodes,
    isShiftHeld,
    INSET_SIZE,
    INSET_ZOOM,
    zoom,
    skeleton,
    placementNodeIdx,
    hoveredNode,
    showInset,
  ]);

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

  // Fit view to selected instance (one-shot action): zooms and pans so the
  // selected instance's visible-node bounding box (+ padding) fills the
  // viewport. Triggered from the "Fit View to Selection" menu item, the
  // Shift+Up/Down cycle-instance shortcut, and clicking an instance in the
  // Instances panel.
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

  // Reset the view to default (zoom=1, no pan, fit-frame) on demand. Driven by a
  // one-shot nonce bumped from the toolbar button / 'R' hotkey — mirrors the
  // `fit`/`fitSelection` store-signal pattern (the toolbar/hotkey live
  // outside this component and can't call setZoom/setPan directly). The initial
  // nonce of 0 is skipped so a fresh mount doesn't fire a spurious reset.
  useEffect(() => {
    if (resetViewNonce === 0) return;
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    setZoom(1);
    setPanX(0);
    setPanY(0);
    // Restart the double-tap-space zoom cycle from a clean "free" state so the
    // next cycle behaves predictably after an explicit reset.
    zoomMode.current = "free";
    savedFreeView.current = { zoom: 1, panX: 0, panY: 0 };
  }, [resetViewNonce]);

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

  // Inverse of canvasToScene: scene (frame) coords -> client (viewport) pixels.
  const sceneToClient = useCallback(
    (x: number, y: number) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      // Apply forward rotation to get rotated-scene coordinates
      let sx = x, sy = y;
      if (rotation === 90) {
        const fx = fh - sy, fy = sx;
        sx = fx; sy = fy;
      } else if (rotation === 180) {
        sx = fw - sx; sy = fh - sy;
      } else if (rotation === 270) {
        const fx = sy, fy = fw - sx;
        sx = fx; sy = fy;
      }
      const cx = sx * baseScale * zoom + offsetX + panX;
      const cy = sy * baseScale * zoom + offsetY + panY;
      return { x: cx + rect.left, y: cy + rect.top };
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

      // Visual skeleton builder owns left-clicks first, before all normal
      // (pan / place / marquee) logic. Positions live only in `builderPositions`
      // — the scratch skeleton is never inserted into `labels`.
      if (skeletonBuildMode && skeleton) {
        e.preventDefault();
        const p = canvasToScene(e.clientX, e.clientY);
        // Match the existing node hit-test: scene-space threshold + [instances].
        const threshold = (markerSize * 2) / (baseScale * zoom);
        const store = useAppStore.getState();
        const ri =
          builderRI ?? buildBuilderRenderedInstance(skeleton, store.builderPositions);
        if (store.skeletonBuildStage === "place") {
          const hit = hitTestNode([ri], p.x, p.y, threshold);
          if (hit) {
            // Grab an existing node to reposition it.
            builderDragIdxRef.current = hit.nodeIdx;
          } else {
            // Empty space: append a new node and drop it here (source coords).
            commandContext.execute(AddNodeCommand, {
              name: nextBuilderNodeName(skeleton.nodes),
            });
            store.syncBuilderPositions();
            const newIdx = skeleton.nodes.length - 1;
            // Builder positions are scratch image-space coords (never saved), so
            // store `p` directly — no source/crop round-trip (correct on cropped
            // pkg.slp videos too, since builderRI renders in this same space).
            store.setBuilderPosition(newIdx, { x: p.x, y: p.y });
          }
        } else {
          // connect stage: begin a pen stroke from the node under the cursor.
          penActiveRef.current = true;
          penStrokeRef.current = [p];
          penLastRef.current = hitTestNode([ri], p.x, p.y, threshold)?.nodeIdx ?? null;
        }
        return;
      }

      // Anchor-part picker (Training panel): clicking any instance's node
      // resolves the pick with that node's name. A miss is a no-op — stay in
      // pick mode so the user can navigate to a better frame and try again.
      if (pickingAnchor) {
        e.preventDefault();
        const p = canvasToScene(e.clientX, e.clientY);
        const instances = renderedInstancesRef.current;
        const threshold = (markerSize * 2) / (baseScale * zoom);
        const hit = hitTestNode(instances, p.x, p.y, threshold);
        const nodeName = hit ? instances[hit.instanceIdx]?.nodes[hit.nodeIdx]?.name : null;
        if (nodeName) useAppStore.getState().resolveAnchorPick(nodeName);
        return;
      }

      // A left-click while Space is held means the user is using this Space
      // press to drag/pan, not to tap for the next-suggestion shortcut --
      // suppress that shortcut's jump when Space is released (see
      // spacePanTracking.ts).
      if (isSpaceHeld) spacePanState.draggedWhileHeld = true;

      // Image-features ROI draw mode takes priority: drag to set the crop region.
      if (imageFeatureRoiDrawActive) {
        e.preventDefault();
        const p = canvasToScene(e.clientX, e.clientY);
        setInteractionMode("roi");
        setRoiStart(p);
        setRoiEnd(p);
        return;
      }

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
        const nt = (markerSize * 2) / (baseScale * zoom);
        const hit = hitTestNode(
          instances, x, y, nt,
          showLabels ? { zoom, markerSize, nodeLabelSize } : undefined
        );
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

      // Node placement mode: place the target node (with undo snapshot)
      const store = useAppStore.getState();
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
          hintIfFirstNodeConfirm(currentInstance.points[targetIdx].complete);
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
            // All nodes placed — exit placement mode.
            store.exitPlacementMode();
          }

          store.bumpOverlayVersion();
          return;
        }
      }

      const instances = renderedInstancesRef.current;
      const nodeThreshold = (markerSize * 2) / (baseScale * zoom);
      const instanceThreshold = 30 / (baseScale * zoom);

      // Ctrl+click-and-drag on a user instance clones it and immediately
      // starts dragging the copy, mirroring PyQt SLEAP's
      // QtInstance.mousePressEvent (Ctrl+click -> duplicate_instance()).
      // Returns true (and starts the drag) if `hitInstanceIdx` was a
      // ctrl-clicked, non-predicted instance; false otherwise, so callers can
      // fall through to their normal hit-handling.
      const tryBeginDuplicateDrag = (hitInstanceIdx: number): boolean => {
        if (!e.ctrlKey || instances[hitInstanceIdx]?.isPredicted) return false;
        const lf = useAppStore.getState().labeledFrame;
        const sourceInstance = lf?.instances[hitInstanceIdx];
        if (!lf || !sourceInstance) return false;

        commandContext.execute(DuplicateInstance, { instance: sourceInstance });
        const newInstance = useAppStore.getState().instance;
        const newLf = useAppStore.getState().labeledFrame;
        if (!newInstance || !newLf) return false;
        const newIdx = newLf.instances.indexOf(newInstance);

        const keys = new Set<string>();
        newInstance.points.forEach((p, pIdx) => {
          if (!isNaN(p.xy[0]) && !isNaN(p.xy[1])) {
            keys.add(makeNodeKey(newIdx, pIdx));
            // Dragging the clone into place is a deliberate confirm of each
            // point, same as a plain single-node click/drag — previously
            // these silently kept whatever `complete` they inherited from
            // the source instance (clonePoints copies it verbatim), so a
            // clone of an unconfirmed instance stayed red even after being
            // positioned.
            hintIfFirstNodeConfirm(p.complete);
            p.complete = true;
          }
        });
        setSelectedNodes(keys);
        setDragNodeInfo({ instanceIdx: newIdx, nodeIdx: 0 });
        setIsDragging(true);
        setInteractionMode("dragging");
        lastDragPos.current = { x, y };
        dragStartClient.current = { clientX: e.clientX, clientY: e.clientY };
        useAppStore.getState().bumpOverlayVersion();
        return true;
      };

      // Try to hit a node first (marker or, if shown, its name label)
      const nodeHit = hitTestNode(
        instances, x, y, nodeThreshold,
        showLabels ? { zoom, markerSize, nodeLabelSize } : undefined
      );
      if (nodeHit) {
        if (tryBeginDuplicateDrag(nodeHit.instanceIdx)) return;
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
          // Clicking a node marks it "complete" (confirmed by the user), same
          // as PyQt SLEAP's QtNode.mousePressEvent -- turns its label green.
          // When this click is the start of a GROUP drag (e.g. after
          // double-clicking to select every node in the instance), every
          // selected node moves together via handleMouseMove's group-drag
          // branch -- mark all of them confirmed, not just the one clicked,
          // or the others would keep moving while staying red. `selectedNodes`
          // (the pre-click set) is the right source here when the clicked key
          // was already in it; `setSelectedNodes` above hasn't landed yet for
          // a fresh single-node click, so fall back to just `key` then.
          const workingKeys = alreadySelected ? selectedNodes : new Set([key]);
          for (const wKey of workingKeys) {
            const { instanceIdx: wInstIdx, nodeIdx: wNodeIdx } = parseNodeKey(wKey);
            const wPoint = lf?.instances[wInstIdx]?.points[wNodeIdx];
            if (wPoint) {
              hintIfFirstNodeConfirm(wPoint.complete);
              wPoint.complete = true;
            }
          }
          setDragNodeInfo(nodeHit);
          setIsDragging(true);
          setInteractionMode("dragging");
          lastDragPos.current = { x, y };
          dragStartClient.current = { clientX: e.clientX, clientY: e.clientY };
          useAppStore.getState().markChanged();
          useAppStore.getState().touchFrame();
          useAppStore.getState().bumpOverlayVersion();
        }
        return;
      }

      // Try to hit an instance (by centroid)
      const instHit = hitTestInstance(instances, x, y, instanceThreshold);
      if (instHit !== null) {
        if (tryBeginDuplicateDrag(instHit)) return;
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
        const store = useAppStore.getState();
        hintIfPredictionsRemain(store.instance, store.labeledFrame);
        store.setInstance(null);
      }
      setInteractionMode("marquee");
      setMarqueeStart({ x, y });
      setMarqueeEnd({ x, y });
    },
    [canvasToScene, markerSize, nodeLabelSize, showLabels, panX, panY, zoom, baseScale, shouldPan, isCmdHeld, isSpaceHeld, offsetX, offsetY, selectedNodes, areaDeleteMode, imageFeatureRoiDrawActive, skeletonBuildMode, skeleton, builderRI, pickingAnchor]
  );

  // Node-drag perf (#329): coalesce the overlay redraw to one per frame and
  // commit the edit once on mouse-up (see handleMouseMove/Up).
  const dragRafRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  useEffect(
    () => () => {
      if (dragRafRef.current != null) cancelAnimationFrame(dragRafRef.current);
      setLabelsAutosaveInteracting(false);
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Skeleton builder owns the move gesture in build mode (no fall-through to
      // pan/marquee/hover). Refs hold transient state; redraws via overlayVersion.
      if (skeletonBuildMode && skeleton) {
        const store = useAppStore.getState();
        const p = canvasToScene(e.clientX, e.clientY);
        const threshold = (markerSize * 2) / (baseScale * zoom);
        // place: drag a grabbed node to reposition it (source coords).
        if (store.skeletonBuildStage === "place" && builderDragIdxRef.current !== null) {
          // Scratch image-space coords (never saved) — store `p` directly, no
          // source/crop round-trip (keeps the node under the cursor on cropped
          // videos too).
          store.setBuilderPosition(builderDragIdxRef.current, { x: p.x, y: p.y });
          return;
        }
        // connect: extend the pen and emit an edge for each freshly-crossed node.
        if (store.skeletonBuildStage === "connect" && penActiveRef.current) {
          const stroke = penStrokeRef.current;
          const prev = stroke[stroke.length - 1] ?? p;
          stroke.push(p);
          // Same scene-space threshold as hit-testing so a fast stroke can't skip
          // a small node between move samples (segment test, not point sampling).
          const crossed = nodesCrossedBySegment(
            store.builderPositions,
            threshold,
            prev,
            p
          );
          for (const n of crossed) {
            const last = penLastRef.current;
            if (n === last) continue;
            if (
              last !== null &&
              isValidEdgeSelection(
                skeleton.nodes,
                skeleton.edges,
                skeleton.nodes[last].name,
                skeleton.nodes[n].name
              )
            ) {
              commandContext.execute(AddEdgeCommand, {
                srcName: skeleton.nodes[last].name,
                dstName: skeleton.nodes[n].name,
              });
            }
            penLastRef.current = n;
          }
          store.bumpOverlayVersion();
          return;
        }
        // idle: highlight the builder node under the cursor.
        const ri =
          builderRI ?? buildBuilderRenderedInstance(skeleton, store.builderPositions);
        const hit = hitTestNode([ri], p.x, p.y, threshold);
        const nextHover = hit ? hit.nodeIdx : null;
        if (nextHover !== builderHoverIdxRef.current) {
          builderHoverIdxRef.current = nextHover;
          store.bumpOverlayVersion();
        }
        return;
      }

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

      // ROI-draw mode: update the region rubber-band.
      if (interactionMode === "roi") {
        setRoiEnd(canvasToScene(e.clientX, e.clientY));
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
          // Single node drag. Visibility is untouched -- matches PyQt SLEAP's
          // QtNode.updatePoint(), which only updates x/y on drag; visibility
          // only changes via the explicit toggle action.
          const instance = lf.instances[dragNodeInfo.instanceIdx];
          const point = instance?.points[dragNodeInfo.nodeIdx];
          if (point) {
            // Drag position is crop-local; store back in source coords.
            point.xy = toSourceCoords(useAppStore.getState().video, x, y);
          }
        }

        // Pin the hover tooltip ONCE (at drag-start position). It was set every
        // move, which re-rendered VideoPlayer and re-ran the overlay effect
        // (hoveredNode is a dep) on top of the redraw below — pure per-move waste
        // since the pin never changes during the gesture.
        if (!dragMovedRef.current) {
          setHoveredNode({
            instanceIdx: dragNodeInfo.instanceIdx,
            nodeIdx: dragNodeInfo.nodeIdx,
            clientX: dragStartClient.current?.clientX ?? e.clientX,
            clientY: dragStartClient.current?.clientY ?? e.clientY,
          });
          dragMovedRef.current = true;
          // Suspend autosave for the gesture so a drag longer than the debounce
          // can't trigger a mid-drag project serialization (#329).
          setLabelsAutosaveInteracting(true);
        }

        lastDragPos.current = { x, y };
        // Coalesce the (potentially O(instances×nodes)) overlay rebuild to at
        // most one per animation frame — a high-Hz pointer otherwise rebuilds on
        // every event. markChanged/touchFrame are deferred to mouse-up so the
        // ~10 editSeq/frame-stack subscribers don't re-render per move and
        // autosave can't serialize the whole project mid-drag (#329).
        if (dragRafRef.current == null) {
          dragRafRef.current = requestAnimationFrame(() => {
            dragRafRef.current = null;
            useAppStore.getState().bumpOverlayVersion();
          });
        }
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
      const nodeThreshold = (markerSize * 2) / (baseScale * zoom);
      const hit = hitTestNode(
        instances, x, y, nodeThreshold,
        showLabels ? { zoom, markerSize, nodeLabelSize } : undefined
      );

      if (hit) {
        const prevIdx = hoveredNode?.instanceIdx;
        const prevNode = hoveredNode?.nodeIdx;
        setHoveredNode({
          instanceIdx: hit.instanceIdx,
          nodeIdx: hit.nodeIdx,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        if (hoveredInstanceIdx) setHoveredInstanceIdx(null);
        if (prevIdx !== hit.instanceIdx || prevNode !== hit.nodeIdx) {
          useAppStore.getState().bumpOverlayVersion();
        }
      } else {
        if (hoveredNode) {
          setHoveredNode(null);
          useAppStore.getState().bumpOverlayVersion();
        }
        // #346: not on a node, but maybe still on the instance's body — same
        // centroid-distance test used for click-to-select (instanceThreshold
        // elsewhere in this file).
        const instanceThreshold = 30 / (baseScale * zoom);
        const instHit = hitTestInstance(instances, x, y, instanceThreshold);
        if (instHit !== null) {
          setHoveredInstanceIdx({ idx: instHit, clientX: e.clientX, clientY: e.clientY });
        } else if (hoveredInstanceIdx) {
          setHoveredInstanceIdx(null);
        }
      }
    },
    [isDragging, isPanning, isZoomDragging, dragNodeInfo, canvasToScene, panStart, constrainPan, zoom, baseScale, interactionMode, selectedNodes, markerSize, nodeLabelSize, showLabels, hoveredNode, hoveredInstanceIdx, offsetX, offsetY, isPlacingNodes, isShiftHeld, isAreaDeleting, areaDeleteStart, skeletonBuildMode, skeleton, builderRI]
  );

  const handleMouseUp = useCallback(() => {
    // Skeleton builder: end any place-drag or connect-pen gesture.
    if (useAppStore.getState().skeletonBuildMode) {
      builderDragIdxRef.current = null;
      penActiveRef.current = false;
      penStrokeRef.current = [];
      penLastRef.current = null;
      useAppStore.getState().bumpOverlayVersion();
      return;
    }

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

    if (interactionMode === "roi" && roiStart && roiEnd) {
      const x = Math.min(roiStart.x, roiEnd.x);
      const y = Math.min(roiStart.y, roiEnd.y);
      const width = Math.abs(roiEnd.x - roiStart.x);
      const height = Math.abs(roiEnd.y - roiStart.y);
      const currentVideo = useAppStore.getState().video;
      // Ignore an accidental click / tiny drag (preserve any existing region).
      if (currentVideo && width > 2 && height > 2) {
        setImageFeatureRoi(currentVideo, { x, y, width, height });
        // One-shot: exit draw-mode once a region is committed so the canvas is
        // immediately usable again (labeling/panning). The rectangle stays
        // visible (painted from the persisted region) and is cleared only when
        // the Image Features view is left.
        useAppStore.getState().setImageFeatureRoiDrawActive(false);
      }
      setRoiStart(null);
      setRoiEnd(null);
      setInteractionMode("idle");
      useAppStore.getState().bumpOverlayVersion();
      return;
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
      setLabelsAutosaveInteracting(false);
      // Flush the coalesced redraw and commit the gesture's edit ONCE (deferred
      // from per-move). markChanged here arms autosave a single time, after the
      // gesture — never mid-drag (#329).
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      if (dragMovedRef.current) {
        dragMovedRef.current = false;
        const s = useAppStore.getState();
        s.markChanged();
        s.touchFrame();
        s.bumpOverlayVersion();
      }
    }
  }, [isDragging, isPanning, isZoomDragging, interactionMode, marqueeStart, marqueeEnd, isAreaDeleting, areaDeleteStart, areaDeleteEnd, roiStart, roiEnd, setImageFeatureRoi]);

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

      // Decide the gesture — ZOOM or PAN (#278/#282). Plain scroll PANS (mouse
      // wheel and trackpad two-finger alike); only Ctrl+scroll ZOOMS. Fully
      // deterministic and device-agnostic — no trying to tell a mouse wheel from
      // a trackpad pan. A trackpad *pinch* also zooms because the browser
      // synthesizes ctrlKey for it.
      if (!e.ctrlKey) {
        // Pan by the raw scroll delta (mouse wheel / side wheel / trackpad
        // two-finger). Reuse constrainPan so the image can't be flung
        // off-canvas, matching click-drag panning.
        const prev = viewRef.current;
        const constrained = constrainPan(
          prev.panX - e.deltaX,
          prev.panY - e.deltaY,
          prev.zoom
        );
        viewRef.current = {
          zoom: prev.zoom,
          panX: constrained.x,
          panY: constrained.y,
        };
        setPanX(constrained.x);
        setPanY(constrained.y);
        return;
      }

      // ZOOM (Ctrl+scroll or trackpad pinch), anchored at the cursor.
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
  }, [offsetX, offsetY, constrainPan]);

  // Double-click: convert predicted instance, or reset zoom/pan
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // Skeleton builder (place stage): double-click a placed node to rename
      // it inline (floating input anchored over the node), via the undoable
      // RenameNodeCommand.
      if (skeletonBuildMode && skeleton) {
        const store = useAppStore.getState();
        if (store.skeletonBuildStage === "place") {
          const p = canvasToScene(e.clientX, e.clientY);
          const threshold = (markerSize * 2) / (baseScale * zoom);
          const ri =
            builderRI ?? buildBuilderRenderedInstance(skeleton, store.builderPositions);
          const hit = hitTestNode([ri], p.x, p.y, threshold);
          if (hit) {
            const node = ri.nodes[hit.nodeIdx];
            setRenameValue(skeleton.nodes[hit.nodeIdx]?.name ?? "");
            setRenamingNode({ nodeIdx: hit.nodeIdx, x: node.x, y: node.y });
          }
        }
        return;
      }

      const { x, y } = canvasToScene(e.clientX, e.clientY);
      const instances = renderedInstancesRef.current;

      // Scale hit test thresholds by 1/zoom
      const nodeThreshold = (markerSize * 2) / (baseScale * zoom);
      const instanceThreshold = 30 / (baseScale * zoom);

      // Check if double-clicking on a node (marker or, if shown, its name label)
      const nodeHit = hitTestNode(
        instances, x, y, nodeThreshold,
        showLabels ? { zoom, markerSize, nodeLabelSize } : undefined
      );
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
    [canvasToScene, markerSize, nodeLabelSize, showLabels, zoom, baseScale, shouldPan, skeletonBuildMode, skeleton, builderRI]
  );

  // Right-click context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      // On macOS, Ctrl+left-click is indistinguishable from a real right-click
      // at the DOM level -- both fire "contextmenu". But Ctrl+click-and-drag is
      // reserved for the clone-and-drag gesture (handled on mousedown, above),
      // so treat a Ctrl-modified contextmenu as a no-op here: a genuine
      // right-click (mouse button / trackpad two-finger tap) never has
      // e.ctrlKey set, since no keyboard modifier was held.
      if (e.ctrlKey) return;

      const { x, y } = canvasToScene(e.clientX, e.clientY);
      const sceneLocation = toSourceCoords(useAppStore.getState().video, x, y);
      const instances = renderedInstancesRef.current;

      // Check if right-clicking on a node
      const nodeHit = hitTestNode(
        instances, x, y, (markerSize * 2) / (baseScale * zoom),
        showLabels ? { zoom, markerSize, nodeLabelSize } : undefined
      );
      if (nodeHit) {
        const lf = useAppStore.getState().labeledFrame;
        const inst = lf?.instances[nodeHit.instanceIdx];
        if (inst) {
          useAppStore.getState().setInstance(inst);
        }

        // Right-click directly toggles a single node's visibility, mirroring
        // legacy sleap — no menu pops up for this click. Predicted instances
        // can't be edited, and a node that's part of a multi-node selection
        // keeps going through the menu so the "toggle N selected" action
        // stays reachable.
        const nodeKey = makeNodeKey(nodeHit.instanceIdx, nodeHit.nodeIdx);
        const isMultiSelected = selectedNodes.size > 1 && selectedNodes.has(nodeKey);
        if (inst && !(inst instanceof PredictedInstance) && !isMultiSelected) {
          const point = inst.points[nodeHit.nodeIdx];
          if (point) {
            commandContext.execute(BeginEdit);
            point.visible = !point.visible;
            useAppStore.getState().markChanged();
            useAppStore.getState().touchFrame();
            useAppStore.getState().bumpOverlayVersion();
          }
          return;
        }

        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          sceneLocation,
          instanceIdx: nodeHit.instanceIdx,
          nodeIdx: nodeHit.nodeIdx,
        });
        return;
      }

      // Check if right-clicking on an instance
      const instHit = hitTestInstance(instances, x, y, 30 / (baseScale * zoom));
      if (instHit !== null) {
        const lf = useAppStore.getState().labeledFrame;
        if (lf) {
          useAppStore.getState().setInstance(lf.instances[instHit]);
        }
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          sceneLocation,
          instanceIdx: instHit,
          nodeIdx: null,
        });
        return;
      }

      // Right-click on empty space
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        sceneLocation,
        instanceIdx: null,
        nodeIdx: null,
      });
    },
    [canvasToScene, markerSize, nodeLabelSize, showLabels, zoom, baseScale, selectedNodes]
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
          pickingAnchor ? "cursor-crosshair" : skeletonBuildMode ? (skeletonBuildStage === "connect" ? "cursor-crosshair" : "cursor-cell") : imageFeatureRoiDrawActive ? "cursor-crosshair" : isPanning ? "cursor-grabbing" : isZoomDragging ? "cursor-zoom-in" : (shouldPan && isCmdHeld) ? "cursor-zoom-in" : shouldPan ? "cursor-grab" : isDragging ? "cursor-grabbing" : areaDeleteMode ? "cursor-crosshair" : interactionMode === "marquee" ? "cursor-crosshair" : isPlacingNodes ? "cursor-cell" : hoveredNode ? "cursor-pointer" : "cursor-default"
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
          onMouseLeave={() => { handleMouseUp(); setHoveredNode(null); setHoveredInstanceIdx(null); cursorScene.current = null; }}
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
        {/* Skeleton builder: inline node-rename input, anchored over the node
            (tracks pan/zoom since position is recomputed from scene coords). */}
        {renamingNode && skeleton && (() => {
          const containerRect = containerRef.current?.getBoundingClientRect();
          if (!containerRect) return null;
          const { x: clientX, y: clientY } = sceneToClient(
            renamingNode.x,
            renamingNode.y
          );
          const isDuplicate =
            renameValue.trim() !== "" &&
            skeleton.nodes.some(
              (n, i) => n.name === renameValue.trim() && i !== renamingNode.nodeIdx
            );
          return (
            <div
              className="absolute z-30"
              style={{
                left: clientX - containerRect.left + 12,
                top: clientY - containerRect.top - 10,
              }}
            >
              <input
                ref={renameInputRef}
                className={cn(
                  "text-xs px-1 py-0.5 rounded border bg-background shadow-lg outline-none w-32",
                  isDuplicate
                    ? "border-destructive text-destructive"
                    : "border-primary"
                )}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitNodeRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitNodeRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelNodeRename();
                  }
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
              {isDuplicate && (
                <div className="text-[10px] text-destructive bg-background/90 px-1 rounded-b">
                  Duplicate name
                </div>
              )}
            </div>
          );
        })()}
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
          // #341: color this line to match the same convention the canvas
          // node/label itself uses — yellow (predicted), red (unconfirmed),
          // green (confirmed) — so the tooltip text reads as a direct
          // translation of what's on screen, not just a separate caption.
          const statusColor = isPredicted
            ? UNCOLORED_PREDICTED_NODE_COLOR
            : point.complete
              ? COMPLETE_COLOR
              : INCOMPLETE_COLOR;
          return (
            <div
              className="absolute pointer-events-none bg-black/80 text-white text-xs rounded shadow-lg px-2 py-1.5 z-20 leading-relaxed"
              style={{ left: tipX, top: tipY }}
            >
              <div className="font-medium">{nodeName}</div>
              <div style={{ color: rgbToCSS(statusColor) }}>
                <strong>{isPredicted ? "predicted" : "user"}</strong> · {point.visible ? "visible" : "not visible"}
                {/* #341: translate the red/green node-color convention inline,
                    here rather than a one-shot toast, so it's discoverable
                    every time — not just once, and not just if the toast
                    happened to be caught. Doesn't apply to predicted points,
                    which are always yellow regardless of `complete`. */}
                {!isPredicted && ` · ${point.complete ? "confirmed" : "unconfirmed"}`}
              </div>
              <div className="text-white/70">
                x: {point.xy[0].toFixed(1)}, y: {point.xy[1].toFixed(1)}
              </div>
              {/* #341: same reasoning as above — teach the right-click-to-toggle
                  mechanic wherever it's actually relevant (any hidden node on a
                  user instance, not just ones auto-hidden by converting a
                  prediction with missing detections). */}
              {!isPredicted && !point.visible && (
                <div className="text-white/40 text-[10px] mt-0.5">
                  right-click to toggle visible
                </div>
              )}
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

        {/* Instance hover caption (#346): a subtle "User Instance" / "Predicted
            Instance" translation of the color coding, shown when hovering an
            instance's body without landing precisely on one of its nodes (the
            more detailed node tooltip above already says "predicted"/"user"
            when it's showing, so this is skipped whenever that one is). */}
        {!hoveredNode && hoveredInstanceIdx && labeledFrame && (() => {
          const lfInst = labeledFrame.instances[hoveredInstanceIdx.idx];
          if (!lfInst) return null;
          const containerRect = containerRef.current?.getBoundingClientRect();
          if (!containerRect) return null;
          const tipX = hoveredInstanceIdx.clientX - containerRect.left + 16;
          const tipY = hoveredInstanceIdx.clientY - containerRect.top - 8;
          const isPredicted = lfInst instanceof PredictedInstance;
          return (
            <div
              className="absolute pointer-events-none bg-black/70 text-white/90 text-[11px] rounded shadow px-1.5 py-1 z-20"
              style={{ left: tipX, top: tipY }}
            >
              {isPredicted ? "Predicted Instance" : "User Instance"}
            </div>
          );
        })()}

        {/* View controls overlay: reset-view button + zoom-level readout. The
            frame counter lives in the status bar only (was previously
            duplicated here and beside the seekbar). */}
        <div className="absolute bottom-2 left-2 z-20 flex items-center gap-1.5">
          {/* Node-name label toggle (leftmost). Flips `showLabels` (the same
              View → Show Labels state), so node names show/hide next to the
              keypoints. Dimmed when off. Press T to toggle (see shortcuts). */}
          <Button
            variant="secondary"
            size="icon-xs"
            className={cn(
              "pointer-events-auto rounded-md bg-black/60 border-none hover:bg-black/70 hover:text-white",
              showLabels ? "text-white" : "text-white/40",
            )}
            title={showLabels ? "Hide node names (T)" : "Show node names (T)"}
            aria-label="Toggle node name labels"
            aria-pressed={showLabels}
            onClick={() => useAppStore.getState().toggle("showLabels")}
          >
            <Tag />
          </Button>
          {/* Pan vs. Select interaction-mode toggle. Sits immediately left of
              Reset view so this commonly-used control is visible on the canvas.
              Press P to toggle (see shortcuts). */}
          <Button
            variant="secondary"
            size="icon-xs"
            className="pointer-events-auto rounded-md bg-black/60 text-white/80 border-none hover:bg-black/70 hover:text-white"
            title={
              defaultToPan
                ? "Pan mode (P to switch to Select)"
                : "Select mode (P to switch to Pan)"
            }
            aria-label={
              defaultToPan
                ? "Pan mode (P to switch to Select)"
                : "Select mode (P to switch to Pan)"
            }
            aria-pressed={defaultToPan}
            onClick={() => useAppStore.getState().toggle("defaultToPan")}
          >
            {defaultToPan ? <Hand /> : <MousePointer2 />}
          </Button>
          <Button
            variant="secondary"
            size="icon-xs"
            className="pointer-events-auto rounded-md bg-black/60 text-white/80 border-none hover:bg-black/70 hover:text-white"
            title="Reset view (R)"
            aria-label="Reset view (R)"
            onClick={() => useAppStore.getState().resetView()}
          >
            <Frame />
          </Button>
          {zoom !== 1 && (
            <Badge
              variant="secondary"
              className="pointer-events-none rounded-md bg-black/60 text-white/80 border-none"
            >
              {(zoom * 100).toFixed(0)}%
            </Badge>
          )}
        </div>

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
            {` · ${formatShortcut("Tab")}/${formatShortcut("Shift+Tab")} to cycle · Esc to exit`}
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
                    // resolveVideoFile just set video.shape[0] to the true
                    // source frame count (in place). Bump videoRevision so the
                    // seekbar + status-bar frame-total memos re-read it and
                    // re-extend the timeline to the full video (otherwise it
                    // stays clamped to the last labeled frame).
                    useAppStore.getState().markVideoUpdated();
                    useAppStore.getState().setFrameIdx(frameIdx);
                  }
                }}
              >
                Locate Video
              </Button>
            </div>
          </div>
        )}

        {/* Per-frame image-missing placeholder: the video itself resolved, but
            THIS frame's image file couldn't be read (e.g. a single deleted image
            in an otherwise-located sequence). Non-blocking + informational; a
            surgical per-frame "Locate…" action is a follow-up. */}
        {video && !isVideoMissing(video) && frameImageMissing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <div className="flex flex-col items-center gap-2 max-w-md px-4 text-center pointer-events-auto">
              <ImageOff className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                Frame image not found
              </p>
              <p className="text-xs text-muted-foreground/70">
                This frame&apos;s image file couldn&apos;t be read. Other frames
                are unaffected.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={relocating}
                  onClick={async () => {
                    if (!video) return;
                    // A video-backed frame (e.g. a transcoded AVI whose cached MP4
                    // was cleared) reads as a missing frame image — but the fix is
                    // to re-specify the VIDEO, not hunt for one image.
                    // resolveVideoFile re-points THIS video's backend (re-
                    // transcoding a legacy codec on desktop), keeping labels aligned
                    // (same Video, frame-exact). Mirrors "Locate Video" above.
                    const ok = await resolveVideoFile(video, labels ?? undefined);
                    useAppStore.getState().bumpOverlayVersion();
                    if (ok) {
                      useAppStore.getState().markVideoUpdated();
                      missingFramesRef.current.clear();
                      setFrameImageMissing(false);
                      setReadNonce((n) => n + 1);
                      useAppStore.getState().setFrameIdx(frameIdx);
                    }
                  }}
                >
                  Replace Video…
                </Button>
              {isTauri && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={relocating}
                  onClick={async () => {
                    if (!video) return;
                    setRelocating(true);
                    try {
                      const platform = await getPlatform();
                      const folder = await platform.showOpenDialog({
                        directory: true,
                        multiple: false,
                      });
                      if (typeof folder !== "string") return;
                      // The current frame + any others already found missing;
                      // relocate ONLY these against the picked folder (never the
                      // frames that already resolved).
                      missingFramesRef.current.add(frameIdx);
                      const { located } = await relocateMissingImageFrames(
                        video,
                        [...missingFramesRef.current],
                        folder,
                        platform.exists,
                      );
                      if (located.length === 0) {
                        toast.error("No matching images found in that folder");
                        return;
                      }
                      for (const i of located)
                        missingFramesRef.current.delete(i);
                      useAppStore.getState().markVideoUpdated();
                      setFrameImageMissing(false);
                      setReadNonce((n) => n + 1); // re-read the current frame
                      toast.success(
                        `Located ${located.length} image${located.length > 1 ? "s" : ""}`,
                      );
                    } catch (err) {
                      console.error("[video] Locate frame image failed:", err);
                    } finally {
                      setRelocating(false);
                    }
                  }}
                >
                  {relocating ? "Locating…" : "Locate Image…"}
                </Button>
              )}
              </div>
            </div>
          </div>
        )}

        {/* Visual skeleton builder control bar (self-guards to build mode). */}
        <SkeletonBuildBar />
        {/* Anchor-part picker prompt (self-guards to pick mode). */}
        <AnchorPickBar />
      </div>

      {/* Seekbar */}
      <Seekbar />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sceneLocation={contextMenu.sceneLocation}
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
