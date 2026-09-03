import type { Labels, Video } from "@/types";

/**
 * Highest labeled `frameIdx` (+1) for `video` — the seekbar's fallback length
 * when the video's own frame count is unknown (`video.shape[0]` unavailable).
 *
 * Uses a plain loop, NOT `Math.max(0, ...frameIdxs)`: on a project with many
 * thousands of labeled frames, spreading every index as a function argument is
 * expensive (and near the engine's argument-count limit). The `0` floor keeps
 * parity with the old expression (no frames → `Math.max(0)` → 0 → +1 = 1).
 */
export function inferFrameCount(labels: Labels | null, video: Video | null): number {
  if (!labels || !video) return 0;
  let max = 0;
  for (const lf of labels.find({ video })) {
    if (lf.frameIdx > max) max = lf.frameIdx;
  }
  return max + 1;
}
