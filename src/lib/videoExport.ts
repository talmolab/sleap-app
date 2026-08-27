/**
 * Rendered labeled-clip export — PURE core (video-with-overlay → mp4).
 *
 * Parity target: PyQt SLEAP's `File → Export labeled clip` (`save_labeled_video`
 * / `VideoWriter`). For each frame in a range of the current video we decode the
 * frame, composite the skeleton/instance overlay on top (reusing
 * {@link renderInstances}), and encode the result to an H.264 mp4.
 *
 * This module holds the dependency-light pieces (frame-range validation,
 * output-size / filename derivation, timeline planning, the capability-gate
 * decision, the instance→overlay mapping, and the injected-seam orchestrator
 * {@link runClipExport}) — all unit-tested here. The mediabunny/WebCodecs-backed
 * encoder + decode adapters live in `videoExportPipeline.ts` (lazy-loaded by the
 * dialog so mediabunny stays out of the app-startup bundle). None of that real
 * pipeline runs under the bun/happy-dom test runner, so end-to-end encode is
 * verified manually / via tauri-pilot.
 */

import { PredictedInstance } from "@talmolab/sleap-io.js";
import {
  renderInstances,
  type RenderedInstance,
  type RenderedNode,
  type RenderOptions,
} from "@/canvas/SkeletonRenderer";
import { getInstanceColor, getPaletteColor, resolveColorTarget } from "@/lib/colorPalettes";
import { toImageCoords } from "@/lib/cropTransform";
import type { Instance, Track, Video } from "@/types";

/** The codec used for clip export. `avc` is H.264 (universally playable mp4). */
export const CLIP_EXPORT_CODEC = "avc" as const;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** A validated, inclusive frame range within a video. */
export interface FrameRange {
  /** First frame index (inclusive). */
  start: number;
  /** Last frame index (inclusive). */
  end: number;
  /** Number of frames = end - start + 1. */
  count: number;
}

export type FrameRangeResult =
  | { ok: true; range: FrameRange }
  | { ok: false; error: string };

/**
 * Validate + clamp a user-entered frame range against a video's frame count.
 * Both `start` and `end` are inclusive. Out-of-range values are clamped into
 * `[0, totalFrames - 1]`; NaN or an inverted range (start > end) is rejected
 * with an actionable message. Pure — the dialog and the command both call this.
 */
export function resolveClipFrameRange(
  startInput: number,
  endInput: number,
  totalFrames: number
): FrameRangeResult {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    return { ok: false, error: "This video has no frames to export." };
  }
  if (!Number.isFinite(startInput) || !Number.isFinite(endInput)) {
    return { ok: false, error: "Enter numeric start and end frames." };
  }
  const maxFrame = Math.floor(totalFrames) - 1;
  const start = Math.max(0, Math.min(maxFrame, Math.floor(startInput)));
  const end = Math.max(0, Math.min(maxFrame, Math.floor(endInput)));
  if (start > end) {
    return { ok: false, error: "Start frame must be less than or equal to end frame." };
  }
  return { ok: true, range: { start, end, count: end - start + 1 } };
}

/**
 * Initial [start, end] to seed the Export Clip dialog. Uses the active timeline
 * selection (`frameRange`, 0-based inclusive) when present, otherwise the whole
 * video. Sorts + floors + clamps to [0, nFrames-1] so a reverse drag or a
 * stale/out-of-range selection can never produce an invalid initial range. Pure.
 */
export function computeInitialClipRange(
  frameRange: readonly [number, number] | null | undefined,
  nFrames: number
): { start: number; end: number } {
  const maxIdx = Math.max(0, Math.floor(nFrames) - 1);
  if (!frameRange) return { start: 0, end: maxIdx };
  const clamp = (n: number) => Math.max(0, Math.min(Math.floor(n), maxIdx));
  const a = clamp(frameRange[0]);
  const b = clamp(frameRange[1]);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * Map a pixel x on a scrubbar track of width `trackPx` to a frame index in
 * [0, len-1]. Clamps out-of-track pixels; returns 0 for a single-frame video
 * or a zero-width track. Pure — used by the export preview scrubbar.
 */
export function pixelToFrame(px: number, trackPx: number, len: number): number {
  if (len <= 1 || trackPx <= 0) return 0;
  const frac = Math.max(0, Math.min(1, px / trackPx));
  return Math.max(0, Math.min(len - 1, Math.round(frac * (len - 1))));
}

/**
 * Inverse of {@link pixelToFrame}: the pixel x for a frame on a track of width
 * `trackPx`. Returns 0 for a single-frame video. Pure.
 */
export function frameToPixel(frame: number, trackPx: number, len: number): number {
  if (len <= 1) return 0;
  const f = Math.max(0, Math.min(len - 1, frame));
  return (f / (len - 1)) * trackPx;
}

/**
 * Clamp a dragged in/out handle to a valid frame. The "start" handle is confined
 * to [0, end]; the "end" handle to [start, len-1]. Floored to whole frames. Pure.
 */
export function clampHandleDrag(
  endpoint: "start" | "end",
  value: number,
  bounds: { start: number; end: number; len: number }
): number {
  const v = Math.floor(value);
  if (endpoint === "start") return Math.max(0, Math.min(v, bounds.end));
  return Math.max(bounds.start, Math.min(v, bounds.len - 1));
}

// ---------------------------------------------------------------------------
// Multi-video export config + reducer (per-video ranges & settings)
// ---------------------------------------------------------------------------

/** Per-video export configuration — every setting is per-video (by design). */
export interface ClipConfig {
  video: Video;
  include: boolean;
  start: number;
  end: number;
  fps: number;
  scale: number;
  background: ClipBackground;
}

/** The export dialog's per-video state: one config per video + which is focused. */
export interface ClipExportState {
  configs: ClipConfig[];
  focused: Video | null;
}

/** Actions for {@link clipExportReducer}. */
export type ClipExportAction =
  | { type: "focus"; video: Video }
  | { type: "toggleInclude"; video: Video }
  | { type: "setAllIncluded"; include: boolean }
  | { type: "setRange"; video: Video; start: number; end: number }
  | { type: "setFps"; video: Video; fps: number }
  | { type: "setScale"; video: Video; scale: number }
  | { type: "setBackground"; video: Video; background: ClipBackground }
  | { type: "reset"; state: ClipExportState };

/**
 * Seed per-video export configs: the current video is included + focused with
 * its range seeded from the timeline selection (via {@link computeInitialClipRange});
 * every other video defaults to its whole range and is unchecked. fps defaults
 * to the video's native rate (fallback 30). Pure.
 */
export function buildInitialClipConfigs(
  videos: readonly Video[],
  currentVideo: Video | null,
  frameRange: readonly [number, number] | null
): ClipExportState {
  const configs: ClipConfig[] = videos.map((video) => {
    const len = video.shape?.[0] ?? 0;
    const isCurrent = video === currentVideo;
    const { start, end } = isCurrent
      ? computeInitialClipRange(frameRange, len)
      : { start: 0, end: Math.max(0, len - 1) };
    const fps = video.fps && video.fps > 0 ? Math.round(video.fps) : 30;
    return {
      video,
      include: isCurrent,
      start,
      end,
      fps,
      scale: 1,
      background: "original" as ClipBackground,
    };
  });
  return { configs, focused: currentVideo ?? videos[0] ?? null };
}

/** Pure reducer for the export dialog's per-video config state. */
export function clipExportReducer(
  state: ClipExportState,
  action: ClipExportAction
): ClipExportState {
  const patch = (video: Video, fields: Partial<ClipConfig>): ClipExportState => ({
    ...state,
    configs: state.configs.map((c) => (c.video === video ? { ...c, ...fields } : c)),
  });
  switch (action.type) {
    case "focus":
      return { ...state, focused: action.video };
    case "setAllIncluded":
      return { ...state, configs: state.configs.map((c) => ({ ...c, include: action.include })) };
    case "toggleInclude":
      return {
        ...state,
        configs: state.configs.map((c) =>
          c.video === action.video ? { ...c, include: !c.include } : c
        ),
      };
    case "setRange":
      return patch(action.video, { start: action.start, end: action.end });
    case "setFps":
      return patch(action.video, { fps: action.fps });
    case "setScale":
      return patch(action.video, { scale: action.scale });
    case "setBackground":
      return patch(action.video, { background: action.background });
    case "reset":
      return action.state;
    default:
      return state;
  }
}

/** Per-video status during a batch export. */
export type ClipJobStatus = "queued" | "encoding" | "done" | "error" | "cancelled";

/** Injected side-effects for {@link runClipExportBatch} (real encode/save, or fakes in tests). */
export interface ClipBatchDeps {
  /** Encode one config's clip → mp4 bytes (throws ClipExportCancelled on cancel). */
  exportOne: (
    config: ClipConfig,
    cb: { signal: AbortSignal; onProgress: (done: number, total: number) => void }
  ) => Promise<Uint8Array>;
  /** Persist one config's bytes; returns a path/name, or null if it couldn't be saved. */
  saveOne: (config: ClipConfig, bytes: Uint8Array) => Promise<string | null>;
  /** Report a per-video status transition. */
  onStatus: (
    video: Video,
    status: ClipJobStatus,
    extra?: { progress?: { done: number; total: number }; error?: string }
  ) => void;
  /** Abort signal for the whole batch (Cancel). */
  signal: AbortSignal;
}

/** Outcome tally for a batch export. */
export interface ClipBatchSummary {
  done: number;
  failed: number;
  cancelled: number;
}

/**
 * Export the INCLUDED configs one at a time (sequential — one encoder at a
 * time). A failed video is isolated (marked error, the batch continues); a
 * cancelled video (ClipExportCancelled, or an already-aborted signal) cancels
 * the rest. Pure orchestration — all encoding/saving is injected via
 * {@link ClipBatchDeps}, so the sequencing/isolation/cancel logic is testable
 * with fakes.
 */
export async function runClipExportBatch(
  configs: readonly ClipConfig[],
  deps: ClipBatchDeps
): Promise<ClipBatchSummary> {
  const included = configs.filter((c) => c.include);
  const summary: ClipBatchSummary = { done: 0, failed: 0, cancelled: 0 };
  let aborted = false;
  for (const config of included) {
    if (aborted || deps.signal.aborted) {
      deps.onStatus(config.video, "cancelled");
      summary.cancelled++;
      continue;
    }
    deps.onStatus(config.video, "encoding", { progress: { done: 0, total: 0 } });
    try {
      const bytes = await deps.exportOne(config, {
        signal: deps.signal,
        onProgress: (done, total) =>
          deps.onStatus(config.video, "encoding", { progress: { done, total } }),
      });
      const saved = await deps.saveOne(config, bytes);
      if (saved === null) {
        deps.onStatus(config.video, "error", { error: "Could not save the exported clip." });
        summary.failed++;
      } else {
        deps.onStatus(config.video, "done");
        summary.done++;
      }
    } catch (err) {
      const cancelled =
        err instanceof ClipExportCancelled ||
        (err instanceof Error && err.name === "ClipExportCancelled");
      if (cancelled) {
        deps.onStatus(config.video, "cancelled");
        summary.cancelled++;
        aborted = true;
      } else {
        deps.onStatus(config.video, "error", {
          error: err instanceof Error ? err.message : String(err),
        });
        summary.failed++;
      }
    }
  }
  return summary;
}

/** Output dimensions in pixels for a given scale factor. */
export interface OutputDimensions {
  width: number;
  height: number;
}

/**
 * Scale source dimensions by `scale`, rounding each side to an EVEN number
 * (H.264 / yuv420p requires even width & height) with a floor of 2. Pure.
 */
export function computeClipOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
  scale: number
): OutputDimensions {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2);
  return { width: even(sourceWidth), height: even(sourceHeight) };
}

/** Minimum / maximum allowed clip scale factor (no upscaling — PyQt parity). */
export const CLIP_SCALE_MIN = 0.1;
export const CLIP_SCALE_MAX = 1.0;

/**
 * Clamp a user-entered scale factor to `[CLIP_SCALE_MIN, CLIP_SCALE_MAX]`.
 * PyQt SLEAP's export never upscales, so values above 1.0 are capped at 1.0 and
 * values below 0.1 are raised to 0.1. A non-finite input falls back to 1.0. Pure.
 */
export function clampClipScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(CLIP_SCALE_MAX, Math.max(CLIP_SCALE_MIN, scale));
}

/**
 * Determine the channel count of a raw single-frame byte buffer. Prefers the
 * video's declared channel dimension (`shape[3]`); otherwise infers it from the
 * byte length divided by `width*height`. Only 1 (grayscale), 3 (RGB) and 4
 * (RGBA) are recognised; anything else falls back to 1 (grayscale). Pure.
 */
export function inferFrameChannels(
  byteLength: number,
  width: number,
  height: number,
  declaredChannels?: number | null
): number {
  if (
    declaredChannels === 1 ||
    declaredChannels === 3 ||
    declaredChannels === 4
  ) {
    return declaredChannels;
  }
  const px = width * height;
  if (px > 0 && byteLength % px === 0) {
    const c = byteLength / px;
    if (c === 1 || c === 3 || c === 4) return c;
  }
  return 1;
}

/**
 * Expand raw single-frame pixel bytes (grayscale / RGB / RGBA) into a tightly
 * packed RGBA `Uint8ClampedArray` of length `width*height*4`, ready for
 * `ImageData`. Grayscale (1ch) replicates the single value across R/G/B and sets
 * alpha 255; RGB (3ch) copies R/G/B and sets alpha 255; RGBA (4ch) is copied
 * through. Guards against a short input by treating missing samples as 0. Pure —
 * this is the fix for the earlier RGBA-only assumption that threw / produced
 * garbage for grayscale and RGB sources.
 */
export function expandFrameBytesToRGBA(
  bytes: Uint8Array,
  width: number,
  height: number,
  channels: number
): Uint8ClampedArray {
  const px = Math.max(0, width) * Math.max(0, height);
  const out = new Uint8ClampedArray(px * 4);
  if (channels === 4) {
    out.set(bytes.subarray(0, Math.min(bytes.length, px * 4)));
    return out;
  }
  if (channels === 3) {
    for (let i = 0; i < px; i++) {
      const s = i * 3;
      const d = i * 4;
      out[d] = bytes[s] ?? 0;
      out[d + 1] = bytes[s + 1] ?? 0;
      out[d + 2] = bytes[s + 2] ?? 0;
      out[d + 3] = 255;
    }
    return out;
  }
  // Grayscale (1ch) or any unexpected count: broadcast the single sample.
  for (let i = 0; i < px; i++) {
    const v = bytes[i] ?? 0;
    const d = i * 4;
    out[d] = v;
    out[d + 1] = v;
    out[d + 2] = v;
    out[d + 3] = 255;
  }
  return out;
}

/** Clip-export background choices surfaced in the dialog (PyQt parity). */
export type ClipBackground = "original" | "black" | "white" | "grey";

/**
 * Map a {@link ClipBackground} choice to the CSS colour painted behind each
 * frame (`params.background`). `"original"` returns `undefined` so the core keeps
 * its default (the video frame shows through; gaps are black). Pure.
 */
export function clipBackgroundColor(bg: ClipBackground): string | undefined {
  switch (bg) {
    case "black":
      return "#000000";
    case "white":
      return "#ffffff";
    case "grey":
      return "#808080";
    default:
      return undefined;
  }
}

/**
 * Derive the suggested `.mp4` filename for a clip, from the project filename and
 * the exported range: `labels.clip_10-20.mp4`. Strips a trailing `.slp`/`.json`;
 * falls back to `labels` when there's no project filename. Pure.
 */
export function deriveClipFilename(
  projectFilename: string | null | undefined,
  range: { start: number; end: number },
  videoLabel?: string
): string {
  const base = projectFilename
    ? projectFilename.replace(/\.(slp|json)$/i, "")
    : "labels";
  // Optional per-video segment (batch export): strip the video's extension and
  // sanitize to filename-safe chars so `<project>.<video>.clip_<a>-<b>.mp4`.
  const vid = videoLabel
    ? "." + videoLabel.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_")
    : "";
  return `${base}${vid}.clip_${range.start}-${range.end}.mp4`;
}

/** A single planned output frame: which source frame, and its mp4 timestamp. */
export interface ClipTimelineEntry {
  /** Source video frame index to decode. */
  frameIdx: number;
  /** Presentation timestamp in seconds. */
  timestamp: number;
  /** Frame duration in seconds. */
  duration: number;
}

/**
 * Expand a frame range into an ordered timeline of `{frameIdx, timestamp,
 * duration}` at a target `fps`. Timestamps are `i / fps` seconds; every frame is
 * emitted (no dropping). Pure — the encode loop consumes this.
 */
export function planClipTimeline(
  range: FrameRange,
  fps: number
): ClipTimelineEntry[] {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const dur = 1 / rate;
  const out: ClipTimelineEntry[] = [];
  for (let i = 0; i < range.count; i++) {
    out.push({
      frameIdx: range.start + i,
      timestamp: i * dur,
      duration: dur,
    });
  }
  return out;
}

/** Outcome of probing whether this environment can encode the clip. */
export interface EncodeSupport {
  supported: boolean;
  /** Human-readable reason (shown when unsupported). */
  message: string;
}

/** Message shown when H.264 mp4 encoding isn't available (e.g. Linux WebKitGTK). */
export const CLIP_EXPORT_UNSUPPORTED_MESSAGE =
  "Video export isn't supported in this environment. H.264 encoding is unavailable " +
  "(this is expected on Linux, where the required system codec is missing).";

/** Capability-probe signature (mediabunny's `canEncodeVideo`, injected). */
export type CanEncodeVideoProbe = (
  codec: string,
  options?: { width?: number; height?: number }
) => Promise<boolean>;

/**
 * Decide whether a clip can be encoded here, by calling mediabunny's
 * `canEncodeVideo` capability probe up front (injected so the decision is
 * unit-testable without WebCodecs). Any thrown error is treated as unsupported
 * rather than crashing the export. Pure w.r.t. the injected `probe`.
 */
export async function evaluateClipEncodeSupport(
  probe: CanEncodeVideoProbe,
  dims: { width: number; height: number }
): Promise<EncodeSupport> {
  try {
    const ok = await probe(CLIP_EXPORT_CODEC, {
      width: dims.width,
      height: dims.height,
    });
    return ok
      ? { supported: true, message: "" }
      : { supported: false, message: CLIP_EXPORT_UNSUPPORTED_MESSAGE };
  } catch {
    return { supported: false, message: CLIP_EXPORT_UNSUPPORTED_MESSAGE };
  }
}

/** Options controlling how instances are coloured/mapped for a clip. */
export interface BuildOverlayOptions {
  palette: string;
  distinctlyColor: string;
  colorPredicted: boolean;
  showNonVisibleNodes: boolean;
  tracks: Track[];
  video: Video | null;
  /** Whether any instance in the project has an assigned track — resolves
   * distinctlyColor === "auto" to "track" vs "node". */
  projectHasTracks?: boolean;
}

/**
 * Build {@link RenderedInstance}s for one frame's instances, mirroring the
 * mapping VideoPlayer does for the live overlay (colours, per-node/edge colours,
 * crop-aware image coords) but WITHOUT the interactive concerns (selection,
 * per-instance QC hide/solo). For the MVP every instance renders visible; the
 * `showNonVisible` flag follows the global setting. Pure + decoder-independent.
 */
export function buildExportRenderedInstances(
  instances: readonly Instance[],
  opts: BuildOverlayOptions
): RenderedInstance[] {
  const resolvedColorTarget = resolveColorTarget(
    opts.distinctlyColor,
    opts.projectHasTracks ?? false
  );
  const frameInstanceTracks = instances.map((inst) => inst.track);
  return instances.map((inst, idx) => {
    const isPredicted = inst instanceof PredictedInstance;
    const skeleton = inst.skeleton;
    const color = getInstanceColor(
      opts.palette,
      opts.distinctlyColor,
      idx,
      inst.track,
      opts.tracks,
      isPredicted,
      opts.colorPredicted,
      opts.projectHasTracks ?? false,
      frameInstanceTracks
    );

    const paint = !(isPredicted && !opts.colorPredicted);
    const nodeColors =
      resolvedColorTarget === "node" && paint
        ? skeleton.nodes.map((_, nIdx) => getPaletteColor(opts.palette, nIdx))
        : undefined;

    const edgeIndices = skeleton.edgeIndices;
    const edgeColors =
      resolvedColorTarget === "edge" && paint
        ? edgeIndices.map((_, eIdx) => getPaletteColor(opts.palette, eIdx))
        : undefined;

    const nodes: RenderedNode[] = inst.points.map((point, nIdx) => {
      const [nx, ny] = toImageCoords(opts.video, point.xy[0], point.xy[1]);
      return {
        x: nx,
        y: ny,
        visible: point.visible && !isNaN(point.xy[0]),
        complete: point.complete,
        name: skeleton.nodes[nIdx]?.name ?? `node_${nIdx}`,
        score: point.score,
      };
    });

    const edges = edgeIndices.map(([srcIdx, dstIdx]) => ({ srcIdx, dstIdx }));

    return {
      nodes,
      edges,
      color,
      nodeColors,
      edgeColors,
      isPredicted,
      isSelected: false,
      trackName: inst.track?.name ?? null,
      score: isPredicted ? (inst as PredictedInstance).score : undefined,
      visible: true,
      showNonVisible: opts.showNonVisibleNodes,
    };
  });
}

// ---------------------------------------------------------------------------
// Orchestrator (real pipeline; seams injected for a thin integration test)
// ---------------------------------------------------------------------------

/** A minimal encoder abstraction so the loop can be tested with a fake. */
export interface ClipEncoder {
  /** Prepare the encoder/muxer (mediabunny `Output.start`). */
  start(): Promise<void>;
  /** Capture the current canvas state as a frame at `timestamp` (seconds). */
  addFrame(timestamp: number, duration: number): Promise<void>;
  /** Finish and return the encoded mp4 bytes. */
  finalize(): Promise<Uint8Array>;
  /** Abort and release resources (best-effort; never throws). */
  cancel(): Promise<void>;
}

/** The 2D-context surface the encode loop draws into (subset of the real ctx). */
export interface ClipDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** Injected side-effecting seams for {@link runClipExport}. */
export interface ClipExportDeps {
  /** Decode one source frame into a drawable image, or null if unavailable. */
  decodeFrame: (frameIdx: number) => Promise<CanvasImageSource | null>;
  /** The overlay instances (image-space) for a given source frame. */
  overlayForFrame: (frameIdx: number) => RenderedInstance[];
  /** The output drawing context (sized to the output dimensions). */
  ctx: ClipDrawContext;
  /** Build the encoder bound to the output canvas. */
  encoder: ClipEncoder;
  /**
   * Draw the overlay onto the context. Defaults to {@link renderInstances};
   * injected so the integration test can stub it (the real renderer needs a
   * full 2D context that happy-dom doesn't provide).
   */
  renderOverlay?: (
    ctx: CanvasRenderingContext2D,
    instances: RenderedInstance[],
    opts: Partial<RenderOptions>
  ) => void;
}

/** Parameters describing the clip to encode. */
export interface ClipExportParams {
  range: FrameRange;
  fps: number;
  scale: number;
  sourceWidth: number;
  sourceHeight: number;
  output: OutputDimensions;
  renderOptions: Omit<RenderOptions, "zoom">;
  /** CSS colour painted before the frame (shows through where a frame is missing). */
  background?: string;
}

/** Progress + cancellation callbacks. */
export interface ClipExportCallbacks {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Thrown when the user cancels an in-progress export. */
export class ClipExportCancelled extends Error {
  constructor() {
    super("Clip export cancelled");
    this.name = "ClipExportCancelled";
  }
}

/**
 * Encode a labeled clip: for each frame in `params.range`, decode → draw the
 * (scaled) video frame → composite the skeleton overlay → hand the canvas to the
 * encoder, then finalize to mp4 bytes. Honours `signal` for cancellation and
 * reports progress after each frame. The heavy lifting (decode, canvas, encoder)
 * is injected via {@link ClipExportDeps}; {@link buildClipExportPipeline} wires
 * the real browser/WebCodecs implementations.
 */
export async function runClipExport(
  params: ClipExportParams,
  deps: ClipExportDeps,
  callbacks: ClipExportCallbacks = {}
): Promise<Uint8Array> {
  const { range, scale, sourceWidth, sourceHeight, output } = params;
  const timeline = planClipTimeline(range, params.fps);
  const render = deps.renderOverlay ?? renderInstances;
  const background = params.background ?? "#000000";
  const ctx = deps.ctx;

  const abort = () => callbacks.signal?.aborted === true;

  try {
    if (abort()) throw new ClipExportCancelled();
    await deps.encoder.start();

    for (let i = 0; i < timeline.length; i++) {
      if (abort()) throw new ClipExportCancelled();

      const { frameIdx, timestamp, duration } = timeline[i];
      const frame = await deps.decodeFrame(frameIdx);

      if (abort()) throw new ClipExportCancelled();

      // Background (identity transform), then the frame scaled to fill output.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, output.width, output.height);
      if (frame) {
        ctx.drawImage(
          frame,
          0,
          0,
          sourceWidth,
          sourceHeight,
          0,
          0,
          output.width,
          output.height
        );
      }

      // Overlay in source-pixel space, scaled to output. `zoom: scale` keeps
      // marker/edge/label sizes visually constant regardless of the scale
      // factor (renderInstances divides sizes by zoom), matching the on-canvas
      // look.
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      render(ctx as unknown as CanvasRenderingContext2D, deps.overlayForFrame(frameIdx), {
        ...params.renderOptions,
        zoom: scale,
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      await deps.encoder.addFrame(timestamp, duration);
      callbacks.onProgress?.(i + 1, timeline.length);
    }

    return await deps.encoder.finalize();
  } catch (err) {
    await deps.encoder.cancel();
    throw err;
  }
}
