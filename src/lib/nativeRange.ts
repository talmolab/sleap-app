/**
 * Native byte-range reads for the B-seam range reader (desktop/Tauri).
 *
 * These are the "dumb byte pipe" the streaming Worker pulls from: `fileSize`
 * gives h5wasm the file length, `readRange` returns arbitrary slices via
 * `std::fs` (no decoding). Paired with sleap-io.js's `{ size, readRange }`
 * range source so large embedded `.pkg.slp` files are read lazily on disk
 * instead of materialized in WASM memory.
 */
import { invoke } from "@tauri-apps/api/core";

/** Total size (bytes) of a native file. */
export async function fileSize(path: string): Promise<number> {
  return invoke<number>("file_size", { path });
}

/** Read `[offset, offset + length)` from a native file. Returns fewer bytes at EOF. */
export async function readRange(
  path: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("read_range", { path, offset, length });
  return new Uint8Array(buf);
}
