import type { Video } from "@talmolab/sleap-io.js";

/**
 * Pick the video to select after `removed` is taken out of `videos`.
 *
 * `videos` is the list BEFORE removal. Returns the video now occupying the
 * removed slot (clamped to the new bounds) so the selection stays near where it
 * was, or `null` when no videos remain.
 */
export function nextSelectedVideo(
  videos: Video[],
  removed: Video,
): Video | null {
  const idx = videos.indexOf(removed);
  const remaining = videos.filter((v) => v !== removed);
  if (remaining.length === 0) return null;
  const target = Math.max(0, Math.min(idx, remaining.length - 1));
  return remaining[target];
}
