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

/**
 * Parse ffprobe `-count_frames` JSON into a frame count. Returns the count when
 * it's a finite positive integer, else `null` (also `null` on malformed/empty
 * input or a parse error) so the caller can fall back to an estimate.
 */
export function parseFrameCount(stdout: string): number | null {
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ nb_read_frames?: unknown }>;
    };
    const n = Number(parsed?.streams?.[0]?.nb_read_frames);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Probe a file's exact frame count via the ffprobe sidecar; `null` if unknown. */
export async function probeFrameCount(
  path: string,
  deps: Pick<TranscodeDeps, "exec">
): Promise<number | null> {
  const { stdout } = await deps.exec("ffprobe", frameCountArgs(path));
  return parseFrameCount(stdout);
}
