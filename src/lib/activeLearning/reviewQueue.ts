/**
 * Phase-3 keypoint-correction review queue (active-learning loop).
 *
 * PURE + React-free + side-effect-free so it is fully unit-testable. Given a
 * project's predicted instances, it produces the ordered "review queue" the
 * correction sweep walks: the worst predictions first, so human effort goes
 * where the model is least sure. All data mutation (adopting/correcting points,
 * navigating frames, undo snapshots) lives in the store/VideoPlayer — this
 * module only decides WHAT to review next, never touches the data model.
 *
 * Ranking is by the WORST SINGLE keypoint per instance: an instance's sort key
 * is the lowest confidence among its scored points. That surfaces instances with
 * at least one bad keypoint (the ones most worth a human's eyes) ahead of
 * uniformly-mediocre ones. Ties break by mean confidence, then frame order, so
 * the queue is deterministic.
 *
 * This is deliberately NOT the `prediction_score` suggestion strategy, which
 * ranks by the per-INSTANCE grouping score (unbounded); correction cares about
 * per-POINT confidence in [0, 1], matching `mine.scoreThreshold`.
 */

import type { Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { instanceCropCenter } from "./generateCrops";

/**
 * One predicted instance queued for correction. Resolved to a live `Instance`
 * on demand via {@link resolveReviewInstance} — indices survive undo and the
 * adopt-in-place conversion (which swaps a user instance in at the same index),
 * a live reference would not.
 *
 * The score fields are a SNAPSHOT of the prediction at queue-build time, so the
 * details sidebar keeps showing the original per-keypoint confidence even after
 * the instance is adopted (a user `Instance` carries no scores).
 */
export interface ReviewItem {
  /** Index into `labels.videos`. */
  videoIdx: number;
  /** Source frame index within that video. */
  frameIdx: number;
  /** Index into the frame's `instances` (the predicted instance to correct). */
  instanceIdx: number;
  /** Lowest confidence among the instance's scored points (the sort key). */
  worstScore: number;
  /** Skeleton node index of that lowest-confidence point (for display). */
  worstNodeIdx: number;
  /** Mean confidence across scored points (tie-break + display). */
  meanScore: number;
  /** The prediction's own instance score, or null if absent. */
  instanceScore: number | null;
  /** Per-node confidence aligned to skeleton node order; null where unscored. */
  pointScores: (number | null)[];
  /** Zoom anchor (instance centroid) in SOURCE coords, for framing the view. */
  centroidXY: [number, number];
}

/** Options for {@link buildReviewQueue}. */
export interface BuildReviewQueueOptions {
  /** Cap the queue to the N worst instances. `undefined`/`<= 0` = no cap. */
  limit?: number;
  /**
   * Only include instances whose worst keypoint is at or below this confidence.
   * `undefined` includes every scored prediction (the cap alone bounds the set).
   */
  scoreThreshold?: number;
}

/** Reduced confidence stats for one instance, or the raw per-node scores. */
export interface InstanceScoreStats {
  worstScore: number;
  worstNodeIdx: number;
  meanScore: number;
}

/**
 * Per-node confidence for an instance, aligned to skeleton node order. Returns
 * `null` at any node that isn't a scored, on-screen, correctable keypoint —
 * every node of a user instance, an unscored predicted point, and (crucially) an
 * invisible or off-canvas (NaN) predicted point. The last case matters because
 * SLEAP predictions carry a score on occluded/below-threshold points too: those
 * can't be drawn, ringed, or dragged, so ranking or flagging on them would point
 * the labeler at a keypoint that isn't there. Only visible, finite points count.
 */
export function pointScoresOf(inst: Instance): (number | null)[] {
  const pts = inst.points;
  const out: (number | null)[] = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const s = (p as { score?: number }).score;
    const drawable = p.visible && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
    out[i] = drawable && typeof s === "number" && Number.isFinite(s) ? s : null;
  }
  return out;
}

/**
 * Reduce per-node scores to the worst/mean stats, or `null` when no node has a
 * score (nothing to rank on).
 */
export function scoreStats(pointScores: (number | null)[]): InstanceScoreStats | null {
  let worstScore = Infinity;
  let worstNodeIdx = -1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pointScores.length; i++) {
    const s = pointScores[i];
    if (s === null) continue;
    if (s < worstScore) {
      worstScore = s;
      worstNodeIdx = i;
    }
    sum += s;
    n += 1;
  }
  if (n === 0) return null;
  return { worstScore, worstNodeIdx, meanScore: sum / n };
}

/** Frames ordered video → frameIdx (the queue's frame order). */
function sortedFrames(labels: Labels): LabeledFrame[] {
  const videos = labels.videos;
  return [...labels.labeledFrames].sort((a, b) => {
    const va = videos.indexOf(a.video);
    const vb = videos.indexOf(b.video);
    if (va !== vb) return va - vb;
    return a.frameIdx - b.frameIdx;
  });
}

/**
 * Build the ordered correction queue: every scored `PredictedInstance`, worst
 * single keypoint first. Unscored predictions and all user instances are
 * skipped (nothing to rank/correct). With a `limit`, only the N worst are
 * returned; with a `scoreThreshold`, only instances that have a keypoint at or
 * below it are included.
 */
export function buildReviewQueue(
  labels: Labels,
  options: BuildReviewQueueOptions = {},
): ReviewItem[] {
  const { limit, scoreThreshold } = options;
  const videos = labels.videos;
  const items: ReviewItem[] = [];

  for (const lf of sortedFrames(labels)) {
    const videoIdx = videos.indexOf(lf.video);
    if (videoIdx < 0) continue;
    const insts = lf.instances;
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      if (!(inst instanceof PredictedInstance)) continue;
      const pointScores = pointScoresOf(inst);
      const stats = scoreStats(pointScores);
      if (!stats) continue;
      if (typeof scoreThreshold === "number" && stats.worstScore > scoreThreshold) {
        continue;
      }
      const center = instanceCropCenter(inst, inst.skeleton, undefined);
      items.push({
        videoIdx,
        frameIdx: lf.frameIdx,
        instanceIdx: i,
        worstScore: stats.worstScore,
        worstNodeIdx: stats.worstNodeIdx,
        meanScore: stats.meanScore,
        instanceScore: typeof inst.score === "number" ? inst.score : null,
        pointScores,
        centroidXY: center ?? [NaN, NaN],
      });
    }
  }

  // Worst single keypoint first; deterministic tie-breaks.
  items.sort(
    (a, b) =>
      a.worstScore - b.worstScore ||
      a.meanScore - b.meanScore ||
      a.videoIdx - b.videoIdx ||
      a.frameIdx - b.frameIdx ||
      a.instanceIdx - b.instanceIdx,
  );

  if (typeof limit === "number" && limit > 0 && items.length > limit) {
    return items.slice(0, limit);
  }
  return items;
}

/**
 * Summarise what a fresh batch of predictions means for review, without
 * building the queue the user will actually sweep.
 *
 * `total` counts every scored prediction; `flagged` counts the subset with a
 * keypoint at/below `scoreThreshold` (what {@link buildReviewQueue} would
 * return for that threshold). Keeping both lets the caller distinguish three
 * outcomes that deserve different words: nothing merged, merged-but-confident,
 * and genuinely needs-review.
 */
export function reviewSignal(
  labels: Labels,
  scoreThreshold: number,
): { flagged: number; total: number } {
  // One pass: the unthresholded queue already carries each item's worst score.
  const all = buildReviewQueue(labels);
  let flagged = 0;
  for (const item of all) {
    if (item.worstScore <= scoreThreshold) flagged += 1;
  }
  return { flagged, total: all.length };
}

/**
 * Resolve a queued item to its live `Instance`, or `null` if the frame or
 * instance no longer exists. Resolves by index every time so it survives undo
 * and the adopt-in-place conversion (mirrors passEngine's resolveItemInstance).
 */
export function resolveReviewInstance(labels: Labels, item: ReviewItem): Instance | null {
  const video = labels.videos[item.videoIdx];
  if (!video) return null;
  const frames = labels.find({ video, frameIdx: item.frameIdx });
  if (frames.length === 0) return null;
  return frames[0].instances[item.instanceIdx] ?? null;
}
