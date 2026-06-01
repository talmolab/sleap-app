/**
 * Pure helpers for the status bar, ported from PyQt SLEAP's
 * MainWindow.updateStatusMessage / get_labeled_frame_count /
 * get_instances_to_show (sleap/gui/app.py, sleap_io_adaptors/lf_labels_utils.py).
 *
 * Kept free of React so they can be unit-tested directly under `bun test`.
 */
import type { Labels, Video, LabeledFrame } from "@/types";

/**
 * Count of instances shown in the GUI for a frame: user instances plus
 * predicted instances not superseded by a user instance (unused predictions).
 * Mirrors get_instances_to_show().
 */
export function instancesToShowCount(lf: LabeledFrame | null): number {
  if (!lf) return 0;
  return lf.userInstances.length + lf.unusedPredictions.length;
}

export interface StatusStats {
  /** 0-based index of `video` within `labels.videos`; -1 if absent. */
  videoIndex: number;
  totalVideos: number;
  /** Frames in `video` with >=1 user instance. */
  userInVideo: number;
  /** Frames across all videos with >=1 user instance. */
  userInProject: number;
  /** Frames in `video` with >=1 predicted instance. */
  predictedInVideo: number;
  /** predictedInVideo / totalFrames * 100 (0 when totalFrames is falsy). */
  predictedPct: number;
}

/**
 * Compute the per-video / per-project status-bar counts.
 * Ports get_labeled_frame_count(video, "user"|"predicted") plus the
 * Video {idx+1}/{N} index and predicted-percentage logic.
 */
export function computeStatusStats(
  labels: Labels | null,
  video: Video | null,
  totalFrames: number | null,
): StatusStats {
  const empty: StatusStats = {
    videoIndex: -1,
    totalVideos: 0,
    userInVideo: 0,
    userInProject: 0,
    predictedInVideo: 0,
    predictedPct: 0,
  };
  if (!labels) return empty;

  const frames = labels.labeledFrames;
  const totalVideos = labels.videos.length;
  const videoIndex = video ? labels.videos.indexOf(video) : -1;

  let userInProject = 0;
  let userInVideo = 0;
  let predictedInVideo = 0;
  for (const lf of frames) {
    if (lf.hasUserInstances) userInProject++;
    if (video && lf.video === video) {
      if (lf.hasUserInstances) userInVideo++;
      if (lf.hasPredictedInstances) predictedInVideo++;
    }
  }

  const predictedPct =
    totalFrames && totalFrames > 0
      ? (predictedInVideo / totalFrames) * 100
      : 0;

  return {
    videoIndex,
    totalVideos,
    userInVideo,
    userInProject,
    predictedInVideo,
    predictedPct,
  };
}
