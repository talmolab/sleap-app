/**
 * Local scrub-proxy orchestration (desktop).
 *
 * {@link ensureScrubProxyPath} turns a source video path into a same-resolution,
 * short-GOP "scrub proxy" MP4 — a re-encode whose only purpose is cheap random
 * seeking (a short keyframe interval means few frames to decode after a seek),
 * cached once and reused thereafter. It mirrors the convert-once machinery in
 * {@link file://./transcodeVideo.ts} (temp `.part` → atomic rename, in-flight
 * dedup) but adds the one thing a proxy MUST have and the legacy transcode path
 * does not: a FRAME-EXACT gate. Before a freshly built proxy is published, its
 * decodable frame count is compared against the source; if they differ (or
 * either count is unknown) the proxy is discarded and the caller falls back to
 * the ORIGINAL path. A proxy that dropped/added a frame would misalign SLEAP
 * labels (which key off frame index) with the frames on screen — so we never
 * risk it. Proxies are kept separate from legacy transcodes and never reuse
 * that path's cache-string helpers, so that path stays 100% untouched.
 *
 * All platform I/O is injected via {@link TranscodeDeps} so the orchestration is
 * unit-testable with fakes; the real desktop impl is `createTauriTranscodeDeps`.
 */

import { probeFrameCount } from "./frameCount.js";
import { buildTranscodeArgs } from "./transcodeArgs.js";
import { computeCacheKey, proxyCacheFilename } from "./transcodeCache.js";
import {
  selectEncoder,
  type TranscodeDeps,
  type TranscodeProgress,
} from "./transcodeVideo.js";

/** The resolved path to open, and whether it is the proxy (vs. the original). */
export interface ScrubProxyResult {
  /** Absolute path: the published proxy, or the original source on fallback. */
  path: string;
  /** True when `path` is a scrub proxy; false when it's the original source. */
  isProxy: boolean;
}

/** Subdirectory under the OS cache dir for scrub proxies (sibling of transcodes). */
export const PROXY_SUBDIR = "proxies";

/**
 * Default proxy keyframe interval (GOP). Short = fast local seeks (few frames to
 * decode after a keyframe). Baked into the cache filename so a GOP change
 * self-invalidates the old proxy.
 */
export const PROXY_GOP = 15;

export interface EnsureScrubProxyOptions {
  /**
   * Fired once a proxy build is actually starting (real cache miss) — NOT on a
   * cache hit. `durationMs` (if known) lets a UI show a real progress %.
   */
  onStart?: (info: { durationMs?: number }) => void;
  /** Progress callback for a UI bar (forwarded to the ffmpeg run). */
  onProgress?: (p: TranscodeProgress) => void;
  /** Abort the (running) build; a cache hit ignores it. */
  signal?: AbortSignal;
  /** Source duration in ms — forwarded to `onStart` for a real progress %. */
  durationMs?: number;
  /** Keyframe interval override; defaults to {@link PROXY_GOP}. */
  gop?: number;
}

/**
 * In-flight proxy builds keyed by destination cache path — collapses concurrent
 * misses for the SAME proxy onto one build so two callers can't both write the
 * same `.part` and race on the publish rename (see {@link file://./transcodeVideo.ts}
 * `inFlightTranscodes` for the full rationale).
 */
const inFlightProxies = new Map<string, Promise<ScrubProxyResult>>();

/**
 * Ensure a frame-exact scrub proxy exists for `sourcePath` and return the path
 * to open. Cache hit → returns the cached proxy immediately (it already passed
 * the frame-exact gate when it was published, so no reconvert/re-check). Cache
 * miss → builds to a `.part` temp, verifies frame-count parity with the source,
 * then atomically publishes; on ANY parity failure (or an interrupted/failed
 * build) returns the original `sourcePath` untouched. Concurrent misses for the
 * same source share one build.
 */
export async function ensureScrubProxyPath(
  sourcePath: string,
  deps: TranscodeDeps,
  opts: EnsureScrubProxyOptions = {}
): Promise<ScrubProxyResult> {
  const gop = opts.gop ?? PROXY_GOP;
  const { size, mtimeMs } = await deps.stat(sourcePath);
  const key = computeCacheKey(sourcePath, size, mtimeMs);
  const dir = await deps.join(await deps.cacheDir(), PROXY_SUBDIR);
  const cachePath = await deps.join(dir, proxyCacheFilename(key, gop));

  // Convert-once: a cached proxy already cleared the frame-exact gate.
  if (await deps.exists(cachePath)) return { path: cachePath, isProxy: true };

  // Collapse a concurrent miss for the same destination onto the in-flight build.
  const inProgress = inFlightProxies.get(cachePath);
  if (inProgress) return inProgress;

  const work = buildProxy(sourcePath, dir, cachePath, gop, deps, opts);
  inFlightProxies.set(cachePath, work);
  try {
    return await work;
  } finally {
    inFlightProxies.delete(cachePath);
  }
}

/** The actual cache-miss build: temp → frame-exact gate → atomic publish. */
async function buildProxy(
  sourcePath: string,
  dir: string,
  cachePath: string,
  gop: number,
  deps: TranscodeDeps,
  opts: EnsureScrubProxyOptions
): Promise<ScrubProxyResult> {
  // real cache miss — work is about to happen
  opts.onStart?.({ durationMs: opts.durationMs });
  await deps.mkdir(dir);
  const tempPath = `${cachePath}.part`;
  await deps.remove(tempPath); // clear any stale partial from a prior crash

  const encoder = await selectEncoder(deps);
  const args = buildTranscodeArgs({
    input: sourcePath,
    output: tempPath,
    encoder,
    gopSize: gop,
  });

  try {
    await deps.runTranscode(args, opts.onProgress ?? (() => {}), opts.signal);
  } catch (err) {
    await deps.remove(tempPath); // don't leave a partial behind
    throw err;
  }

  // FRAME-EXACT gate (before publishing): a proxy that lost/gained a frame would
  // misalign labels. If we can't PROVE parity, discard and fall back to the source.
  const [srcFrames, proxyFrames] = await Promise.all([
    probeFrameCount(sourcePath, deps),
    probeFrameCount(tempPath, deps),
  ]);
  if (srcFrames == null || proxyFrames == null || srcFrames !== proxyFrames) {
    await deps.remove(tempPath);
    return { path: sourcePath, isProxy: false };
  }

  try {
    await deps.rename(tempPath, cachePath); // atomic publish
  } catch (err) {
    // Lost a publish race (a concurrent run — e.g. a second app instance sharing
    // the cache dir — already renamed our `.part`→final and moved the temp away)?
    // If the proxy we wanted is now present, that's success; else a real failure.
    await deps.remove(tempPath);
    if (await deps.exists(cachePath)) return { path: cachePath, isProxy: true };
    throw err;
  }
  return { path: cachePath, isProxy: true };
}
