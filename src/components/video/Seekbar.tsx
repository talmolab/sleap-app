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
import { navigableDomain, nearestFrameInDomain } from "@/lib/navigableFrames";
import {
  createSeriesCache,
  getOrComputeSeries,
  peekSeries,
  putSeries,
} from "@/lib/seriesCache";
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
  List,
  ListFilter,
  Images,
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
  const videoRevision = useAppStore((s) => s.videoRevision);
  const setKey = useAppStore((s) => s.set);
  const navigationDomain = useAppStore((s) => s.navigationDomain);
  const cycleNavigationDomain = useAppStore((s) => s.cycleNavigationDomain);

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

  // Use video shape if available, otherwise infer from labeled frames.
  // videoRevision is a dep so a deferred backend opening (which corrects
  // video.shape[0] to the true source count) re-extends the seekbar.
  const shapeFrames = useMemo(
    () => video?.shape?.[0] ?? null,
    [video, videoRevision]
  );
  const inferredFrames = labels && video
    ? Math.max(0, ...labels.find({ video }).map((lf) => lf.frameIdx)) + 1
    : 0;
  const totalFrames = shapeFrames ?? (inferredFrames > 0 ? inferredFrames : 0);

  // The active navigation domain (#137) for the current video, used to snap
  // seekbar clicks/drag in labeled/imaged mode. `null` (no restriction) is
  // coerced to `[]`. overlayVersion is in the deps so it refreshes after
  // labeling edits change the labeled set (labels is mutated in place, so its
  // reference alone won't trigger a recompute).
  const domainIndices = useMemo(
    () => navigableDomain(labels, video, navigationDomain) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, video, navigationDomain, overlayVersion]
  );
  // Confined navigation is active only when a concrete domain exists to visit.
  const isConfined = navigationDomain !== "all" && domainIndices.length > 0;

  // A video is "unavailable" when it has no backend and no embedded images
  // (e.g. an unresolved/missing external video) — no frame can be shown at all.
  const videoUnavailable =
    !!video && video.backend === null && !video.hasEmbeddedImages;

  // Tooltip for the transport mode button. The button stays visible and
  // cycleable in every mode; when a confined mode has nothing to visit it's
  // inert (navigation falls through to dense), and the tooltip says why so the
  // no-op is honest rather than silent.
  const navModeTooltip =
    navigationDomain === "all"
      ? "Navigate: all frames"
      : navigationDomain === "labeled"
        ? domainIndices.length === 0
          ? "Navigate: labeled frames only — none in this video yet"
          : "Navigate: labeled frames only"
        : domainIndices.length === 0
          ? videoUnavailable
            ? "Navigate: imaged frames only — no video available"
            : video?.hasEmbeddedImages
              ? "Navigate: imaged frames only — no embedded frames"
              : "Navigate: imaged frames only — all frames have images"
          : "Navigate: imaged frames only";

  // Whether the selected graph is a heavy graph offloaded to the worker. Only
  // gated past the frame threshold; below it the synchronous path is fine.
  const useWorker =
    WORKER_GRAPHS.has(seekbarHeaderGraph) && totalFrames > WORKER_FRAME_THRESHOLD;

  // Per-(video, graph, reduction) result cache so re-selecting a graph is
  // instant (issue #105 AC2). Invalidated on video change / label edit
  // (overlayVersion) inside the cache helper, so it never serves stale data.
  const seriesCacheRef = useRef(createSeriesCache());

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
    return getOrComputeSeries(
      seriesCacheRef.current,
      video,
      overlayVersion,
      `${seekbarHeaderGraph}|${seekbarHeaderReduction}`,
      () => computeStatisticSeries(labels, video, seekbarHeaderGraph, seekbarHeaderReduction),
    );
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

    // Cache hit: re-selecting a heavy graph is instant, no worker round-trip
    // (issue #105 AC2). Keyed by graph|reduction; invalidated on video/label change.
    const cacheKey = `${seekbarHeaderGraph}|${seekbarHeaderReduction}`;
    const cached = peekSeries(seriesCacheRef.current, video, overlayVersion, cacheKey);
    if (cached) {
      setWorkerHeaderSeries(cached);
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
      const series = new Map(e.data.entries);
      // Cache the result so re-selecting this heavy graph is instant.
      putSeries(seriesCacheRef.current, video, overlayVersion, cacheKey, series);
      setWorkerHeaderSeries(series);
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
  // While dragging, the solid playhead follows the cursor (this value) instead
  // of frameIdx, so it glides smoothly even while the image load lags behind on
  // a slow backend. null when not scrubbing → playhead tracks the loaded frame.
  const [scrubFrame, setScrubFrame] = useState<number | null>(null);

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
        // Skip empty LabeledFrames (no instances) — snapping to one would land
        // on a frame with no image (e.g. pkg.slp leftovers).
        if (lf.instances.length === 0) continue;
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

  // Resolve a scrub position. In "labeled frames only" mode (#137), snap to the
  // nearest labeled frame so clicks/drag never land in a dead gap; otherwise the
  // raw linear position. Falls back to raw when there are no labeled frames.
  const resolveScrubFrame = useCallback(
    (clientX: number): number => {
      const raw = pixelToFrame(clientX);
      if (!isConfined) return raw;
      return nearestFrameInDomain(domainIndices, raw) ?? raw;
    },
    [pixelToFrame, isConfined, domainIndices]
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

      // In a confined mode (#137) snap to the nearest in-domain frame;
      // otherwise the closest labeled frame within the threshold (existing).
      const targetFrame = isConfined
        ? resolveScrubFrame(e.clientX)
        : (snapToLabeledFrame(e.clientX) ?? frame);

      const curFrame = useAppStore.getState().frameIdx;
      setFrameIdx(targetFrame);
      setIsDragging(true);
      // Claim the scrub serialization gate for this first read — but only if it
      // actually changes the frame. Claiming when the frame is unchanged would
      // jam the gate: VideoPlayer's read effect only re-runs on a frameIdx
      // change, so nothing would clear it and the playhead would freeze until
      // release. The drag loop won't issue the next frame until it's cleared.
      if (targetFrame !== curFrame) {
        useAppStore.getState().set("frameLoading", true);
      }
      // Clear range on normal click
      useAppStore.getState().set("frameRange", null);
    },
    [pixelToFrame, snapToLabeledFrame, resolveScrubFrame, isConfined, setFrameIdx]
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
      // During a drag, frame updates are owned by the rAF-coalesced loop in the
      // isDragging effect below — it applies only the latest cursor position once
      // per animation frame. Calling setFrameIdx here too would re-introduce the
      // per-mousemove read pile-up we're trying to avoid.
    },
    [isSelectingRange, rangeAnchor, pixelToFrame]
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

  // Global mouse tracking during seekbar drag — serialized read loop.
  //
  // A cold ImageVideo frame loads in ~55 ms on a network mount (~18 reads/s
  // measured), but mousemove fires ~10x faster. Issuing setFrameIdx on every
  // move (or even once per animation frame) requests reads faster than the
  // mount can serve them, so they pile up and the painted frame trails the
  // cursor — fast OR slow drag.
  //
  // Instead we mirror PyQt SLEAP's video worker: never more than one read in
  // flight. Each animation frame we record only the latest cursor X, and issue
  // it ONLY when no read is loading (frameLoading is cleared by VideoPlayer when
  // the previous frame finishes). Intermediate positions we flew past are
  // dropped. The frame then tracks the cursor with one read of latency (~55 ms)
  // instead of an unbounded backlog, and a slow drag (moves slower than reads
  // complete) drops nothing.
  //
  // Scoped to drag only — single clicks, arrow-steps, and playback are
  // unchanged. Note: this can't beat the mount's ~18 frames/s on *cold* frames;
  // warm/prefetched frames load in ~0 ms and scrub at full rate.
  useEffect(() => {
    if (!isDragging) return;

    document.body.style.userSelect = "none";

    // Mark scrubbing. VideoPlayer reads this to (a) skip the expensive per-frame
    // histogram (OffscreenCanvas + getImageData ≈ 10 MB/frame, which can
    // OOM-crash the renderer at fast scrub rates) and (b) pass
    // getFrame({ prefetch: false }) so the backend skips its read-ahead window —
    // wasted while scrubbing (we jump past those frames) and ~3.6x slower
    // foreground reads under the 6-wide prefetch concurrency on a slow mount.
    useAppStore.getState().set("isScrubbing", true);

    let pendingX: number | null = null; // latest cursor position (coalesced)
    let lastIssuedX: number | null = null; // position we last issued a read for
    let lastScrubFrame: number | null = null; // last frame the bar glided to
    let rafId = 0;
    const tick = () => {
      if (pendingX !== null) {
        const cursorFrame = resolveScrubFrame(pendingX);
        // Smooth playhead: glide the bar to the cursor every frame, decoupled
        // from the gated image load below — so the bar follows even when the
        // backend can't decode that fast.
        if (cursorFrame !== lastScrubFrame) {
          lastScrubFrame = cursorFrame;
          setScrubFrame(cursorFrame);
        }
        // Gated image load: at most one read in flight, always the latest frame.
        if (pendingX !== lastIssuedX && !useAppStore.getState().frameLoading) {
          lastIssuedX = pendingX;
          // Only claim the gate + issue when the frame actually changes — issuing
          // the frame already showing wouldn't trigger a read to clear the gate,
          // jamming the loop.
          if (cursorFrame !== useAppStore.getState().frameIdx) {
            useAppStore.getState().set("frameLoading", true); // claim the slot now
            setFrameIdx(cursorFrame);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const handleGlobalMouseMove = (e: MouseEvent) => {
      pendingX = e.clientX; // only the latest position survives to the next tick
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);

    return () => {
      cancelAnimationFrame(rafId);
      // Scrub over — re-enable the per-frame histogram. Set before the flush
      // below so the final frame computes its histogram.
      useAppStore.getState().set("isScrubbing", false);
      // Apply the final cursor position so release lands exactly where the user
      // let go, even if it was mid-read when they released.
      if (pendingX !== null && pendingX !== lastIssuedX) {
        setFrameIdx(resolveScrubFrame(pendingX));
      }
      // Drag over: hand the playhead back to the loaded frame (frameIdx now
      // holds the release position, so the bar stays put — no backward jump).
      setScrubFrame(null);
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [isDragging, resolveScrubFrame, setFrameIdx]);

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

  // Precompute the seekbar header's static content (per-track occupied frames +
  // labeled-frame marks) ONCE per data change — NOT per frame. The draw effect
  // below re-runs on every frameIdx change (to move the 1px playhead); doing the
  // O(tracks × labeledFrames × instances) `.some()` scan there (with a
  // getState() per inner iteration) froze the UI for seconds on videos with many
  // labeled frames. A single pass + a track→index Map makes it O(frames ×
  // instances). overlayVersion is in the deps because labels is mutated in place.
  const headerData = useMemo(() => {
    if (!labels || !video) return null;
    const tracks = labels.tracks as unknown[];
    const trackIdxOf = new Map<unknown, number>(tracks.map((t, i) => [t, i]));
    const byTrack: number[][] = tracks.map(() => []);
    const marks: Array<[number, boolean]> = [];
    for (const lf of labels.find({ video })) {
      if (lf.instances.length === 0) continue;
      let hasUser = false;
      for (const inst of lf.instances) {
        const track = (inst as { track?: unknown }).track ?? null;
        const ti = track === null ? -1 : trackIdxOf.get(track) ?? -1;
        if (ti >= 0) byTrack[ti].push(lf.frameIdx);
        if (!("score" in (inst as object))) hasUser = true;
      }
      marks.push([lf.frameIdx, hasUser]);
    }
    return { byTrack, marks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, video, overlayVersion]);

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

    // Draw track occupancy bars (occupied frames precomputed per track).
    if (headerData) {
      const trackBarHeight = Math.min(4, (h - 20) / Math.max(headerData.byTrack.length, 1));
      const rectW = Math.max(1, w / totalFrames);
      headerData.byTrack.forEach((frameIdxs, trackIdx) => {
        ctx.fillStyle = rgbToCSS(getPaletteColor(palette, trackIdx), 0.6);
        const y = trackIdx * trackBarHeight;
        for (const f of frameIdxs) {
          ctx.fillRect(frameToX(f), y, rectW, trackBarHeight - 1);
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

    // Draw labeled frame marks (frame + user/predicted flag precomputed).
    if (headerData) {
      for (const [f, hasUser] of headerData.marks) {
        ctx.fillStyle = hasUser ? "#3b82f6" : "#67e8f9"; // blue user / light-blue predicted
        ctx.fillRect(frameToX(f) - 1, h - 14, 2, 10);
      }
    }

    // Draw current frame indicator. While scrubbing, follow the cursor
    // (scrubFrame) so the bar glides smoothly even if the image load lags;
    // otherwise track the actually-loaded frame.
    const curX = frameToX(scrubFrame ?? frameIdx);
    ctx.fillStyle = "#fff";
    ctx.fillRect(curX - 1, 0, 2, h);

    // Draw hover indicator — suppressed during a drag, where the solid bar
    // already sits at the cursor (otherwise the two lines overlap).
    if (hoverFrame !== null && scrubFrame === null) {
      const hx = frameToX(hoverFrame);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(hx - 0.5, 0, 1, h);
    }
  }, [frameIdx, scrubFrame, totalFrames, headerData, labels, palette, hoverFrame, video, frameRange]);

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
    <div className="grid grid-cols-[1fr_auto] shrink-0">
      {/* Instance count header graph - subgrid aligns canvas with seekbar below */}
      <div className="grid grid-cols-subgrid col-span-full items-center h-4 bg-card border-t border-border px-2 gap-2">
        <div ref={headerContainerRef} className="overflow-hidden min-w-0">
          <canvas
            ref={headerCanvasRef}
            className="w-full h-full"
            style={{ display: "block" }}
          />
        </div>
        <div className="flex gap-1 shrink-0 items-center justify-self-end">
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

      <div className="grid grid-cols-subgrid col-span-full items-center h-10 bg-card border-t border-border px-2 gap-2">
        {/* Seekbar canvas */}
        <div
          ref={containerRef}
          className="h-6 rounded cursor-pointer overflow-hidden min-w-0"
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
          {/* Tri-state navigation domain: All -> Labeled -> Imaged (#137) */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={navigationDomain !== "all" ? "default" : "subtle"}
                size="icon-xs"
                aria-label={navModeTooltip}
                onClick={() => cycleNavigationDomain()}
              >
                {navigationDomain === "all" ? (
                  <List />
                ) : navigationDomain === "labeled" ? (
                  <ListFilter />
                ) : (
                  <Images />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>{navModeTooltip}</p></TooltipContent>
          </Tooltip>
          <div className="w-px h-4 bg-border mx-0.5" />
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
