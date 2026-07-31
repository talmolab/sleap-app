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
import { getInstanceColor, getPaletteColor } from "@/lib/colorPalettes";
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

/**
 * Derive the suggested `.mp4` filename for a clip, from the project filename and
 * the exported range: `labels.clip_10-20.mp4`. Strips a trailing `.slp`/`.json`;
 * falls back to `labels` when there's no project filename. Pure.
 */
export function deriveClipFilename(
  projectFilename: string | null | undefined,
  range: { start: number; end: number }
): string {
  const base = projectFilename
    ? projectFilename.replace(/\.(slp|json)$/i, "")
    : "labels";
  return `${base}.clip_${range.start}-${range.end}.mp4`;
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
      opts.colorPredicted
    );

    const paint = !(isPredicted && !opts.colorPredicted);
    const nodeColors =
      opts.distinctlyColor === "node" && paint
        ? skeleton.nodes.map((_, nIdx) => getPaletteColor(opts.palette, nIdx))
        : undefined;

    const edgeIndices = skeleton.edgeIndices;
    const edgeColors =
      opts.distinctlyColor === "edge" && paint
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
