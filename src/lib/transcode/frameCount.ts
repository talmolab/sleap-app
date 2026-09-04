/**
 * Exact frame count of a video's first stream via `ffprobe -count_frames`.
 *
 * `-count_frames` decodes the stream to report `nb_read_frames` — the true
 * decodable frame count — rather than a container estimate, so a scrub proxy
 * (or a seekbar) can trust frame N ↔ frame N alignment. Pure builder + parser
 * (unit-testable without a binary); the spawn is injected via {@link TranscodeDeps}.
 */

import type { TranscodeDeps } from "./transcodeVideo.js";

/** ffprobe args to count the decodable frames of the first video stream as JSON. */
export function frameCountArgs(path: string): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "json",
    path,
  ];
}

/** Read a positive-integer field of the first stream from ffprobe JSON, else `null`. */
function parseStreamIntField(stdout: string, field: string): number | null {
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<Record<string, unknown>>;
    };
    const n = Number(parsed?.streams?.[0]?.[field]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Parse ffprobe `-count_frames` JSON into a frame count. Returns the count when
 * it's a finite positive integer, else `null` (also `null` on malformed/empty
 * input or a parse error) so the caller can fall back to an estimate.
 */
export function parseFrameCount(stdout: string): number | null {
  return parseStreamIntField(stdout, "nb_read_frames");
}

/** Probe a file's exact (decoded) frame count via the ffprobe sidecar; `null` if unknown. */
export async function probeFrameCount(
  path: string,
  deps: Pick<TranscodeDeps, "exec">
): Promise<number | null> {
  const { stdout } = await deps.exec("ffprobe", frameCountArgs(path));
  return parseFrameCount(stdout);
}

/**
 * FAST frame-count args: read the container's `nb_frames` METADATA (the mp4
 * moov sample count) — kilobytes, NO decode — instead of `-count_frames`, which
 * decodes every frame (minutes on a big/network file). `nb_frames` is reliable
 * for finished mp4/mov; when it's absent/`N/A` (some containers), the caller
 * falls back to the exact {@link probeFrameCount}.
 */
export function containerFrameCountArgs(path: string): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_frames",
    "-of",
    "json",
    path,
  ];
}

/** Parse ffprobe container-metadata JSON (`nb_frames`); `null` if missing/`N/A`/≤0. */
export function parseContainerFrameCount(stdout: string): number | null {
  return parseStreamIntField(stdout, "nb_frames");
}

/** Probe a file's frame count from container metadata (fast, no decode); `null` if unknown. */
export async function probeContainerFrameCount(
  path: string,
  deps: Pick<TranscodeDeps, "exec">
): Promise<number | null> {
  const { stdout } = await deps.exec("ffprobe", containerFrameCountArgs(path));
  return parseContainerFrameCount(stdout);
}
