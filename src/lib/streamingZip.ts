/**
 * Write a `.zip` piece by piece, so a large file (a training job package's
 * `.pkg.slp`) is read and written in chunks instead of held in memory.
 *
 * Entries are stored, not compressed: the package's frames are already
 * compressed images, and the configs and scripts are a few KB. The zip has
 * no Zip64 records (fflate doesn't write them), so a single entry or the
 * whole archive must stay under 4 GiB — {@link ZIP_SIZE_LIMIT}; callers
 * check that before starting.
 */
import { Zip, ZipPassThrough, strToU8 } from "fflate";

/** One file to put in the zip. `read` returns fewer bytes only at the end. */
export interface ZipSource {
  name: string;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Largest zip (and entry) a non-Zip64 archive can describe, minus room for headers. */
export const ZIP_SIZE_LIMIT = 0xffffffff - 64 * 1024 * 1024;

/** A small in-memory file. */
export function bytesSource(name: string, bytes: Uint8Array): ZipSource {
  return {
    name,
    size: bytes.byteLength,
    read: async (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.byteLength)),
  };
}

/** A text file (UTF-8). */
export function textSource(name: string, text: string): ZipSource {
  return bytesSource(name, strToU8(text));
}

/**
 * Stream `sources` into a zip, handing each finished piece of the archive
 * to `sink` in order. `onProgress(done, total)` counts source bytes; it can
 * return false to stop (then this throws `ZipCancelled`).
 */
export async function writeZip(
  sources: ZipSource[],
  sink: (chunk: Uint8Array) => Promise<void>,
  options: {
    chunkSize?: number;
    onProgress?: (done: number, total: number) => boolean;
  } = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? 8 * 1024 * 1024;
  const total = sources.reduce((n, s) => n + s.size, 0);
  const pending: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err;
    else pending.push(chunk);
  });
  const flush = async () => {
    if (zipError) throw zipError;
    while (pending.length > 0) await sink(pending.shift()!);
  };

  let done = 0;
  for (const src of sources) {
    const entry = new ZipPassThrough(src.name);
    zip.add(entry);
    if (src.size === 0) {
      entry.push(new Uint8Array(0), true);
      await flush();
      continue;
    }
    let offset = 0;
    while (offset < src.size) {
      const piece = await src.read(offset, Math.min(chunkSize, src.size - offset));
      if (piece.byteLength === 0) throw new Error(`${src.name} ended early at byte ${offset} of ${src.size}`);
      offset += piece.byteLength;
      done += piece.byteLength;
      entry.push(piece, offset >= src.size);
      await flush();
      if (options.onProgress && options.onProgress(done, total) === false) throw new ZipCancelled();
    }
  }
  zip.end();
  await flush();
}

/** Thrown by {@link writeZip} when `onProgress` asks it to stop. */
export class ZipCancelled extends Error {
  constructor() {
    super("Zip cancelled");
    this.name = "ZipCancelled";
  }
}
