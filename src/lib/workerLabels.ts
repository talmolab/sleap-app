/**
 * Reads a worker-side `.slp`'s structure (skeleton, videos, labeled frames)
 * without ever asking the worker to send the whole file — the launcher
 * wizard (PR5b) needs the skeleton + per-video stats to build a training
 * spec and run the compatibility check, but the file itself can be
 * arbitrarily large and stays on the worker.
 *
 * Built on `fs.read` (protocol v1, `WorkerClient.fsRead`) the same way
 * `tauriIrohBlob.ts` builds a `RangeSource` on top of its own blob-streaming
 * RPC: `readSlpStreaming` only ever asks for the byte ranges it needs to
 * parse the file's structure (HDF5 header/metadata, `labels_json`,
 * `points`/`instances` tables — never the big `video{i}/video` embedded-image
 * datasets, see `saveEmbeddedPkgStreaming.ts`'s own comment on the same
 * split), so this never materializes the file in memory either.
 */
import {
  readSlpStreaming,
  type Labels,
  type RangeSource,
} from "@talmolab/sleap-io.js";
import type { WorkerClient } from "@/lib/protocolV1/client";

// Serve h5wasm same-origin so the streaming Worker can load it under
// cross-origin isolation (COOP/COEP) — COEP blocks the default cross-origin
// CDN importScripts. Duplicated (not shared) with loadProject.ts/
// draftRestoreTauri.ts/etc. — same convention as every other reader in this
// codebase that needs it.
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

// Mirrors the worker's `file_manager.py` `MAX_READ_BYTES` — `fs.read` caps
// any single call's response to this, so a page larger than it (an
// `opts.pageSize` override, not the default) must be filled by several
// `fs.read` calls rather than one.
const FS_READ_MAX_BYTES = 4 * 1024 * 1024;

// Default page size for `createWorkerFileRangeSource`'s cache: large enough
// that `readSlpStreaming`'s small, sequential metadata reads mostly land on
// an already-fetched page (one `fs.read` round trip serves many `readRange`
// calls), small enough that a handful of cached pages is a bounded,
// negligible amount of memory.
const DEFAULT_PAGE_SIZE = 1024 * 1024; // 1 MiB

// Small LRU: a worker-side SLP's structure is read front-to-back once, not
// randomly re-scanned, so only a handful of recently-touched pages are ever
// worth keeping around.
const DEFAULT_MAX_PAGES = 8;

/**
 * A `RangeSource` reading one worker-side file via `fs.read`, with an
 * aligned-page LRU cache so `readSlpStreaming`'s many small sequential reads
 * don't each round-trip the worker. Extends the plain `RangeSource` contract
 * with {@link lastError} — see its doc for why that's needed.
 */
export interface WorkerFileRangeSource extends RangeSource {
  /**
   * The most recent `fs.read` failure from a `readRange` call, if any.
   *
   * `readSlpStreaming` runs its H5 parser in a Worker and pulls bytes
   * through a SharedArrayBuffer + `Atomics` bridge (the "B-seam"): per
   * sleap-io.js's own `serviceRangeBridge` doc, a `readRange` that THROWS is
   * turned into a clean 0-byte short read / EOF for the Worker side, rather
   * than propagating as a rejection — so a worker disconnect or a
   * now-missing file surfaces as a confusing HDF5 parse error, not the real
   * cause. `loadWorkerLabels` checks this after a failed `readSlpStreaming`
   * and rethrows it instead, when set.
   */
  lastError(): unknown;
}

/** Fetches `[offset, offset + length)` from the worker, splitting into ≤`FS_READ_MAX_BYTES` calls if `length` exceeds it (only possible with an `opts.pageSize` override above the worker's own cap). */
async function readWorkerRange(
  client: WorkerClient,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (length <= FS_READ_MAX_BYTES) {
    const { content } = await client.fsRead(path, offset, length);
    return content;
  }
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < length) {
    const chunkLength = Math.min(FS_READ_MAX_BYTES, length - got);
    const { content } = await client.fsRead(path, offset + got, chunkLength);
    chunks.push(content);
    got += content.length;
    if (content.length < chunkLength) break; // short read — EOF reached early
  }
  const out = new Uint8Array(got);
  let written = 0;
  for (const chunk of chunks) {
    out.set(chunk, written);
    written += chunk.length;
  }
  return out;
}

/**
 * Builds a `RangeSource` for one worker-side file over `fs.read` — the
 * remote-filesystem counterpart to `createTauriIrohBlobRangeSource`
 * (`tauriIrohBlob.ts`), used to read a worker-side `.slp`'s structure via
 * `readSlpStreaming` without ever transferring the whole file.
 *
 * Reads are page-aligned (`opts.pageSize`, default 1 MiB) and cached in a
 * small LRU (`opts.maxPages`, default 8) keyed by page index, so
 * `readSlpStreaming`'s sequential small reads mostly hit an
 * already-fetched page instead of round-tripping `fs.read` per call.
 */
export function createWorkerFileRangeSource(
  client: WorkerClient,
  path: string,
  size: number,
  opts?: { pageSize?: number; maxPages?: number },
): WorkerFileRangeSource {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  // Insertion order doubles as recency order: a cache hit deletes + re-sets
  // its own entry so it becomes the newest, and eviction always drops
  // whichever key iterates first (the least recently touched).
  const cache = new Map<number, Uint8Array>();
  let lastError: unknown = null;

  async function readPage(pageIndex: number): Promise<Uint8Array> {
    const cached = cache.get(pageIndex);
    if (cached) {
      cache.delete(pageIndex);
      cache.set(pageIndex, cached);
      return cached;
    }
    const pageOffset = pageIndex * pageSize;
    const pageLength = Math.min(pageSize, size - pageOffset);
    const bytes = await readWorkerRange(client, path, pageOffset, pageLength);
    cache.set(pageIndex, bytes);
    if (cache.size > maxPages) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return bytes;
  }

  return {
    size,
    lastError: () => lastError,
    readRange: async (offset, length) => {
      const end = Math.min(offset + length, size);
      if (end <= offset) return new Uint8Array(0);
      const out = new Uint8Array(end - offset);
      let pos = offset;
      let written = 0;
      try {
        while (pos < end) {
          const pageIndex = Math.floor(pos / pageSize);
          const pageStart = pageIndex * pageSize;
          const page = await readPage(pageIndex);
          const withinPage = pos - pageStart;
          const take = Math.min(page.length - withinPage, end - pos);
          if (take <= 0) break; // page came back shorter than expected (EOF)
          out.set(page.subarray(withinPage, withinPage + take), written);
          written += take;
          pos += take;
        }
      } catch (err) {
        lastError = err;
        throw err;
      }
      return written === out.length ? out : out.subarray(0, written);
    },
  };
}

/**
 * Reads a worker-side `.slp`'s structure (skeleton, videos, labeled frames)
 * via `fs.stat` + `fs.read` only — never the embedded image bytes
 * (`openVideos: false`), since the launcher wizard only needs stats to
 * build a spec and check video reachability, not to render anything.
 */
export async function loadWorkerLabels(client: WorkerClient, path: string): Promise<Labels> {
  const stat = await client.fsStat(path);
  const source = createWorkerFileRangeSource(client, path, stat.size);
  try {
    return await readSlpStreaming(source, {
      openVideos: false,
      filenameHint: path,
      h5wasmUrl: H5WASM_URL,
    });
  } catch (err) {
    // See WorkerFileRangeSource.lastError's doc: a readRange failure never
    // reaches here as the rejection that caused it — surface the real cause
    // (the worker's own error message) instead of whatever downstream parse
    // failure the swallowed short read produced.
    throw source.lastError() ?? err;
  }
}
