/**
 * Draw whatever a video backend's `getFrame` yields (ImageBitmap, ImageData,
 * raw bytes, or a raw pixel object) onto an `OffscreenCanvas`. Mirrors the
 * decode normalisation VideoPlayer / imageFeatures do. Browser/Tauri only.
 * Shared by clip export and the frame check; kept apart from both so neither
 * pulls in the other's dependencies (mediabunny, for clip export).
 */
import {
  expandFrameBytesToRGBA,
  inferFrameChannels,
  rawFrameToRGBA,
} from "@/lib/videoExport";

/** Returns null when the frame can't be drawn (missing or undecodable). */
export async function frameToCanvas(
  frame: unknown,
  shape: readonly number[] | null | undefined
): Promise<OffscreenCanvas | null> {
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
