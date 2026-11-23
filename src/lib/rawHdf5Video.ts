/**
 * Raw HDF5 movies: a rank-4 pixel array (`[frames, H, W, C]`, or
 * `[frames, C, H, W]` when saved channels-first) stored as a plain HDF5
 * dataset — what PyQt SLEAP's "Import Videos" dialog offers for a `.h5` file
 * (`sleap/gui/dialogs/importvideos.py:140-157`): a menu of the file's rank-4
 * datasets plus a "channels_first / channels_last" choice.
 *
 * sleap-io.js ships no reader for these (its HDF5 backend reads SLEAP
 * packages' embedded PNG/JPEG frames; see `VideoBackend.readCrop`'s note), so
 * this is a thin app-side backend over the same shared {@link StreamingH5File}
 * reader: one `[i:i+1, :, :, :]` slice per frame, converted to RGBA.
 * TODO(io): move into sleap-io.js as a raw rank-4 `HDF5Video` backend.
 */

import type { StreamingH5File, VideoBackend, VideoFrame } from "@talmolab/sleap-io.js";

/** PyQt's `input_format` values (the radio-button labels, verbatim). */
export type Hdf5InputFormat = "channels_first" | "channels_last";

/** PyQt's order; the first one is selected by default (`importvideos.py`). */
export const HDF5_INPUT_FORMATS: readonly Hdf5InputFormat[] = [
  "channels_first",
  "channels_last",
];

/** The slice of {@link StreamingH5File} the dataset search needs (mockable). */
export interface Hdf5Tree {
  keys(): string[];
  getKeys(path: string): Promise<string[]>;
  getDatasetMeta(path: string): Promise<{ shape: number[]; dtype: string }>;
}

/** `"/box"` → `"box"`: the reader resolves paths from the root either way. */
function h5Path(dataset: string): string {
  return dataset.replace(/^\/+/, "");
}

/**
 * Every rank-4 dataset in the file, depth-first, as `"/group/name"` — PyQt's
 * `_find_h5_datasets`, which populates the dataset menu. A SLEAP package's
 * `video0/video` (1-D encoded frames) is not rank-4, so it is not listed.
 */
export async function findRank4Datasets(h5: Hdf5Tree): Promise<string[]> {
  const out: string[] = [];
  async function walk(prefix: string, names: string[]): Promise<void> {
    for (const name of names) {
      const path = `${prefix}/${name}`;
      let children: string[] | null = null;
      try {
        children = await h5.getKeys(h5Path(path));
      } catch {
        children = null; // a dataset, not a group
      }
      if (children) {
        await walk(path, children);
        continue;
      }
      try {
        const meta = await h5.getDatasetMeta(h5Path(path));
        if (meta?.shape?.length === 4) out.push(path);
      } catch {
        /* unreadable: skip, as PyQt's try/except does */
      }
    }
  }
  await walk("", h5.keys());
  return out;
}

/** `[frames, H, W, C]` from a stored shape read in `format`. */
export function frameShapeFor(
  stored: readonly number[],
  format: Hdf5InputFormat
): [number, number, number, number] {
  const [n, a, b, c] = stored as [number, number, number, number];
  return format === "channels_first" ? [n, b, c, a] : [n, a, b, c];
}

/**
 * One frame's pixels (`H*W*C` values in `format` order) as RGBA bytes.
 * 1 channel → gray, 3 → RGB, 4 → RGBA; values outside 0–255 are clamped.
 */
export function rawFrameToRgba(
  data: ArrayLike<number>,
  height: number,
  width: number,
  channels: number,
  format: Hdf5InputFormat
): Uint8ClampedArray {
  const n = height * width;
  const rgba = new Uint8ClampedArray(n * 4);
  const at =
    format === "channels_first"
      ? (px: number, ch: number) => data[ch * n + px] ?? 0
      : (px: number, ch: number) => data[px * channels + ch] ?? 0;
  for (let px = 0; px < n; px++) {
    const o = px * 4;
    if (channels === 1) {
      const g = at(px, 0);
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
    } else {
      rgba[o] = at(px, 0);
      rgba[o + 1] = at(px, 1);
      rgba[o + 2] = at(px, 2);
      rgba[o + 3] = channels >= 4 ? at(px, 3) : 255;
    }
  }
  return rgba;
}

/** A video backend over a raw rank-4 HDF5 dataset. */
export class RawHdf5VideoBackend implements VideoBackend {
  filename: string;
  dataset: string;
  shape: [number, number, number, number];
  fps?: number;
  /** PyQt's `input_format`; persisted into `backendMetadata.input_format`. */
  readonly inputFormat: Hdf5InputFormat;
  private readonly h5: StreamingH5File;

  constructor(options: {
    filename: string;
    h5file: StreamingH5File;
    dataset: string;
    /** The dataset's stored shape (as `getDatasetMeta` reports it). */
    storedShape: readonly number[];
    inputFormat: Hdf5InputFormat;
    fps?: number;
  }) {
    this.filename = options.filename;
    this.h5 = options.h5file;
    this.dataset = options.dataset;
    this.inputFormat = options.inputFormat;
    this.shape = frameShapeFor(options.storedShape, options.inputFormat);
    this.fps = options.fps;
  }

  async getFrame(frameIndex: number): Promise<VideoFrame | null> {
    const [frames, height, width, channels] = this.shape;
    if (frameIndex < 0 || frameIndex >= frames) return null;
    const { value } = await this.h5.getDatasetValue(h5Path(this.dataset), [
      [frameIndex, frameIndex + 1],
      [],
      [],
      [],
    ]);
    if (!value || typeof (value as ArrayLike<number>).length !== "number") {
      return null;
    }
    const rgba = rawFrameToRgba(
      value as ArrayLike<number>,
      height,
      width,
      channels,
      this.inputFormat
    );
    return new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height);
  }

  close(): void {
    // The container is shared per path (see hdf5VideoSource's openContainers).
  }
}
