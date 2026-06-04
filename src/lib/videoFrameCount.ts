import type { Video } from "@/types";

/**
 * The frame count to display for a video in the Videos panel.
 *
 * For an embedded `pkg.slp` video this is the number of stored (embedded)
 * images — `Video.embeddedFrameIndices.length` — which is what PyQt SLEAP shows
 * in its Frames column. That is distinct from `shape[0]`, the SOURCE extent the
 * seekbar spans (a sparse package embeds only a subset of the source frames).
 *
 * Regular videos have no embedded set, so they fall back to the source frame
 * count (`shape[0]`). Returns null when neither is known (shown as "?").
 */
export function displayFrameCount(video: Video | null): number | null {
  if (!video) return null;
  const embedded = video.embeddedFrameIndices;
  if (embedded && embedded.length > 0) return embedded.length;
  return video.shape?.[0] ?? null;
}
