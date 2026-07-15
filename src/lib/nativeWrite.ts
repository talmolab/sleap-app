/**
 * Native byte-range writes for the write B-seam spike (desktop/Tauri).
 *
 * This is the write half of the "dumb byte pipe": a persistent native R/W
 * file handle (`writeOpen`/`writeClose`) that a streaming writer can pour
 * arbitrary byte ranges into via `writeAt`, plus `truncateFile` to resize
 * and `readAt` to read back. `writeAt` prepends the offset to a raw binary
 * body (rather than a JSON object) so large payloads avoid JSON encoding
 * (and the number-array blowup that comes with it) over the IPC boundary.
 */
import { invoke } from "@tauri-apps/api/core";
import { sleapCmd } from "./sleapPlugin";

/** Open (create/truncate) a native file for writing at `path`. */
export async function writeOpen(path: string): Promise<void> {
  return invoke(sleapCmd("write_open"), { path });
}

/**
 * Open an EXISTING native file for writing at `path` WITHOUT truncating —
 * its current bytes stay on disk. Used by the dual-bridge streaming writer's
 * append phase, where `path` already has content (e.g. the small half already
 * written on the main thread) that must be preserved, not clobbered.
 */
export async function writeOpenAppend(path: string): Promise<void> {
  return invoke(sleapCmd("write_open_append"), { path });
}

/**
 * Write `bytes` at `offset` into the currently open file.
 *
 * Sends a single raw binary body — an 8-byte little-endian u64 offset
 * followed by `bytes` — so the Rust command (`write_at`, a
 * `tauri::ipc::Request`) can decode it without a JSON intermediary. The
 * `args` value passed to `invoke` must be the `Uint8Array` itself (not
 * wrapped in an object) so Tauri routes it as `InvokeBody::Raw` instead of
 * JSON-serializing it.
 */
export async function writeAt(offset: number, bytes: Uint8Array): Promise<void> {
  const body = new Uint8Array(8 + bytes.length);
  new DataView(body.buffer).setBigUint64(0, BigInt(offset), true); // little-endian
  body.set(bytes, 8);
  return invoke(sleapCmd("write_at"), body);
}

/** Read `[offset, offset + length)` from the currently open file. Returns fewer bytes at EOF. */
export async function readAt(offset: number, length: number): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>(sleapCmd("read_at"), {
    offset,
    length,
  });
  return new Uint8Array(buf);
}

/** Truncate (or extend) the currently open file to `length` bytes. */
export async function truncateFile(length: number): Promise<void> {
  return invoke(sleapCmd("truncate_file"), { length });
}

/** Close the currently open native write handle. */
export async function writeClose(): Promise<void> {
  return invoke(sleapCmd("write_close"));
}

/**
 * Atomically replace `to` with `from` (same-filesystem rename). Used by the streaming
 * pkg.slp writer to swap a verified-complete temp file over the real destination as the
 * final step of a save, so the original is only ever destroyed once a full write + verify
 * pass has succeeded.
 */
export async function renameFile(from: string, to: string): Promise<void> {
  return invoke(sleapCmd("rename_file"), { from, to });
}
