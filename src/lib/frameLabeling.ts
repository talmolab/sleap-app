/**
 * The app's single, canonical definition of "did a human label this frame".
 *
 * Historically the app decided this by looking for a non-predicted skeleton
 * INSTANCE. That misses other kinds of manual labeling — most importantly a
 * USER-placed centroid (the active-learning workflow), but also user bounding
 * boxes, masks, ROIs, and negative/background-frame flags. io.js already models
 * this exactly via `LabeledFrame.isUserLabeled` (mirroring Python
 * `LabeledFrame.is_user_labeled`): user instances OR a non-predicted
 * centroid/bbox/mask/ROI/label-image OR the negative flag. Predicted-only frames
 * and empty frames are NOT user-labeled.
 *
 * Delegating to `isUserLabeled` keeps the app in agreement with io.js / Python
 * everywhere a frame is counted, listed, or navigated as "labeled".
 */
import type { LabeledFrame, Labels, Video } from "@talmolab/sleap-io.js";

/** True if a human labeled this frame (any user annotation, not just a pose). */
export function isUserLabeledFrame(
  lf: Pick<LabeledFrame, "isUserLabeled">,
): boolean {
  return lf.isUserLabeled;
}

/** True if `labels` has any user labeling at (`video`, `frameIdx`). */
export function frameHasUserLabels(
  labels: Pick<Labels, "find"> | null,
  video: Video,
  frameIdx: number,
): boolean {
  if (!labels) return false;
  const frames = labels.find({ video, frameIdx });
  return frames.length > 0 && isUserLabeledFrame(frames[0]);
}
