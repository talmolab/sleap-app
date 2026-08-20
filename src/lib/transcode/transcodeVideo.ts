/**
 * Desktop legacy-codec transcode orchestration.
 *
 * `transcodeToMp4()` turns a legacy-codec video path into a cached H.264 MP4
 * path, converting once and reusing thereafter. All platform I/O is injected via
 * {@link TranscodeDeps} so the orchestration (cache hit/miss, temp→atomic
 * rename, progress, cancel) is unit-testable with fakes; the real desktop
 * implementation is {@link createTauriTranscodeDeps}.
 *
 * The transcode runs disk→disk in a native ffmpeg sidecar process — the source
 * bytes never enter the WebView/JS heap — so a multi-GB legacy file converts at
 * a flat, small memory cost (unlike the direct web-demuxer path, which would
 * materialize the whole file). See docs for the full design.
 */

import { buildTranscodeArgs } from "./transcodeArgs.js";
import { cacheFilename, computeCacheKey } from "./transcodeCache.js";

export interface TranscodeProgress {
  /** Frames processed so far (from ffmpeg `-progress`), if known. */
  frame?: number;
  /** Output timestamp reached, in ms, if known. */
  outTimeMs?: number;
  /** True on the terminal `progress=end` line. */
  done: boolean;
}

/** Injected platform seams (real impls: Tauri fs + shell sidecar). */
export interface TranscodeDeps {
  /** Absolute OS cache directory for transcodes (e.g. `appCacheDir()/transcodes`). */
  cacheDir: () => Promise<string>;
  /** Join path segments with the platform separator. */
  join: (...parts: string[]) => Promise<string>;
  /** `{ size, mtimeMs }` for a file. */
  stat: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  /** Whether a path exists. */
  exists: (path: string) => Promise<boolean>;
  /** Create a directory (recursive; no-op if present). */
  mkdir: (path: string) => Promise<void>;
  /** Atomically move `from`→`to` (same filesystem). */
  rename: (from: string, to: string) => Promise<void>;
  /** Best-effort delete (ignore missing). */
  remove: (path: string) => Promise<void>;
  /**
   * Run the bundled ffmpeg with `args`, streaming parsed progress. Rejects on a
   * nonzero exit or spawn failure; honors `signal` (kills the child on abort).
   */
  runFfmpeg: (
    args: string[],
    onProgress: (p: TranscodeProgress) => void,
    signal?: AbortSignal
  ) => Promise<void>;
}

export interface TranscodeToMp4Options {
  /** Progress callback for a UI bar. */
  onProgress?: (p: TranscodeProgress) => void;
  /** Abort the (running) transcode; a cache hit ignores it. */
  signal?: AbortSignal;
  /** Encoder/quality overrides forwarded to {@link buildTranscodeArgs}. */
  encoder?: string;
  quality?: string[];
}

/** Subdirectory under the OS cache dir where transcodes live. */
export const TRANSCODE_SUBDIR = "transcodes";

/**
 * Ensure a decodable H.264 MP4 exists for `sourcePath` and return its path.
 * Cache hit → returns immediately (no reconvert). Cache miss → transcodes to a
 * `.part` temp then atomically renames into place, so an interrupted/cancelled
 * run never leaves a half-written file mistaken for a valid cache entry.
 */
export async function transcodeToMp4(
  sourcePath: string,
  deps: TranscodeDeps,
  options: TranscodeToMp4Options = {}
): Promise<string> {
  const { size, mtimeMs } = await deps.stat(sourcePath);
  const key = computeCacheKey(sourcePath, size, mtimeMs);
  const dir = await deps.join(await deps.cacheDir(), TRANSCODE_SUBDIR);
  const cachePath = await deps.join(dir, cacheFilename(key));

  if (await deps.exists(cachePath)) return cachePath; // convert-once: cache hit

  await deps.mkdir(dir);
  const tempPath = `${cachePath}.part`;
  await deps.remove(tempPath); // clear any stale partial from a prior crash

  const args = buildTranscodeArgs({
    input: sourcePath,
    output: tempPath,
    encoder: options.encoder,
    quality: options.quality,
  });

  try {
    await deps.runFfmpeg(
      args,
      options.onProgress ?? (() => {}),
      options.signal
    );
  } catch (err) {
    await deps.remove(tempPath); // don't leave a partial behind
    throw err;
  }

  await deps.rename(tempPath, cachePath); // atomic publish
  return cachePath;
}

/**
 * Parse a chunk of ffmpeg `-progress pipe:1` stdout into progress updates.
 * ffmpeg emits `key=value` lines in blocks terminated by `progress=continue`
 * (or `progress=end`); a chunk may contain several partial/whole blocks. Pure.
 */
export function parseFfmpegProgress(chunk: string): TranscodeProgress[] {
  const out: TranscodeProgress[] = [];
  let cur: TranscodeProgress = { done: false };
  let touched = false;

  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);

    if (key === "frame") {
      cur.frame = Number.parseInt(value, 10);
      touched = true;
    } else if (key === "out_time_us") {
      const us = Number.parseInt(value, 10);
      if (Number.isFinite(us)) cur.outTimeMs = Math.round(us / 1000);
      touched = true;
    } else if (key === "out_time_ms") {
      // Some ffmpeg builds emit out_time_ms (which is actually microseconds).
      const us = Number.parseInt(value, 10);
      if (Number.isFinite(us) && cur.outTimeMs === undefined) {
        cur.outTimeMs = Math.round(us / 1000);
      }
      touched = true;
    } else if (key === "progress") {
      cur.done = value === "end";
      out.push(cur);
      cur = { done: false };
      touched = false;
    }
  }
  if (touched) out.push(cur); // trailing partial block (no terminator yet)
  return out;
}
