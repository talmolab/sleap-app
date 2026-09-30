/**
 * A sleap-io.js `RangeSource` (`{size, readRange(offset, length)}`) backed
 * by a dedicated iroh QUIC stream to a worker (item 2.4), for merging a
 * remote job's result without ever buffering the whole blob — neither on
 * the wire nor in memory. `readSlpStreaming()` decides which byte ranges it
 * actually needs to parse the file's structure; this only serves whatever
 * it asks for.
 *
 * Full design: `docs/plans/2026-09-30-item-2-4-blob-over-iroh-design.md`.
 *
 * Wire protocol (matches `sleap_rtc/protocol_v1/server.py`'s
 * `_serve_iroh_blob_stream`, doc §6/§6.1): one stream, opened once
 * (`iroh_blob_open`) and reused for every subsequent `readRange` call
 * against that blob — never one stream per read, since sleap-io.js's own
 * reads are already strictly sequential (it awaits one `readRange` before
 * issuing the next), so there's never more than one request in flight.
 *
 * Chunk-aligned reads + verification live HERE, not in the Rust command
 * (`iroh_blob_read_range` there stays a dumb pipe — see its own comment in
 * `iroh_client.rs`): the worker registers a sha256 digest per
 * `chunkSize`-aligned chunk once, at the moment the file was known-good
 * (`BlobIndex`'s `hash_file()`), and this module checks every byte it gets
 * back against that pre-registered hash before returning it — the same
 * principle BitTorrent uses per-piece, done here with the sha256 already
 * used throughout this protocol, so no new hashing dependency (the browser/
 * Tauri WebView's native `crypto.subtle.digest` already does sha256 — the
 * exact same call `client.ts`'s existing whole-blob `_verifyBlob` uses).
 */

import { sleapCmd } from "@/lib/sleapPlugin";
import { WorkerProtocolError, BLOB_HASH_MISMATCH } from "./errors";
import type { RangeSource } from "@talmolab/sleap-io.js";

/** The minimal Tauri IPC surface this module needs — just `invoke`, unlike
 * `tauriIrohSocket.ts`'s fuller `TauriIpc` (no event channel is needed
 * here, every blob-stream exchange is a plain request/response). Injectable
 * for tests, same reasoning as everywhere else in this directory. */
export interface TauriBlobIpc {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

async function defaultTauriIpc(): Promise<TauriBlobIpc> {
  const { invoke } = await import("@tauri-apps/api/core");
  return { invoke };
}

interface IrohBlobOpenResult {
  size: number;
  chunkSize: number;
  chunkHashes: string[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds a `RangeSource` for one blob's worth of reads over the currently
 * active iroh connection (there's only ever one — `iroh_blob_open` operates
 * on Tauri-managed global state, the same way `iroh_connect`/`iroh_send` do
 * for the control connection), plus a `dispose()` the caller MUST run once
 * done — `RangeSource` itself has no `close()`/lifecycle hook of its own.
 */
export function createTauriIrohBlobRangeSource(
  sha256: string,
  size: number,
  getIpc: () => Promise<TauriBlobIpc> = defaultTauriIpc,
): { source: RangeSource; dispose: () => Promise<void> } {
  let opened: Promise<IrohBlobOpenResult> | null = null;
  const ensureOpen = (ipc: TauriBlobIpc): Promise<IrohBlobOpenResult> => {
    if (!opened) {
      opened = ipc.invoke(sleapCmd("iroh_blob_open"), { sha256 }) as Promise<IrohBlobOpenResult>;
    }
    return opened;
  };

  return {
    source: {
      size,
      readRange: async (offset: number, length: number): Promise<Uint8Array> => {
        const ipc = await getIpc();
        const { chunkSize, chunkHashes } = await ensureOpen(ipc);

        // Expand [offset, offset+length) to the chunkSize-aligned window
        // that covers it — every response is then checkable in full against
        // the registered hash list. The worker-side command does no
        // alignment of its own; this is purely a client-side concern.
        const firstChunk = Math.floor(offset / chunkSize);
        const lastChunk = Math.floor((offset + length - 1) / chunkSize);
        const alignedOffset = firstChunk * chunkSize;
        const alignedLength = Math.min(size, (lastChunk + 1) * chunkSize) - alignedOffset;

        const window = (await ipc.invoke(sleapCmd("iroh_blob_read_range"), {
          offset: alignedOffset,
          length: alignedLength,
        })) as Uint8Array;

        for (let c = firstChunk; c <= lastChunk; c++) {
          const start = (c - firstChunk) * chunkSize;
          const end = Math.min(start + chunkSize, window.length);
          const actual = await sha256Hex(window.subarray(start, end));
          if (actual !== chunkHashes[c]) {
            throw new WorkerProtocolError(
              BLOB_HASH_MISMATCH,
              `Blob ${sha256} chunk ${c}: expected ${chunkHashes[c]}, got ${actual}`,
            );
          }
        }

        // Slice out exactly what the caller asked for, now that the whole
        // verified window has been checked chunk-by-chunk.
        return window.subarray(offset - alignedOffset, offset - alignedOffset + length);
      },
    },
    dispose: async () => {
      if (!opened) return; // never actually opened a stream — nothing to close
      const ipc = await getIpc();
      await ipc.invoke(sleapCmd("iroh_blob_close"));
    },
  };
}
