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
import { sleapCmd } from "./sleapPlugin";

// SPIKE (spike/tauri-localhost-origin): these are exposed via the inlined "sleap"
// plugin (src-tauri/build.rs + lib.rs) rather than as bare app commands, so they stay
// reachable when the app is served from the http://localhost (remote) origin — where
// bare custom commands are blocked. Hence the `plugin:sleap|...` command names.

/** Total size (bytes) of a native file. */
export async function fileSize(path: string): Promise<number> {
  return invoke<number>(sleapCmd("file_size"), { path });
}

/** Read `[offset, offset + length)` from a native file. Returns fewer bytes at EOF. */
export async function readRange(
  path: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>(sleapCmd("read_range"), {
    path,
    offset,
    length,
  });
  return new Uint8Array(buf);
}
