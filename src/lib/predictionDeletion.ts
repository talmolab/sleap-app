/**
 * Which predictions each "Delete Predictions" command removes (#463).
 *
 * Each selector returns the (frame, prediction) pairs to delete, without
 * changing anything, so the commands and the dialog's "N will be deleted"
 * preview always agree. The scopes match PyQt SLEAP's commands of the same
 * name (`sleap/gui/commands.py`, `DeleteClipPredictions` through
 * `DeleteUserFramePredictions`):
 *
 * - low score, beyond max instances, outside frame range, clip and area all
 *   act on the **current video** only;
 * - area tests every frame of that video, not just the current one;
 * - user-labeled frames can act on the current video or all videos.
 *
 * Only `PredictedInstance`s (and, from the box selectors at the end,
 * `PredictedBoundingBox`es) are ever returned, so user labels are never
 * deleted by these commands.
 */

import {
  PredictedBoundingBox,
  PredictedInstance,
  type Labels,
  type LabeledFrame,
  type Video,
} from "@talmolab/sleap-io.js";

/** A prediction to delete and the frame it is in. */
export type PredictionPair = [LabeledFrame, PredictedInstance];

/** The frames of one video, or of every video when `video` is null. */
function framesOf(labels: Labels, video: Video | null): LabeledFrame[] {
  if (video === null) return labels.labeledFrames;
  return labels.labeledFrames.filter((lf) => lf.video === video);
}

function predictionsIn(lf: LabeledFrame): PredictedInstance[] {
  return lf.instances.filter(
    (inst): inst is PredictedInstance => inst instanceof PredictedInstance,
  );
}

/** Predictions in the current video with a score below `threshold`. */
export function predictionsWithLowScore(
  labels: Labels,
  video: Video,
  threshold: number,
): PredictionPair[] {
  const out: PredictionPair[] = [];
  for (const lf of framesOf(labels, video)) {
    for (const p of predictionsIn(lf)) {
      if (p.score < threshold) out.push([lf, p]);
    }
  }
  return out;
}

/**
 * Predictions in the current video on frames outside `[start, end]`
 * (0-based, inclusive). The range is what to keep. Other videos are left
 * alone: their frame numbers don't line up with this video's.
 */
export function predictionsOutsideFrameRange(
  labels: Labels,
  video: Video,
  start: number,
  end: number,
): PredictionPair[] {
  const out: PredictionPair[] = [];
  for (const lf of framesOf(labels, video)) {
    if (lf.frameIdx >= start && lf.frameIdx <= end) continue;
    for (const p of predictionsIn(lf)) out.push([lf, p]);
  }
  return out;
}

/**
 * Predictions in the current video on frames inside `[start, end]` (0-based,
 * inclusive) — the clip selected on the seekbar.
 */
export function predictionsInClip(
  labels: Labels,
  video: Video,
  start: number,
  end: number,
): PredictionPair[] {
  const out: PredictionPair[] = [];
  for (const lf of framesOf(labels, video)) {
    if (lf.frameIdx < start || lf.frameIdx > end) continue;
    for (const p of predictionsIn(lf)) out.push([lf, p]);
  }
  return out;
}

/**
 * On each frame of the current video with more than `maxInstances`
 * predictions, the lowest-scoring ones beyond the top `maxInstances`. Ties go
 * the way PyQt's stable ascending sort sends them (the earlier one is deleted).
 */
export function predictionsBeyondMaxInstances(
  labels: Labels,
  video: Video,
  maxInstances: number,
): PredictionPair[] {
  const keep = Math.max(0, Math.floor(maxInstances));
  const out: PredictionPair[] = [];
  for (const lf of framesOf(labels, video)) {
    const preds = predictionsIn(lf);
    if (preds.length <= keep) continue;
    const byScore = [...preds].sort((a, b) => a.score - b.score);
    for (const p of byScore.slice(0, preds.length - keep)) out.push([lf, p]);
  }
  return out;
}

/** An axis-aligned box in image coordinates; corners may be in any order. */
export interface AreaBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Predictions on **every frame** of the current video whose visible points all
 * lie inside the box (edges included). This is for static false detections,
 * like a reflection, that show up in the same place all through a video.
 * As in PyQt, a prediction with no visible points counts as inside.
 */
export function predictionsInArea(
  labels: Labels,
  video: Video,
  box: AreaBox,
): PredictionPair[] {
  const minX = Math.min(box.x1, box.x2);
  const maxX = Math.max(box.x1, box.x2);
  const minY = Math.min(box.y1, box.y2);
  const maxY = Math.max(box.y1, box.y2);
  const inside = (p: PredictedInstance) =>
    p.points.every((pt) => {
      const [x, y] = pt.xy;
      if (!pt.visible || !Number.isFinite(x) || !Number.isFinite(y)) return true;
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    });
  const out: PredictionPair[] = [];
  for (const lf of framesOf(labels, video)) {
    for (const p of predictionsIn(lf)) {
      if (inside(p)) out.push([lf, p]);
    }
  }
  return out;
}

/**
 * Predictions on frames that also have a user instance, in the current video
 * (`video`) or in all videos (`video === null`). With `unlinkedOnly`, a
 * prediction a user instance on that frame was made from (`fromPredicted`) is
 * kept: only the unlinked ones show up as duplicates next to the user labels.
 */
export function predictionsOnUserLabeledFrames(
  labels: Labels,
  video: Video | null,
  unlinkedOnly: boolean,
): PredictionPair[] {
  const out: PredictionPair[] = [];
  for (const lf of framesOf(labels, video)) {
    const users = lf.instances.filter((inst) => !(inst instanceof PredictedInstance));
    if (users.length === 0) continue;
    const linked = new Set<PredictedInstance>();
    if (unlinkedOnly) {
      for (const u of users) if (u.fromPredicted) linked.add(u.fromPredicted);
    }
    for (const p of predictionsIn(lf)) {
      if (!linked.has(p)) out.push([lf, p]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Predicted boxes
//
// A box detector's predictions are boxes (`PredictedBoundingBox` in
// `LabeledFrame.bboxes`), not instances. Each selector below picks the boxes
// the matching instance selector's command deletes too, with the same scope.
// User boxes are never returned.
// ---------------------------------------------------------------------------

/** A predicted box to delete and the frame it is in. */
export type PredictedBoxPair = [LabeledFrame, PredictedBoundingBox];

function predictedBoxesIn(lf: LabeledFrame): PredictedBoundingBox[] {
  return lf.bboxes.filter((b): b is PredictedBoundingBox => b instanceof PredictedBoundingBox);
}

/** Predicted boxes in the current video scoring below `threshold`. */
export function boxesWithLowScore(labels: Labels, video: Video, threshold: number): PredictedBoxPair[] {
  const out: PredictedBoxPair[] = [];
  for (const lf of framesOf(labels, video)) {
    for (const b of predictedBoxesIn(lf)) if (b.score < threshold) out.push([lf, b]);
  }
  return out;
}

/** Predicted boxes in the current video on frames outside `[start, end]`. */
export function boxesOutsideFrameRange(labels: Labels, video: Video, start: number, end: number): PredictedBoxPair[] {
  const out: PredictedBoxPair[] = [];
  for (const lf of framesOf(labels, video)) {
    if (lf.frameIdx >= start && lf.frameIdx <= end) continue;
    for (const b of predictedBoxesIn(lf)) out.push([lf, b]);
  }
  return out;
}

/** Predicted boxes in the current video on frames inside `[start, end]`. */
export function boxesInClip(labels: Labels, video: Video, start: number, end: number): PredictedBoxPair[] {
  const out: PredictedBoxPair[] = [];
  for (const lf of framesOf(labels, video)) {
    if (lf.frameIdx < start || lf.frameIdx > end) continue;
    for (const b of predictedBoxesIn(lf)) out.push([lf, b]);
  }
  return out;
}

/** On each frame of the current video, the lowest-scoring predicted boxes beyond the top `maxInstances`. */
export function boxesBeyondMaxInstances(labels: Labels, video: Video, maxInstances: number): PredictedBoxPair[] {
  const keep = Math.max(0, Math.floor(maxInstances));
  const out: PredictedBoxPair[] = [];
  for (const lf of framesOf(labels, video)) {
    const boxes = predictedBoxesIn(lf);
    if (boxes.length <= keep) continue;
    const byScore = [...boxes].sort((a, b) => a.score - b.score);
    for (const b of byScore.slice(0, boxes.length - keep)) out.push([lf, b]);
  }
  return out;
}

/** Predicted boxes on every frame of the current video whose corners all lie inside `box`. */
export function boxesInArea(labels: Labels, video: Video, box: AreaBox): PredictedBoxPair[] {
  const minX = Math.min(box.x1, box.x2);
  const maxX = Math.max(box.x1, box.x2);
  const minY = Math.min(box.y1, box.y2);
  const maxY = Math.max(box.y1, box.y2);
  const inside = (b: PredictedBoundingBox) =>
    b.corners.every(([x, y]) => x >= minX && x <= maxX && y >= minY && y <= maxY);
  const out: PredictedBoxPair[] = [];
  for (const lf of framesOf(labels, video)) {
    for (const b of predictedBoxesIn(lf)) if (inside(b)) out.push([lf, b]);
  }
  return out;
}

/**
 * Predicted boxes on frames that also have user labels (a user instance or a
 * user box), in the current video or all videos (`video === null`). With
 * `unlinkedOnly`, a box linked to a user instance, or to the prediction a user
 * instance was made from, is kept.
 */
export function boxesOnUserLabeledFrames(labels: Labels, video: Video | null, unlinkedOnly: boolean): PredictedBoxPair[] {
  const out: PredictedBoxPair[] = [];
  for (const lf of framesOf(labels, video)) {
    const users = lf.instances.filter((inst) => !(inst instanceof PredictedInstance));
    const hasUserBox = lf.bboxes.some((b) => !(b instanceof PredictedBoundingBox));
    if (users.length === 0 && !hasUserBox) continue;
    const keep = new Set<unknown>();
    if (unlinkedOnly) {
      for (const u of users) {
        keep.add(u);
        if (u.fromPredicted) keep.add(u.fromPredicted);
      }
    }
    for (const b of predictedBoxesIn(lf)) {
      if (!(b.instance && keep.has(b.instance))) out.push([lf, b]);
    }
  }
  return out;
}

/** Predicted boxes on a track (`trackName`), or untracked ones (`null`), in every video. */
export function boxesOnTrack(labels: Labels, trackName: string | null): PredictedBoxPair[] {
  const out: PredictedBoxPair[] = [];
  for (const lf of labels.labeledFrames) {
    for (const b of predictedBoxesIn(lf)) {
      if (trackName === null ? !b.track : b.track?.name === trackName) out.push([lf, b]);
    }
  }
  return out;
}
