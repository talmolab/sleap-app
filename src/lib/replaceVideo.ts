/**
 * Replace-video data core: re-point a project's labels from an old video to a
 * new one and trim labeled frames that fall beyond the new video's length.
 *
 * Pure and decode-free — the caller supplies an already-built `newVideo`
 * (typically backend-less with a known `shape`). Nothing here opens a backend
 * or decodes frames.
 *
 * Background: `Labels.replaceVideos` re-points `frame.video`, `suggestion.video`,
 * ROIs, swaps `labels.videos`, and invalidates indices — but it does NOT remove
 * labeled frames whose `frameIdx` exceeds the new video's frame count. When the
 * replacement is shorter, those frames are orphaned and must be trimmed here.
 */

import type { Labels, Video, LabeledFrame } from "../types";

/**
 * Labeled frames for `video` whose `frameIdx` is at or beyond `frameCount`
 * (i.e. orphaned by a shorter replacement video).
 *
 * If `frameCount` is not a finite number (NaN / undefined / Infinity), the
 * length is unknown or unbounded, so we cannot decide what to trim and return
 * `[]`.
 */
export function labeledFramesBeyond(
  labels: Labels,
  video: Video,
  frameCount: number,
): LabeledFrame[] {
  if (!Number.isFinite(frameCount)) return [];
  return labels.labeledFrames.filter(
    (lf) => lf.video === video && lf.frameIdx >= frameCount,
  );
}

/**
 * Re-point `oldVideo` → `newVideo` across `labels` (via `Labels.replaceVideos`),
 * then remove any labeled frames for `newVideo` whose `frameIdx` is beyond the
 * new video's length, then `reindex()`.
 *
 * The new video's frame count comes from `newVideo.shape[0]`; if that is not a
 * finite number the video is treated as unbounded (no trimming). No decode.
 *
 * @returns `{ trimmed }` — the number of orphaned labeled frames removed.
 */
export function applyVideoReplacement(
  labels: Labels,
  oldVideo: Video,
  newVideo: Video,
): { trimmed: number } {
  const shapeFrames = newVideo.shape?.[0];
  const newCount = Number.isFinite(shapeFrames)
    ? (shapeFrames as number)
    : Infinity;

  labels.replaceVideos({ videoMap: new Map([[oldVideo, newVideo]]) });

  const orphans = labeledFramesBeyond(labels, newVideo, newCount);
  if (orphans.length > 0) {
    const orphanSet = new Set<LabeledFrame>(orphans);
    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => !orphanSet.has(lf),
    );
  }

  labels.reindex();

  return { trimmed: orphans.length };
}
