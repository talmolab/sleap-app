/**
 * Pure 4-state keypoint helpers for the SLP format 3.0 point model:
 *
 * - `visible`:   labeled=true,  visible=true,  finite (x, y) — positive target
 * - `occluded`:  labeled=true,  visible=false, finite (x, y) — hidden with coords
 * - `absent`:    labeled=true,  visible=false, [NaN, NaN]    — explicitly absent
 * - `unlabeled`: labeled=false, visible=false, [NaN, NaN]    — not annotated (masked in training)
 */

import type { Instance, PredictedInstance } from "@/types";
import { isUnlabeledPoint, type PointLike } from "@/lib/slpFormat";

export type PointState = "visible" | "occluded" | "absent" | "unlabeled";

export const POINT_STATES: readonly PointState[] = [
  "visible",
  "occluded",
  "absent",
  "unlabeled",
] as const;

export const POINT_STATE_LABELS: Record<PointState, string> = {
  visible: "Visible",
  occluded: "Occluded",
  absent: "Absent",
  unlabeled: "Unlabeled",
};

/** True when a point has finite coordinates and is labeled (visible or occluded). */
export function hasPointCoords(p: PointLike): boolean {
  return (
    !isUnlabeledPoint(p) &&
    Number.isFinite(p.xy[0]) &&
    Number.isFinite(p.xy[1])
  );
}

/** Classify a point into one of the four SLP 3.0 point states. */
export function getPointState(p: PointLike): PointState {
  if (isUnlabeledPoint(p)) return "unlabeled";
  if (!Number.isFinite(p.xy[0]) || !Number.isFinite(p.xy[1])) return "absent";
  return p.visible ? "visible" : "occluded";
}

/**
 * Transition a point in place to `state`.
 *
 * - `visible` / `occluded` require finite coordinates (returns `false` on a
 *   point with NaN coordinates, since placing coordinates requires the canvas).
 * - `absent` clears coordinates to `[NaN, NaN]` with `visible = false`,
 *   `complete = false`, `labeled = true`.
 * - `unlabeled` clears coordinates to `[NaN, NaN]` with `visible = false`,
 *   `complete = false`, `labeled = false`.
 *
 * Returns `true` when the transition is valid (even if already in `state` is
 * checked by caller or applied idempotently); returns `false` only when
 * `visible`/`occluded` is requested for an unplaced point.
 */
export function applyPointState(p: PointLike, state: PointState): boolean {
  switch (state) {
    case "visible": {
      if (!hasPointCoords(p)) return false;
      p.visible = true;
      p.complete = true;
      p.labeled = true;
      return true;
    }
    case "occluded": {
      if (!hasPointCoords(p)) return false;
      p.visible = false;
      p.labeled = true;
      return true;
    }
    case "absent": {
      // Clear visible before mutating labeled/xy so PointView stays consistent.
      p.visible = false;
      p.xy = [Number.NaN, Number.NaN];
      p.complete = false;
      p.labeled = true;
      return true;
    }
    case "unlabeled": {
      // PointView enforces `visible === true => labeled === true`, so clear
      // visible first before setting labeled = false.
      p.visible = false;
      p.xy = [Number.NaN, Number.NaN];
      p.complete = false;
      p.labeled = false;
      return true;
    }
  }
}

export interface PointStateCounts {
  visible: number;
  occluded: number;
  absent: number;
  unlabeled: number;
  total: number;
}

/** Count how many nodes of an instance are in each of the 4 point states. */
export function countPointStates(
  instance: Pick<Instance | PredictedInstance, "points">,
): PointStateCounts {
  const counts: PointStateCounts = {
    visible: 0,
    occluded: 0,
    absent: 0,
    unlabeled: 0,
    total: instance.points.length,
  };
  for (const pt of instance.points) {
    counts[getPointState(pt)]++;
  }
  return counts;
}

/** Human-readable tooltip breakdown of an instance's 4-state node counts. */
export function formatPointStateSummary(counts: PointStateCounts): string {
  const parts: string[] = [`${counts.visible} visible`];
  if (counts.occluded > 0) parts.push(`${counts.occluded} occluded`);
  if (counts.absent > 0) parts.push(`${counts.absent} absent`);
  if (counts.unlabeled > 0) {
    parts.push(`${counts.unlabeled} unlabeled (ignored in training)`);
  }
  return `${parts.join(", ")} of ${counts.total} nodes`;
}

/**
 * Find the next unplaced node strictly after `afterIdx` (no wrap-around).
 *
 * Used when marking the active placement target as `unlabeled` or `absent` so
 * stepping through a skeleton finishes cleanly at the end instead of looping
 * back over nodes just marked unplaced.
 */
export function nextUnplacedNodeForward(
  points: readonly PointLike[],
  afterIdx: number,
): number {
  for (let i = afterIdx + 1; i < points.length; i++) {
    if (!hasPointCoords(points[i])) return i;
  }
  return -1;
}
