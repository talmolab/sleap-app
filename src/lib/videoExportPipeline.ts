/**
 * Rendered labeled-clip export — mediabunny/WebCodecs pipeline.
 *
 * The browser/Tauri-only half of clip export: the real MP4 encoder (mediabunny
 * {@link CanvasSource} → {@link Output}(Mp4) → {@link BufferTarget}), the
 * `video.getFrame` decode adapter, and the live `canEncodeVideo` capability
 * probe. Kept separate from `videoExport.ts` (the pure core) and lazy-loaded by
 * the Export-Clip dialog so mediabunny (a sizeable WebCodecs wrapper) stays out
 * of the app-startup bundle. None of this runs under the bun/happy-dom test
 * runner — it's verified manually / via tauri-pilot.
 */

import {
  canEncodeVideo,
  CanvasSource,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
  type VideoCodec,
} from "mediabunny";
import type { Video } from "@/types";
import type { RenderedInstance } from "@/canvas/SkeletonRenderer";
import { clearFullRangeTag, isWebKitEncoder } from "@/lib/h264RangeTag";
import {
  CLIP_EXPORT_CODEC,
  expandFrameBytesToRGBA,
  inferFrameChannels,
  rawFrameToRGBA,
  type ClipDrawContext,
  type ClipEncoder,
  type ClipExportDeps,
  type OutputDimensions,
  type CanEncodeVideoProbe,
  type ClipQuality,
} from "@/lib/videoExport";

const BITRATE: Record<ClipQuality, typeof QUALITY_HIGH> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  "very-high": QUALITY_VERY_HIGH,
};

/**
 * The live `canEncodeVideo` probe, adapted to the {@link CanEncodeVideoProbe}
 * signature (codec typed as `string`; we only ever pass {@link CLIP_EXPORT_CODEC}).
 */
export const clipEncodeProbe: CanEncodeVideoProbe = (codec, options) =>
  canEncodeVideo(codec as VideoCodec, options);

/**
 * Wire the real browser/WebCodecs implementations of {@link ClipExportDeps}:
 * an `HTMLCanvasElement` sized to the output, a mediabunny {@link CanvasSource}
 * → {@link Output}(Mp4) → {@link BufferTarget} encoder, and the injected decode
 * + overlay lookups. Browser/Tauri only (needs the DOM + WebCodecs).
 */
export function buildClipExportPipeline(params: {
  output: OutputDimensions;
  fps: number;
  video: Video;
  decodeFrame: (frameIdx: number) => Promise<CanvasImageSource | null>;
  overlayForFrame: (frameIdx: number) => RenderedInstance[];
  renderUnderlay?: ClipExportDeps["renderUnderlay"];
  /** Encode quality (default "high"). */
  quality?: ClipQuality;
}): ClipExportDeps {
  const canvas = document.createElement("canvas");
  canvas.width = params.output.width;
  canvas.height = params.output.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D canvas context for export.");

  const source = new CanvasSource(canvas, {
    codec: CLIP_EXPORT_CODEC,
    bitrate: BITRATE[params.quality ?? "high"],
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  output.addVideoTrack(source, { frameRate: params.fps });

  const encoder: ClipEncoder = {
    async start() {
      await output.start();
    },
    async addFrame(timestamp, duration) {
      await source.add(timestamp, duration);
    },
    async finalize() {
      await output.finalize();
      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer) throw new Error("Encoder produced no output.");
      const bytes = new Uint8Array(buffer);
      // WebKit's encoder tags its limited-range output full range, so every
      // reader decodes it washed out; fix the tag (see h264RangeTag.ts).
      return isWebKitEncoder(navigator.userAgent)
        ? (clearFullRangeTag(bytes) ?? bytes)
        : bytes;
    },
    async cancel() {
      try {
        await output.cancel();
      } catch {
        // best-effort
      }
    },
  };

  return {
    decodeFrame: params.decodeFrame,
    overlayForFrame: params.overlayForFrame,
    renderUnderlay: params.renderUnderlay,
    ctx: ctx as unknown as ClipDrawContext,
    encoder,
  };
}

/**
 * Decode whatever a video backend yields for a frame into an `OffscreenCanvas`
 * (a valid `CanvasImageSource` for `drawImage`). Mirrors the decode
 * normalisation VideoPlayer / imageFeatures do. Browser/Tauri only. Returns
 * null when the frame can't be decoded (rendered as background).
 */
export async function decodeExportFrame(
  video: Video,
  frameIdx: number
): Promise<OffscreenCanvas | null> {
  const frame = await (
    video as unknown as {
      getFrame: (i: number, o?: { prefetch?: boolean }) => Promise<unknown>;
    }
  ).getFrame(frameIdx, { prefetch: false });
  if (!frame) return null;

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
    // Raw decoder output may be grayscale (1ch), RGB (3ch), or RGBA (4ch).
    // `ImageData` only accepts tightly packed RGBA (w*h*4); the previous code
    // assumed 4 channels and threw / rendered garbage for 1- or 3-channel
    // sources. Detect the real channel count and expand to RGBA first.
    const channels = inferFrameChannels(bytes.length, w, h, shape[3]);
    const rgba = expandFrameBytesToRGBA(bytes, w, h, channels);
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d")?.putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  }
  // A raw pixel object (e.g. a grayscale video's 1-channel frame): not an
  // ImageData instance, and createImageBitmap rejects it.
  const raw = rawFrameToRGBA(frame);
  if (raw) {
    const c = new OffscreenCanvas(raw.width, raw.height);
    c.getContext("2d")?.putImageData(new ImageData(raw.rgba, raw.width, raw.height), 0, 0);
    return c;
  }
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
