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
  openH5Worker,
  readSlpStreaming,
  StreamingHdf5VideoBackend,
  type Labels,
  type RangeSource,
  type StreamingH5File,
} from "@talmolab/sleap-io.js";
import { frameToBitmap } from "@/lib/frameBitmap";
import type { WorkerClient } from "@/lib/protocolV1/client";
import { WorkerProtocolError, FS_NOT_FOUND, FS_FORBIDDEN, PROTO_UNKNOWN_METHOD } from "@/lib/protocolV1/errors";
import { translatePath, type PathMapping } from "@/lib/pathMappings";
import type { VideoVisibility } from "@/lib/remoteVisibility";

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
// calls), small enough that a scattered metadata read doesn't pull megabytes.
const DEFAULT_PAGE_SIZE = 1024 * 1024; // 1 MiB

// Small LRU: a worker-side SLP's structure is read front-to-back once, not
// randomly re-scanned, so only a handful of recently-touched pages are ever
// worth keeping around (plus room for the read-ahead below).
const DEFAULT_MAX_PAGES = 16;

// How many `fs.read` calls a large read (a whole pose table) keeps in flight.
// Over a relay each round trip costs far more than its bytes, so overlapping
// them is what makes a big table arrive in seconds instead of minutes.
const BULK_CONCURRENCY = 4;

// Read-ahead for runs of small sequential reads (a table read in small
// pieces): after moving forward N pages in a row, prefetch up to N (at most
// this many) following pages.
const MAX_READ_AHEAD_PAGES = 4;

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

/** Fetches `[offset, offset + length)` from the worker in ≤`FS_READ_MAX_BYTES` calls, up to `concurrency` at a time. */
async function readWorkerRange(
  client: WorkerClient,
  path: string,
  offset: number,
  length: number,
  concurrency = 1,
): Promise<Uint8Array> {
  if (length <= FS_READ_MAX_BYTES) {
    const { content } = await client.fsRead(path, offset, length);
    return content;
  }
  const pieces: Array<{ offset: number; length: number }> = [];
  for (let got = 0; got < length; got += FS_READ_MAX_BYTES) {
    pieces.push({ offset: offset + got, length: Math.min(FS_READ_MAX_BYTES, length - got) });
  }
  const results: Uint8Array[] = new Array(pieces.length);
  let next = 0;
  const run = async () => {
    while (next < pieces.length) {
      const i = next++;
      results[i] = (await client.fsRead(path, pieces[i].offset, pieces[i].length)).content;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pieces.length) }, run));
  // A short piece means EOF came early: nothing after it is real data.
  const short = results.findIndex((r, i) => r.length < pieces[i].length);
  const kept = short === -1 ? results : results.slice(0, short + 1);
  const out = new Uint8Array(kept.reduce((n, r) => n + r.length, 0));
  let written = 0;
  for (const chunk of kept) {
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
 * Tuned by what's being read:
 * - **Small reads** (HDF5 metadata) are page-aligned (`opts.pageSize`,
 *   default 1 MiB) and cached in a small LRU (`opts.maxPages`), so the
 *   reader's many small sequential reads mostly hit an already-fetched page.
 *   Reading forward page after page (a table read in small pieces) also
 *   prefetches the next few pages in parallel.
 * - **Large reads** (at least a page, e.g. a whole pose table) skip the cache
 *   and are fetched in worker-sized pieces, several in flight at once.
 *
 * `opts.onBytes` is told how many bytes each `fs.read` brought back (for a
 * progress readout).
 */
export function createWorkerFileRangeSource(
  client: WorkerClient,
  path: string,
  size: number,
  opts?: { pageSize?: number; maxPages?: number; onBytes?: (n: number) => void },
): WorkerFileRangeSource {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const onBytes = opts?.onBytes;
  const counted = onBytes
    ? ({
        fsRead: async (p: string, o?: number, l?: number) => {
          const result = await client.fsRead(p, o, l);
          onBytes(result.content.length);
          return result;
        },
      } as unknown as WorkerClient)
    : client;
  // Insertion order doubles as recency order: a cache hit deletes + re-sets
  // its own entry so it becomes the newest, and eviction always drops
  // whichever key iterates first (the least recently touched).
  const cache = new Map<number, Uint8Array>();
  const inFlight = new Map<number, Promise<Uint8Array>>();
  // The page the reader last moved onto, and how many pages in a row it has
  // moved forward one at a time (hits on read-ahead pages included).
  let lastPage = -2;
  let run = 0;
  let lastError: unknown = null;

  function fetchPage(pageIndex: number): Promise<Uint8Array> {
    const pending = inFlight.get(pageIndex);
    if (pending) return pending;
    const pageOffset = pageIndex * pageSize;
    const pageLength = Math.min(pageSize, size - pageOffset);
    const promise = readWorkerRange(counted, path, pageOffset, pageLength).then(
      (bytes) => {
        inFlight.delete(pageIndex);
        cache.set(pageIndex, bytes);
        while (cache.size > maxPages) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return bytes;
      },
      (err) => {
        inFlight.delete(pageIndex);
        throw err;
      },
    );
    inFlight.set(pageIndex, promise);
    return promise;
  }

  async function readPage(pageIndex: number): Promise<Uint8Array> {
    if (pageIndex !== lastPage) {
      run = pageIndex === lastPage + 1 ? run + 1 : 0;
      lastPage = pageIndex;
      // Reading forward page by page: fetch the next few pages ahead of it.
      const ahead = Math.min(run, MAX_READ_AHEAD_PAGES);
      for (let i = 1; i <= ahead && (pageIndex + i) * pageSize < size; i++) {
        if (!cache.has(pageIndex + i)) fetchPage(pageIndex + i).catch(() => {});
      }
    }
    const cached = cache.get(pageIndex);
    if (cached) {
      cache.delete(pageIndex);
      cache.set(pageIndex, cached);
      return cached;
    }
    return fetchPage(pageIndex);
  }

  return {
    size,
    lastError: () => lastError,
    readRange: async (offset, length) => {
      const end = Math.min(offset + length, size);
      if (end <= offset) return new Uint8Array(0);
      try {
        if (end - offset >= pageSize) {
          return await readWorkerRange(counted, path, offset, end - offset, BULK_CONCURRENCY);
        }
        const out = new Uint8Array(end - offset);
        let pos = offset;
        let written = 0;
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
        return written === out.length ? out : out.subarray(0, written);
      } catch (err) {
        lastError = err;
        throw err;
      }
    },
  };
}

/**
 * Reads a worker-side `.slp`'s structure (skeleton, videos, labeled frames)
 * via `fs.stat` + `fs.read` only — never the embedded image bytes
 * (`openVideos: false`), since the launcher wizard only needs stats to
 * build a spec and check video reachability, not to render anything — and
 * only user instances (`userInstancesOnly`): predicted points are most of a
 * predictions file and never used here.
 */
export async function loadWorkerLabels(
  client: WorkerClient,
  path: string,
  opts?: { onProgress?: (progress: WorkerLabelsProgress) => void },
): Promise<Labels> {
  const stat = await client.fsStat(path);
  const progress: WorkerLabelsProgress = { stage: "Reading metadata", bytesRead: 0, fileSize: stat.size };
  const report = () => opts?.onProgress?.({ ...progress });
  const source = createWorkerFileRangeSource(client, path, stat.size, {
    onBytes: (n) => {
      progress.bytesRead += n;
      report();
    },
  });
  try {
    return await readSlpStreaming(source, {
      openVideos: false,
      // Only the labels: never download pred_points, which is most of a
      // predictions file and nothing the wizard uses.
      userInstancesOnly: true,
      filenameHint: path,
      h5wasmUrl: H5WASM_URL,
      onProgress: (_current, _total, message) => {
        if (message) progress.stage = message;
        report();
      },
    });
  } catch (err) {
    // See WorkerFileRangeSource.lastError's doc: a readRange failure never
    // reaches here as the rejection that caused it — surface the real cause
    // (the worker's own error message) instead of whatever downstream parse
    // failure the swallowed short read produced.
    throw source.lastError() ?? err;
  }
}

/** How far {@link loadWorkerLabels} has got: the reader's current stage and the bytes fetched so far. */
export interface WorkerLabelsProgress {
  /** sleap-io.js's stage label, e.g. "Reading instances". */
  stage: string;
  bytesRead: number;
  /** The whole file's size (an upper bound: not every table is necessarily read). */
  fileSize: number;
}

/** One video's reachability from a worker's point of view, as checked by {@link checkWorkerFileVideos}. */
export interface WorkerFileVideoCheck {
  index: number;
  /** The video's first recorded filename — the only one checked for a multi-file `ImageVideo`. */
  path: string;
  /** Pixel data lives inside the `.slp` itself (pkg.slp) — always reachable, never statted. */
  embedded: boolean;
  found: boolean;
  /** The worker-visible path `path` resolved to, or `null` if nothing was found (or the video is embedded — it has no path of its own). */
  workerPath: string | null;
  /** Which candidate resolved it — see {@link resolveVideoPath}'s doc. `null` for an embedded video, or when nothing was found. */
  via: "as-is" | "rule" | "next-to-labels" | null;
}

/** Last path segment of `path` — worker paths are posix, but a video recorded from a Windows machine could still carry backslashes (mirrors `remoteLabelsPayload.ts`'s own unexported `dir` helper's separator handling). */
function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Directory portion of `path` (see {@link basenameOf}'s doc on separator handling). `""` for a bare filename or a root-level path. */
function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? "" : path.slice(0, idx);
}

/**
 * `fs.stat`, but treats a candidate resolution path that comes back
 * `fs.not_found` OR `fs.forbidden` as "doesn't exist here" rather than a
 * failure — `fs.forbidden` means the path is outside every mount the worker
 * is configured to serve, exactly what an untranslated path from a different
 * machine looks like (the bug this resolution exists to fix: a `.slp` made
 * on the user's Mac records `/Volumes/...` paths no Linux worker mount will
 * ever match). Anything else (a dropped connection, a genuine I/O error) is
 * rethrown as-is — only `fs.not_found`/`fs.forbidden` mean "try the next
 * candidate".
 */
async function statExists(client: WorkerClient, path: string): Promise<boolean> {
  try {
    await client.fsStat(path);
    return true;
  } catch (err) {
    if (err instanceof WorkerProtocolError && (err.code === FS_NOT_FOUND || err.code === FS_FORBIDDEN)) {
      return false;
    }
    throw err;
  }
}

/**
 * Resolves one non-embedded video's recorded path to a worker-visible path —
 * the common case of a project copied to a cluster whose `.slp` still
 * records paths from the machine it was labeled on. Tries, in order, the
 * first candidate that exists on the worker:
 *  1. **as-is** — the recorded path happens to already be valid on the
 *     worker (same mount layout, or nothing moved);
 *  2. **rule** — the recorded path translated through this worker's
 *     remembered path rules (`pathMappings.ts`'s `translatePath`; the same
 *     rules "Locate on worker…" saves via `inferRuleFromLocate`);
 *  3. **next-to-labels** — the recorded file's own basename, placed next to
 *     the `.slp` itself on the worker — SLEAP's usual "videos live beside
 *     the labels file" layout, which covers copying a whole project folder
 *     to a cluster without carrying over any path rule at all.
 * `{ workerPath: null, via: null }` if none of the three exist.
 */
async function resolveVideoPath(
  client: WorkerClient,
  recorded: string,
  slpDir: string,
  rules: PathMapping[],
): Promise<Pick<WorkerFileVideoCheck, "workerPath" | "via">> {
  if (await statExists(client, recorded)) return { workerPath: recorded, via: "as-is" };

  const translated = translatePath(recorded, rules);
  if (translated !== null && (await statExists(client, translated))) {
    return { workerPath: translated, via: "rule" };
  }

  const nextToLabels = slpDir ? `${slpDir}/${basenameOf(recorded)}` : `/${basenameOf(recorded)}`;
  if (await statExists(client, nextToLabels)) {
    return { workerPath: nextToLabels, via: "next-to-labels" };
  }

  return { workerPath: null, via: null };
}

/**
 * Checks every video `labels` references against the worker's filesystem,
 * resolving one that isn't reachable at its exact recorded path — the
 * launcher wizard's "N of M videos not found on &lt;worker&gt;" check
 * (design §4.3), extended (fix for the "a `.slp` made on another machine"
 * bug) to try `resolveVideoPath`'s rule/next-to-labels fallbacks before
 * giving up on a video. An embedded video's pixels live inside the `.slp`
 * itself, so it's always `found: true` without a round trip or a worker
 * path of its own.
 */
export async function checkWorkerFileVideos(
  client: WorkerClient,
  labels: Labels,
  slpPath: string,
  rules: PathMapping[],
): Promise<WorkerFileVideoCheck[]> {
  const slpDir = dirnameOf(slpPath);
  return Promise.all(
    labels.videos.map(async (video, index) => {
      const path = Array.isArray(video.filename) ? video.filename[0] : video.filename;
      if (video.hasEmbeddedImages) {
        return { index, path, embedded: true, found: true, workerPath: null, via: null };
      }
      const { workerPath, via } = await resolveVideoPath(client, path, slpDir, rules);
      return { index, path, embedded: false, found: workerPath !== null, workerPath, via };
    }),
  );
}

/**
 * Whether submitting `labels` as-is (worker-file `labels_path`, no content)
 * is no longer safe — at least one non-embedded video only resolved via a
 * rule or the next-to-labels fallback, meaning its `.slp`-recorded path
 * isn't one the worker (or `sleap-nn` running on it) can actually open.
 * Resolved "as-is", or embedded, videos need no re-pointing.
 */
export function needsLabelsRepoint(checks: WorkerFileVideoCheck[]): boolean {
  return checks.some((c) => c.via === "rule" || c.via === "next-to-labels");
}

/**
 * Builds the `VideoVisibility[]` `buildRemoteLabelsPayload` (`remoteLabelsPayload.ts`)
 * expects, from a `checkWorkerFileVideos` resolution — used only once
 * {@link needsLabelsRepoint} is true, to build a re-pointed `labels_content`
 * payload instead of sending the original (unopenable) `labels_path` alone.
 *
 * A resolved external video (`via` "as-is"/"rule"/"next-to-labels") is
 * marked visible at its resolved worker path, so `buildRemoteLabelsPayload`
 * re-points its `filename` and never embeds it (`embed: false` when nothing
 * else is hidden) — every external video goes through the same re-point
 * branch uniformly, not just the ones that needed translating.
 *
 * An embedded (pkg.slp) video is marked NOT visible instead: it has no
 * worker path of its own (its pixels already live inside the `.slp`), and
 * marking it "visible" would make `buildRemoteLabelsPayload` retarget its
 * `filename` to `null` and clear its backend — destroying its only pixel
 * source. Marking it hidden instead keeps `buildRemoteLabelsPayload` riding
 * its existing embedded backend untouched (and, since the regenerated
 * `.slp` bytes must still carry those pixels, re-embeds them — see that
 * function's own doc on a hidden video with a backend).
 */
export function videoChecksToVisibility(checks: WorkerFileVideoCheck[]): VideoVisibility[] {
  return checks.map((c) =>
    c.embedded
      ? { index: c.index, local: c.path, worker: null, visible: false }
      : { index: c.index, local: c.path, worker: c.workerPath, visible: c.workerPath !== null },
  );
}

/**
 * The worker-side file holding frame `frameIdx` of a worker `.slp`'s video,
 * given that video's {@link WorkerFileVideoCheck}: its resolved `workerPath`
 * for a single-file video; for a multi-file `ImageVideo`, frame `frameIdx`'s
 * own image, assumed to sit in the same folder the first image resolved to
 * (only the first is ever checked). `null` when there's no such file — an
 * embedded video, one not found on the worker, or a frame past the list.
 */
export function workerFramePath(
  filename: string | string[],
  check: WorkerFileVideoCheck,
  frameIdx: number,
): string | null {
  if (check.embedded || check.workerPath === null) return null;
  if (!Array.isArray(filename) || filename.length <= 1) return check.workerPath;
  const image = filename[frameIdx];
  if (image === undefined) return null;
  const dir = dirnameOf(check.workerPath);
  return dir ? `${dir}/${basenameOf(image)}` : basenameOf(image);
}

/** A decoded preview frame, with the original video frame's size (the image itself may be scaled down). */
export interface PreviewFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/**
 * Frame `frameIdx` of video `videoIndex` of a worker `.slp`, decoded on the
 * worker (`media.frame`) — for the receptive-field preview, since the app
 * can't decode a worker-side video itself. Throws an `Error` whose message
 * is fit to show in the preview when it can't.
 */
export async function fetchWorkerPreviewFrame(
  client: WorkerClient,
  labels: Labels,
  labelsPath: string,
  checks: WorkerFileVideoCheck[],
  videoIndex: number,
  frameIdx: number,
): Promise<PreviewFrame> {
  const video = labels.videos[videoIndex];
  const check = checks.find((c) => c.index === videoIndex);
  if (!video || !check) throw new Error("Preview unavailable");
  if (check.embedded) return readEmbeddedPreviewFrame(client, labelsPath, video, videoIndex, frameIdx);
  const path = workerFramePath(video.filename, check, frameIdx);
  if (path === null) throw new Error("Video not found on the worker");
  let frame;
  try {
    frame = await client.mediaFrame(path, frameIdx);
  } catch (err) {
    if (err instanceof WorkerProtocolError && err.code === PROTO_UNKNOWN_METHOD) {
      throw new Error("Update SLEAP Connect on the worker to preview its videos");
    }
    if (err instanceof WorkerProtocolError && err.code === FS_NOT_FOUND) {
      throw new Error("Video not found on the worker");
    }
    throw new Error("Couldn't load a frame from the worker");
  }
  const blob = new Blob([frame.content as BlobPart], { type: frame.mime });
  return { bitmap: await createImageBitmap(blob), width: frame.width, height: frame.height };
}

/**
 * One frame of a video embedded in a worker-side `pkg.slp`: the frame's own
 * stored image (PNG/JPEG, small) is read straight out of the file via
 * `fs.read` and decoded here — no worker-side decoding needed. Opens its own
 * short-lived reader over the file and closes it afterwards. A frame that
 * isn't stored (frame 0 when no frame is labeled) falls back to the first one
 * that is.
 */
async function readEmbeddedPreviewFrame(
  client: WorkerClient,
  labelsPath: string,
  video: Labels["videos"][number],
  videoIndex: number,
  frameIdx: number,
): Promise<PreviewFrame> {
  const fail = () => new Error("Couldn't read the embedded frame from the worker");
  let h5: StreamingH5File | null = null;
  try {
    const stat = await client.fsStat(labelsPath);
    h5 = await openH5Worker(createWorkerFileRangeSource(client, labelsPath, stat.size), {
      filenameHint: labelsPath,
      h5wasmUrl: H5WASM_URL,
    });
    const meta = video.backendMetadata ?? {};
    const datasetPath =
      typeof meta.dataset === "string" ? meta.dataset : `video${videoIndex}/video`;
    const backend = new StreamingHdf5VideoBackend({
      filename: labelsPath,
      h5file: h5,
      datasetPath,
      format: typeof meta.format === "string" ? meta.format : undefined,
      channelOrder: typeof meta.channel_order === "string" ? meta.channel_order : undefined,
      deferred: true,
    });
    await backend.ensureLoaded();
    const stored = backend.frameNumbers;
    const target = stored.includes(frameIdx) ? frameIdx : stored[0];
    if (target === undefined) throw fail();
    const bitmap = await frameToBitmap(await backend.getFrame(target), backend.shape);
    if (!bitmap) throw fail();
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("Couldn't") ? err : fail();
  } finally {
    await h5?.close().catch(() => {});
  }
}
