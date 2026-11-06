/**
 * Turns whatever a sleap-io.js video backend's `getFrame` returns into an
 * `ImageBitmap` to draw (the receptive-field preview's thumbnail).
 */
import type { Video } from "@talmolab/sleap-io.js";
import { expandFrameBytesToRGBA, inferFrameChannels } from "@/lib/videoExport";

type Frame = Awaited<ReturnType<NonNullable<Video["backend"]>["getFrame"]>>;

/** `frame` as an `ImageBitmap`, or `null` for a shape it can't interpret. Raw pixel bytes need `shape` (`[frames, height, width, channels]`) to be laid out. */
export async function frameToBitmap(
  frame: Frame | unknown,
  shape: readonly number[] | null | undefined,
): Promise<ImageBitmap | null> {
  if (!frame) return null;
  if (frame instanceof ImageBitmap) return createImageBitmap(frame);
  if (frame instanceof ImageData) return createImageBitmap(frame);
  if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
    const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
    if (!shape) return null;
    const [, h, w] = shape;
    const channels = inferFrameChannels(bytes.length, w, h, shape[3]);
    return createImageBitmap(new ImageData(expandFrameBytesToRGBA(bytes, w, h, channels), w, h));
  }
  if (typeof frame === "object" && "data" in frame && "width" in frame && "height" in frame) {
    const raw = frame as {
      data: Uint8Array | Uint8ClampedArray;
      width: number;
      height: number;
      channels?: number;
    };
    const bytes = raw.data instanceof Uint8ClampedArray ? new Uint8Array(raw.data) : raw.data;
    return createImageBitmap(
      new ImageData(expandFrameBytesToRGBA(bytes, raw.width, raw.height, raw.channels ?? 1), raw.width, raw.height),
    );
  }
  return null;
}
