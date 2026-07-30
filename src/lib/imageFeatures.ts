/**
 * Image-features suggestion orchestrator (main thread).
 *
 * The ONLY suggestion method that decodes video frames. Per target video it:
 *   sample frame indices (seeded, reusing suggestionStrategies.sampleFrames)
 *   → decode each frame → crop to the video's ROI → downscale to the pixel cap
 *   (one canvas `drawImage`) → transfer the small RGBA buffers to the worker
 *   → cluster (imageFeaturesWorkerCore) → map picks to SuggestionFrames with a
 *   per-video cluster-group offset (mirrors PyQt's `group_offset`).
 *
 * The orchestration (sampling, group offsets, dedup, progress, cancellation) is
 * decoupled from I/O via injected `decode`/`runJob` so it is unit-testable; the
 * real canvas-decode and Web-Worker adapters below are thin and covered by E2E.
 */
import type { Labels, Video, SuggestionFrame } from "@/types";
import { sampleFrames, type SamplingMethod } from "./suggestionStrategies";
import { mulberry32 } from "./seededRng";
import { clampCropRect, capDimensions, type CropRect } from "./imageFeaturesCore";
import type {
  ImageFeaturesJob,
  ImageFeaturesResult,
  WorkerFrameBuffer,
} from "./imageFeaturesWorkerCore";

/** All user-facing generation parameters for the image-features method. */
export interface ImageFeaturesParams {
  /** Frames sampled per video before clustering (upper bound). */
  perVideo: number;
  sampleMethod: SamplingMethod;
  /** Long-side pixel cap applied after cropping (memory/perf bound). */
  scaleCap: number;
  pcaComponents: number;
  nClusters: number;
  perCluster: number;
  /** Reproducibility seed. */
  seed: number;
  /** Optional per-video ROI (session state); videos without one use the full frame. */
  roiByVideo?: Map<Video, CropRect>;
}

export type ProgressPhase = "decoding" | "clustering";

/** Injected I/O so the orchestration logic can be unit-tested with fakes. */
export interface ImageFeaturesDeps {
  decode: (
    video: Video,
    frameIdx: number,
    roi: CropRect | null,
    cap: number
  ) => Promise<WorkerFrameBuffer | null>;
  runJob: (job: ImageFeaturesJob) => Promise<ImageFeaturesResult>;
  onProgress?: (phase: ProgressPhase, done: number, total: number) => void;
  signal?: AbortSignal;
  /** RNG factory for sampling (default mulberry32); injectable for tests. */
  makeRng?: (seed: number) => () => number;
}

/**
 * Core orchestration (I/O injected). Returns deduped SuggestionFrames whose
 * `group` is `videoIdx * nClusters + clusterId` (stringified) so cluster ids
 * stay globally distinct across videos. Throws `AbortError` when `signal`
 * aborts (checked before each decode and before each clustering call).
 */
export async function generateImageFeatureSuggestions(
  labels: Labels,
  videos: Video[],
  params: ImageFeaturesParams,
  deps: ImageFeaturesDeps
): Promise<SuggestionFrame[]> {
  const rngFactory = deps.makeRng ?? mulberry32;
  const sampleRng = rngFactory(params.seed);

  // Sample all videos up front (one shared RNG stream → deterministic) so we
  // know the total frame count for the decoding progress bar.
  const perVideoSamples = videos.map((v) =>
    sampleFrames(labels, v, params.perVideo, params.sampleMethod, null, sampleRng)
  );
  const totalFrames = perVideoSamples.reduce((s, a) => s + a.length, 0);

  const throwIfAborted = () => {
    if (deps.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  throwIfAborted();

  let decoded = 0;
  const out: SuggestionFrame[] = [];
  const seen = new Map<Video, Set<number>>();

  for (let vi = 0; vi < videos.length; vi++) {
    const video = videos[vi];
    const roi = params.roiByVideo?.get(video) ?? null;

    const buffers: WorkerFrameBuffer[] = [];
    for (const frameIdx of perVideoSamples[vi]) {
      throwIfAborted();
      const buf = await deps.decode(video, frameIdx, roi, params.scaleCap);
      decoded++;
      deps.onProgress?.("decoding", decoded, totalFrames);
      if (buf) buffers.push(buf);
    }
    if (buffers.length === 0) continue;

    throwIfAborted();
    deps.onProgress?.("clustering", vi, videos.length);
    const result = await deps.runJob({
      frames: buffers,
      pcaComponents: params.pcaComponents,
      nClusters: params.nClusters,
      perCluster: params.perCluster,
      seed: params.seed,
    });

    const offset = vi * params.nClusters;
    for (const pick of result.picks) {
      let s = seen.get(video);
      if (!s) {
        s = new Set<number>();
        seen.set(video, s);
      }
      if (s.has(pick.frameIdx)) continue;
      s.add(pick.frameIdx);
      out.push({
        video,
        frameIdx: pick.frameIdx,
        group: String(offset + pick.group),
      } as SuggestionFrame);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real I/O adapters (thin glue — exercised by E2E, not unit tests).
// ---------------------------------------------------------------------------

/** Draw a decoded frame (whatever the backend yields) onto a full-size canvas. */
async function frameToCanvas(
  frame: unknown,
  video: Video
): Promise<OffscreenCanvas | null> {
  if (frame instanceof ImageBitmap) {
    const c = new OffscreenCanvas(frame.width, frame.height);
    c.getContext("2d")?.drawImage(frame, 0, 0);
    return c;
  }
  if (frame instanceof ImageData) {
    const c = new OffscreenCanvas(frame.width, frame.height);
    c.getContext("2d")?.putImageData(frame, 0, 0);
    return c;
  }
  if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
    const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
    const shape = video.shape;
    if (!shape) return null;
    const [, h, w] = shape;
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d")?.putImageData(
      new ImageData(new Uint8ClampedArray(bytes), w, h),
      0,
      0
    );
    return c;
  }
  // VideoFrame / other CanvasImageSource: universal (slower) fallback.
  try {
    const bmp = await createImageBitmap(frame as ImageBitmapSource);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close?.();
    return c;
  } catch {
    return null;
  }
}

/** Decode → crop (ROI) → downscale (cap) → RGBA buffer, in one canvas op. */
async function decodeFrameToBuffer(
  video: Video,
  frameIdx: number,
  roi: CropRect | null,
  cap: number
): Promise<WorkerFrameBuffer | null> {
  const frame = await (
    video as unknown as {
      getFrame: (i: number, o?: { prefetch?: boolean }) => Promise<unknown>;
    }
  ).getFrame(frameIdx, { prefetch: false });
  if (!frame) return null;

  const src = await frameToCanvas(frame, video);
  if (!src) return null;

  const clamped = roi ? clampCropRect(roi, src.width, src.height) : null;
  const sx = clamped?.x ?? 0;
  const sy = clamped?.y ?? 0;
  const sw = clamped?.width ?? src.width;
  const sh = clamped?.height ?? src.height;
  const { width: dw, height: dh } = capDimensions(sw, sh, cap);

  const dst = new OffscreenCanvas(dw, dh);
  const dctx = dst.getContext("2d", { willReadFrequently: true });
  if (!dctx) return null;
  dctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  const imageData = dctx.getImageData(0, 0, dw, dh);
  return { frameIdx, width: dw, height: dh, data: imageData.data };
}

/** Spawn the clustering worker and expose a one-shot-per-call `runJob`. */
function makeWorkerRunJob(): {
  runJob: (job: ImageFeaturesJob) => Promise<ImageFeaturesResult>;
  terminate: () => void;
} {
  const worker = new Worker(
    new URL("@/lib/imageFeatures.worker.ts", import.meta.url),
    { type: "module" }
  );
  const runJob = (job: ImageFeaturesJob) =>
    new Promise<ImageFeaturesResult>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
      };
      const onMsg = (e: MessageEvent<ImageFeaturesResult>) => {
        cleanup();
        resolve(e.data);
      };
      const onErr = (e: ErrorEvent) => {
        cleanup();
        reject(e.error ?? new Error(e.message));
      };
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", onErr);
      // Zero-copy transfer of the RGBA buffers (they are not reused after this).
      const transfer = job.frames.map((f) => f.data.buffer);
      worker.postMessage(job, transfer);
    });
  return { runJob, terminate: () => worker.terminate() };
}

/**
 * Public entry used by the Suggestions panel: wires the real canvas-decode and
 * Web-Worker adapters into {@link generateImageFeatureSuggestions}, and always
 * tears the worker down afterward.
 */
export async function runImageFeatureSuggestions(
  labels: Labels,
  videos: Video[],
  params: ImageFeaturesParams,
  opts: {
    onProgress?: (phase: ProgressPhase, done: number, total: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<SuggestionFrame[]> {
  const { runJob, terminate } = makeWorkerRunJob();
  try {
    return await generateImageFeatureSuggestions(labels, videos, params, {
      decode: decodeFrameToBuffer,
      runJob,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
  } finally {
    terminate();
  }
}
