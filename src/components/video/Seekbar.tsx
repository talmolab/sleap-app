/**
 * Frame navigation seekbar component.
 *
 * Matches SLEAP's VideoSlider with:
 * - Frame scrubbing (click and drag)
 * - Marks for labeled frames (colored dots)
 * - Track occupancy bars
 * - Frame counter display
 * - Selection range (Shift+click-drag)
 * - Instance count header graph
 */

import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { useAppStore } from "../../stores/appStore";
import { getPaletteColor, rgbToCSS } from "../../lib/colorPalettes";
import {
  computeStatisticSeries,
  getGraphSpec,
  GRAPH_SPECS,
  type StatisticGraphType,
} from "@/lib/statisticSeries";
import type {
  WorkerGraphType,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/statisticSeriesWorkerCore";
import { drawHeaderSeries } from "@/lib/headerSeriesRender";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SkipBack,
  ChevronLeft,
  Play,
  Pause,
  ChevronRight,
  SkipForward,
} from "lucide-react";

/** Playback speed presets. */
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

/** Snap threshold in pixels for snapping to labeled frames. */
const SNAP_THRESHOLD_PX = 12;

/** Height of the instance count header graph in pixels. */
const HEADER_HEIGHT = 16;

/**
 * Frame-count threshold past which the 3 heavy header graphs (point
 * displacement, primary point displacement, min centroid proximity) are
 * computed off the main thread in a Web Worker. Smaller videos keep the
 * synchronous useMemo path. Locked default; tune empirically.
 */
const WORKER_FRAME_THRESHOLD = 2000;

/** The heavy graph types that have a Web Worker implementation. */
const WORKER_GRAPHS: ReadonlySet<StatisticGraphType> = new Set<StatisticGraphType>([
  "point-displacement",
  "primary-point-displacement",
  "min-centroid-proximity",
]);

export function Seekbar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headerCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerContainerRef = useRef<HTMLDivElement>(null);

  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const labels = useAppStore((s) => s.labels);
  const palette = useAppStore((s) => s.palette);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const frameRange = useAppStore((s) => s.frameRange);
  const seekbarHeaderGraph = useAppStore((s) => s.seekbarHeaderGraph);
  const seekbarHeaderReduction = useAppStore((s) => s.seekbarHeaderReduction);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const setKey = useAppStore((s) => s.set);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // Range selection state
  const [isSelectingRange, setIsSelectingRange] = useState(false);
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);

  // Assumed FPS for playback (30 fps default)
  const fps = 30;

  // Use video shape if available, otherwise infer from labeled frames
  const shapeFrames = video?.shape?.[0] ?? null;
  const inferredFrames = labels && video
    ? Math.max(0, ...labels.find({ video }).map((lf) => lf.frameIdx)) + 1
    : 0;
  const totalFrames = shapeFrames ?? (inferredFrames > 0 ? inferredFrames : 0);

  // Whether the selected graph is a heavy graph offloaded to the worker. Only
  // gated past the frame threshold; below it the synchronous path is fine.
  const useWorker =
    WORKER_GRAPHS.has(seekbarHeaderGraph) && totalFrames > WORKER_FRAME_THRESHOLD;

  // Synchronously-computed header statistic series for the selected graph type.
  // "none" and "instance-count" are drawn directly in the header effect and
  // return null here. Heavy graphs over the worker threshold also return null
  // (computed off-thread; see the worker effect below). overlayVersion is
  // intentionally in the deps so the series refreshes after labeling edits.
  const syncHeaderSeries = useMemo<Map<number, number> | null>(() => {
    if (!labels || !video) return null;
    if (seekbarHeaderGraph === "none" || seekbarHeaderGraph === "instance-count") {
      return null;
    }
    if (useWorker) return null;
    return computeStatisticSeries(labels, video, seekbarHeaderGraph, seekbarHeaderReduction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, video, seekbarHeaderGraph, seekbarHeaderReduction, overlayVersion, useWorker]);

  // Worker-computed series for heavy graphs over the frame threshold.
  const [workerHeaderSeries, setWorkerHeaderSeries] = useState<Map<number, number> | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  // Off-thread computation for heavy graphs over the frame threshold. A
  // monotonically-increasing request id guards against stale responses (e.g.
  // a slow earlier job resolving after the graph/reduction changed). The
  // worker is created lazily, reused across requests, and terminated on unmount.
  useEffect(() => {
    if (!useWorker || !labels || !video) {
      // Not in worker mode: drop any prior worker result so the sync path wins.
      setWorkerHeaderSeries(null);
      return;
    }

    // Extract plain, structured-clone-safe frame arrays (no sleap-io objects).
    const tracks = labels.tracks as unknown[];
    const frames: WorkerRequest["frames"] = [];
    for (const lf of labels.find({ video })) {
      const instances = lf.instances.map((inst) => {
        const track = (inst as { track?: unknown }).track ?? null;
        const trackIdx = track === null ? -1 : tracks.indexOf(track);
        const points = (inst as unknown as { numpy: () => number[][] }).numpy();
        return { trackIdx, points };
      });
      frames.push({ frameIdx: lf.frameIdx, instances });
    }

    const worker =
      workerRef.current ??
      (workerRef.current = new Worker(
        new URL("@/lib/statisticSeries.worker.ts", import.meta.url),
        { type: "module" },
      ));

    const reqId = ++requestIdRef.current;
    const handleMessage = (e: MessageEvent<WorkerResponse>) => {
      // Ignore responses superseded by a newer request.
      if (reqId !== requestIdRef.current) return;
      setWorkerHeaderSeries(new Map(e.data.entries));
    };
    worker.addEventListener("message", handleMessage);

    // Clear the previous graph's result so a heavy->heavy switch doesn't keep
    // drawing the stale polyline during the pending window (the request-id
    // guard already prevents committing superseded data).
    setWorkerHeaderSeries(null);

    const req: WorkerRequest = {
      graph: seekbarHeaderGraph as WorkerGraphType,
      reduction: seekbarHeaderReduction,
      trackCount: tracks.length,
      primaryNodeIdx: 0,
      frames,
    };
    worker.postMessage(req);

    return () => {
      // Invalidate this request and stop listening; the worker instance is
      // kept for reuse and only torn down on unmount (see effect below).
      worker.removeEventListener("message", handleMessage);
    };
  }, [useWorker, labels, video, seekbarHeaderGraph, seekbarHeaderReduction, overlayVersion]);

  // Terminate the worker on unmount.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // The series actually rendered: worker result when offloaded, else sync.
  const headerSeries = useWorker ? workerHeaderSeries : syncHeaderSeries;

  // Switch graph type; reset reduction to the new graph's default if the
  // current reduction is unsupported by it.
  const selectGraph = useCallback(
    (next: StatisticGraphType) => {
      setKey("seekbarHeaderGraph", next);
      const spec = getGraphSpec(next);
      if (
        spec &&
        spec.reductions.length > 0 &&
        !spec.reductions.includes(seekbarHeaderReduction)
      ) {
        setKey("seekbarHeaderReduction", spec.defaultReduction);
      }
    },
    [setKey, seekbarHeaderReduction]
  );

  const [isDragging, setIsDragging] = useState(false);
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);

  // Convert pixel X to frame index
  const pixelToFrame = useCallback(
    (clientX: number): number => {
      const canvas = canvasRef.current;
      if (!canvas || totalFrames === 0) return 0;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(ratio * (totalFrames - 1));
    },
    [totalFrames]
  );

  /** Find the nearest labeled frame within snap threshold pixels. */
  const snapToLabeledFrame = useCallback(
    (clientX: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas || !labels || !video || totalFrames === 0) return null;

      const rect = canvas.getBoundingClientRect();
      const clickX = clientX - rect.left;

      let closestFrame: number | null = null;
      let closestDist = Infinity;

      for (const lf of labels.labeledFrames) {
        if (lf.video !== video) continue;
        const frameX = (lf.frameIdx / (totalFrames - 1)) * rect.width;
        const dist = Math.abs(clickX - frameX);
        if (dist < closestDist && dist <= SNAP_THRESHOLD_PX) {
          closestDist = dist;
          closestFrame = lf.frameIdx;
        }
      }

      return closestFrame;
    },
    [labels, video, totalFrames]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      const frame = pixelToFrame(e.clientX);

      if (e.shiftKey) {
        // Start range selection anchored at the current frame
        const currentFrame = useAppStore.getState().frameIdx;
        setIsSelectingRange(true);
        setRangeAnchor(currentFrame);
        const start = Math.min(currentFrame, frame);
        const end = Math.max(currentFrame, frame);
        useAppStore.getState().set("frameRange", [start, end]);
        return;
      }

      // Snap to nearest labeled frame if close enough
      const snapped = snapToLabeledFrame(e.clientX);
      const targetFrame = snapped !== null ? snapped : frame;

      setFrameIdx(targetFrame);
      setIsDragging(true);
      // Clear range on normal click
      useAppStore.getState().set("frameRange", null);
    },
    [pixelToFrame, snapToLabeledFrame, setFrameIdx]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const frame = pixelToFrame(e.clientX);
      setHoverFrame(frame);

      if (isSelectingRange && rangeAnchor !== null) {
        const start = Math.min(rangeAnchor, frame);
        const end = Math.max(rangeAnchor, frame);
        useAppStore.getState().set("frameRange", [start, end]);
        return;
      }

      if (isDragging) {
        setFrameIdx(frame);
      }
    },
    [isDragging, isSelectingRange, rangeAnchor, pixelToFrame, setFrameIdx]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setIsSelectingRange(false);
    setRangeAnchor(null);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverFrame(null);
    setIsSelectingRange(false);
    setRangeAnchor(null);
  }, []);

  // Global mouse tracking during seekbar drag
  useEffect(() => {
    if (!isDragging) return;

    document.body.style.userSelect = "none";

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const frame = pixelToFrame(e.clientX);
      setFrameIdx(frame);
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);

    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [isDragging, pixelToFrame, setFrameIdx]);

  // Render instance count header graph
  useEffect(() => {
    const canvas = headerCanvasRef.current;
    const container = headerContainerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = HEADER_HEIGHT * window.devicePixelRatio;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    const w = rect.width;
    const h = HEADER_HEIGHT;

    ctx.clearRect(0, 0, w, h);

    if (totalFrames === 0 || !labels || !video) return;

    if (seekbarHeaderGraph === "instance-count") {
      // Build instance count per frame
      const currentVideo = video;
      let maxCount = 0;
      const counts = new Map<number, number>();
      for (const lf of labels.labeledFrames) {
        if (lf.video !== currentVideo) continue;
        counts.set(lf.frameIdx, lf.instances.length);
        if (lf.instances.length > maxCount) maxCount = lf.instances.length;
      }

      if (maxCount === 0) return;

      // Draw bar chart
      ctx.fillStyle = "rgba(100, 149, 237, 0.5)";
      for (const [fi, count] of counts) {
        const x = (fi / (totalFrames - 1)) * w;
        const barH = (count / maxCount) * h;
        ctx.fillRect(x, h - barH, Math.max(1, w / totalFrames), barH);
      }
      return;
    }

    if (seekbarHeaderGraph === "none" || !headerSeries) return;

    drawHeaderSeries(ctx, headerSeries, totalFrames, w, h);
  }, [totalFrames, labels, video, seekbarHeaderGraph, headerSeries]);

  // Render seekbar
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    const w = rect.width;
    const h = rect.height;

    // Background - matches card bg with subtle gradient
    ctx.fillStyle = "#141418";
    ctx.fillRect(0, 0, w, h);

    if (totalFrames === 0) return;

    const frameToX = (f: number) => (f / (totalFrames - 1)) * w;

    // Draw frame range selection
    if (frameRange) {
      const x1 = frameToX(frameRange[0]);
      const x2 = frameToX(frameRange[1]);
      ctx.fillStyle = "rgba(59, 130, 246, 0.25)";
      ctx.fillRect(x1, 0, x2 - x1, h);
    }

    // Draw track occupancy bars
    if (labels) {
      const tracks = labels.tracks;
      const trackBarHeight = Math.min(4, (h - 20) / Math.max(tracks.length, 1));

      tracks.forEach((track, trackIdx) => {
        const color = getPaletteColor(palette, trackIdx);
        ctx.fillStyle = rgbToCSS(color, 0.6);

        // Find frames where this track has instances
        for (const lf of labels.labeledFrames) {
          if (lf.video !== useAppStore.getState().video) continue;
          const hasTrack = lf.instances.some((inst) => inst.track === track);
          if (hasTrack) {
            const x = frameToX(lf.frameIdx);
            ctx.fillRect(x, trackIdx * trackBarHeight, Math.max(1, w / totalFrames), trackBarHeight - 1);
          }
        }
      });
    }

    // Draw suggestion frame marks (yellow ticks at top of seekbar)
    if (labels) {
      const currentVideo = useAppStore.getState().video;
      ctx.fillStyle = "rgba(250, 204, 21, 0.7)"; // yellow
      for (const sf of labels.suggestions ?? []) {
        if (sf.video !== currentVideo) continue;
        const x = frameToX(sf.frameIdx);
        ctx.fillRect(x - 0.5, 0, 1, 6);
      }
    }

    // Draw labeled frame marks
    if (labels) {
      const currentVideo = useAppStore.getState().video;
      for (const lf of labels.labeledFrames) {
        if (lf.video !== currentVideo) continue;
        const x = frameToX(lf.frameIdx);

        const hasUser = lf.instances.some((i) => !("score" in i));
        const hasPred = lf.instances.some((i) => "score" in i);

        if (hasUser) {
          ctx.fillStyle = "#3b82f6"; // blue
        } else if (hasPred) {
          ctx.fillStyle = "#67e8f9"; // light blue
        } else {
          ctx.fillStyle = "#666";
        }
        ctx.fillRect(x - 1, h - 14, 2, 10);
      }
    }

    // Draw current frame indicator
    const curX = frameToX(frameIdx);
    ctx.fillStyle = "#fff";
    ctx.fillRect(curX - 1, 0, 2, h);

    // Draw hover indicator
    if (hoverFrame !== null) {
      const hx = frameToX(hoverFrame);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(hx - 0.5, 0, 1, h);
    }
  }, [frameIdx, totalFrames, labels, palette, hoverFrame, video, frameRange]);

  // Playback animation loop
  useEffect(() => {
    if (!isPlaying) return;

    const interval = 1000 / (fps * playbackSpeed);
    lastTimeRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - lastTimeRef.current;
      if (elapsed >= interval) {
        lastTimeRef.current = now - (elapsed % interval);
        useAppStore.getState().incrementFrameIdx(1);
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, playbackSpeed, fps]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      // Trigger re-render
      useAppStore.getState().setFrameIdx(useAppStore.getState().frameIdx);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div className="flex flex-col shrink-0">
      {/* Instance count header graph - uses same flex layout as seekbar row for alignment */}
      <div className="flex items-center h-4 bg-card border-t border-border px-2 gap-2">
        <div className="w-24 shrink-0" />
        <div ref={headerContainerRef} className="flex-1 overflow-hidden">
          <canvas
            ref={headerCanvasRef}
            className="w-full h-full"
            style={{ display: "block" }}
          />
        </div>
        <div className="flex gap-1 shrink-0 items-center">
          {/* Graph-type picker */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="subtle"
                size="xs"
                className="h-4 text-[10px] text-muted-foreground px-1 max-w-40 truncate"
                title="Seekbar header graph"
              >
                {getGraphSpec(seekbarHeaderGraph)?.label ?? "None"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="end" side="top">
              <div className="flex flex-col">
                {GRAPH_SPECS.map((spec) => (
                  <Button
                    key={spec.type}
                    variant={spec.type === seekbarHeaderGraph ? "secondary" : "ghost"}
                    size="xs"
                    className="justify-start text-xs"
                    onClick={() => selectGraph(spec.type)}
                  >
                    {spec.label}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {/* Reduction picker (only when the chosen graph supports reductions) */}
          {(() => {
            const reductions = getGraphSpec(seekbarHeaderGraph)?.reductions ?? [];
            if (reductions.length === 0) return null;
            return (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="subtle"
                    size="xs"
                    className="h-4 text-[10px] text-muted-foreground px-1"
                    title="Reduction"
                  >
                    {seekbarHeaderReduction}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-1" align="end" side="top">
                  <div className="flex flex-col">
                    {reductions.map((r) => (
                      <Button
                        key={r}
                        variant={r === seekbarHeaderReduction ? "secondary" : "ghost"}
                        size="xs"
                        className="justify-center text-xs"
                        onClick={() => setKey("seekbarHeaderReduction", r)}
                      >
                        {r}
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            );
          })()}
        </div>
      </div>

      <div className="flex items-center h-10 bg-card border-t border-border px-2 gap-2">
        {/* Frame counter */}
        <div className="text-xs text-muted-foreground w-24 text-right tabular-nums shrink-0">
          {totalFrames > 0 ? `${frameIdx} / ${totalFrames - 1}` : "---"}
        </div>

        {/* Seekbar canvas */}
        <div
          ref={containerRef}
          className="flex-1 h-6 rounded cursor-pointer overflow-hidden"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            style={{ display: "block" }}
          />
        </div>

        {/* Transport controls */}
        <TooltipProvider delayDuration={300}>
          <div className="flex gap-0.5 shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="subtle"
                size="icon-xs"
                onClick={() => useAppStore.getState().setFrameIdx(0)}
              >
                <SkipBack />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Go to start (Home)</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="subtle"
                size="icon-xs"
                onClick={() => useAppStore.getState().incrementFrameIdx(-1)}
              >
                <ChevronLeft />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Previous frame (Left)</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isPlaying ? "default" : "subtle"}
                size="icon-xs"
                onClick={() => setIsPlaying(!isPlaying)}
              >
                {isPlaying ? <Pause /> : <Play />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>{isPlaying ? "Pause" : "Play"}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="subtle"
                size="icon-xs"
                onClick={() => useAppStore.getState().incrementFrameIdx(1)}
              >
                <ChevronRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Next frame (Right)</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="subtle"
                size="icon-xs"
                onClick={() => {
                  const { video } = useAppStore.getState();
                  const total = video?.shape?.[0] ?? 0;
                  if (total > 0) useAppStore.getState().setFrameIdx(total - 1);
                }}
              >
                <SkipForward />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Go to end (End)</p></TooltipContent>
          </Tooltip>
          {/* Speed selector */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="subtle"
                size="xs"
                className="text-[10px] text-muted-foreground tabular-nums w-8 px-0"
                title="Playback speed"
              >
                {playbackSpeed}x
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="end" side="top">
              <div className="flex flex-col">
                {PLAYBACK_SPEEDS.map((speed) => (
                  <Button
                    key={speed}
                    variant={speed === playbackSpeed ? "secondary" : "ghost"}
                    size="xs"
                    className="justify-center tabular-nums text-xs"
                    onClick={() => setPlaybackSpeed(speed)}
                  >
                    {speed}x
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        </TooltipProvider>
      </div>
    </div>
  );
}
