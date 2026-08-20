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
import { TRANSCODE_EXT, cacheFilename, computeCacheKey } from "./transcodeCache.js";
import { codecNeedsTranscode } from "./videoCodecSupport.js";
import {
  parseEncoderList,
  parseFfprobeCodec,
  pickH264Encoder,
} from "./videoProbe.js";

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
  /** List entry names (files) in a directory; rejects/empty if absent. */
  readDir: (dir: string) => Promise<string[]>;
  /**
   * One-shot run of a bundled tool, capturing output (for `ffprobe` codec
   * detection and `ffmpeg -encoders`). Resolves regardless of exit code so the
   * caller can inspect `code`/`stderr`.
   */
  exec: (
    tool: "ffmpeg" | "ffprobe",
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  /**
   * Streaming transcode via the bundled ffmpeg, reporting parsed progress.
   * Rejects on a nonzero exit or spawn failure; honors `signal` (kills the
   * child on abort).
   */
  runTranscode: (
    args: string[],
    onProgress: (p: TranscodeProgress) => void,
    signal?: AbortSignal
  ) => Promise<void>;
}

export interface TranscodeToMp4Options {
  /** Progress callback for a UI bar. */
  onProgress?: (p: TranscodeProgress) => void;
  /**
   * Fired once a transcode is actually starting (real cache miss) — NOT on a
   * cache hit or a decodable file. `durationMs` (if the probe knew it) lets the
   * UI show a real progress %. Use it to open a "converting…" dialog.
   */
  onTranscodeStart?: (info: { durationMs?: number }) => void;
  /** Abort the (running) transcode; a cache hit ignores it. */
  signal?: AbortSignal;
  /** Source duration in ms (from the probe) — forwarded to `onTranscodeStart`. */
  durationMs?: number;
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

  // real cache miss — work is about to happen
  options.onTranscodeStart?.({ durationMs: options.durationMs });
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
    await deps.runTranscode(
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

/** ffprobe args to read the first video stream's codec + pixel format as JSON. */
function ffprobeCodecArgs(path: string): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt,duration",
    "-of",
    "json",
    path,
  ];
}

/** Probe a file's first video stream (codec + pix_fmt) via the ffprobe sidecar. */
export async function probeVideo(path: string, deps: TranscodeDeps) {
  const { stdout } = await deps.exec("ffprobe", ffprobeCodecArgs(path));
  return parseFfprobeCodec(stdout);
}

// Cache the chosen encoder across calls — `ffmpeg -encoders` is invariant per
// bundled binary, so probe it at most once per session.
let cachedEncoder: string | null = null;

/** Pick (and memoize) a permissive H.264 encoder the bundled ffmpeg supports. */
export async function selectEncoder(deps: TranscodeDeps): Promise<string> {
  if (cachedEncoder) return cachedEncoder;
  const { stdout } = await deps.exec("ffmpeg", ["-hide_banner", "-encoders"]);
  cachedEncoder = pickH264Encoder(parseEncoderList(stdout));
  return cachedEncoder;
}

/** Test-only: reset the memoized encoder. */
export function __resetEncoderCache(): void {
  cachedEncoder = null;
}

export interface EnsureDecodableResult {
  /** The path to open: the original (decodable) or the cached transcode. */
  path: string;
  /** True when a transcode happened (so the caller records the original). */
  transcoded: boolean;
  /** The probed source codec, if detection succeeded. */
  codec?: string;
}

/**
 * Return a path the WebCodecs/Mp4Box path can decode: the ORIGINAL if its codec
 * is already decodable (H.264/HEVC/VP8-9/AV1/MJPEG), else a cached H.264 MP4
 * produced by transcoding. Desktop-only (needs the ffmpeg/ffprobe sidecars).
 * If probing fails (unknown/odd file), returns the original unchanged so the
 * existing backend still gets a chance (and can surface its own error).
 */
export async function ensureDecodablePath(
  sourcePath: string,
  deps: TranscodeDeps,
  options: TranscodeToMp4Options = {}
): Promise<EnsureDecodableResult> {
  const probed = await probeVideo(sourcePath, deps);
  if (!probed) return { path: sourcePath, transcoded: false };
  if (!codecNeedsTranscode(probed.codec, probed.pixFmt)) {
    return { path: sourcePath, transcoded: false, codec: probed.codec };
  }
  const encoder = await selectEncoder(deps);
  const mp4 = await transcodeToMp4(sourcePath, deps, {
    ...options,
    encoder,
    durationMs: probed.durationMs,
  });
  return { path: mp4, transcoded: true, codec: probed.codec };
}

// ── Cache maintenance (for a "clear transcode cache" UI) ─────────────────────

export interface TranscodeCacheInfo {
  /** Number of finished transcodes (`.mp4`) in the cache. */
  count: number;
  /** Total bytes on disk (finished `.mp4`s; ignores stray `.part`). */
  bytes: number;
}

/** Resolve the transcode cache directory (`<cacheDir>/transcodes`). */
async function transcodeCacheDir(deps: TranscodeDeps): Promise<string> {
  return deps.join(await deps.cacheDir(), TRANSCODE_SUBDIR);
}

/** Summarize the transcode cache (count + total bytes). Empty if the dir is absent. */
export async function getTranscodeCacheInfo(
  deps: TranscodeDeps
): Promise<TranscodeCacheInfo> {
  const dir = await transcodeCacheDir(deps);
  let names: string[];
  try {
    names = await deps.readDir(dir);
  } catch {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!name.endsWith(TRANSCODE_EXT)) continue;
    count++;
    try {
      bytes += (await deps.stat(await deps.join(dir, name))).size;
    } catch {
      /* raced deletion — ignore */
    }
  }
  return { count, bytes };
}

/**
 * Delete every cached transcode (`.mp4`) plus any stray `.part` temps, and
 * return what was freed. Safe: entries are regenerable from the originals.
 */
export async function clearTranscodeCache(
  deps: TranscodeDeps
): Promise<TranscodeCacheInfo> {
  const dir = await transcodeCacheDir(deps);
  let names: string[];
  try {
    names = await deps.readDir(dir);
  } catch {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    const isMp4 = name.endsWith(TRANSCODE_EXT);
    if (!isMp4 && !name.endsWith(".part")) continue;
    const path = await deps.join(dir, name);
    try {
      bytes += (await deps.stat(path)).size;
    } catch {
      /* ignore */
    }
    await deps.remove(path);
    if (isMp4) count++;
  }
  return { count, bytes };
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
