/**
 * Pure 4-state keypoint helpers for the SLP format 3.0 point model:
 *
 * - `visible`:   labeled=true,  visible=true,  finite (x, y) — supervise present
 * - `occluded`:  labeled=true,  visible=false, finite (x, y) — supervise absent
 * - `unlabeled`: labeled=false, visible=false, (x, y) optional in memory — don't supervise
 * - `absent`:    labeled=true,  visible=false, [NaN, NaN]    — explicitly absent (no position)
 *
 * In memory during a labeling session, marking a placed point `unlabeled`
 * preserves its finite `(x, y)` coordinates so the node stays visible on canvas
 * (with a distinct unlabeled marker) and can be cycled cleanly through
 * `visible → occluded → unlabeled → visible` without vanishing. On save to SLP
 * 3.0 (or 2.x with `unlabeledAs: "absent"`), `sleap-io.js` / `sleap-io` scrub
 * coordinates of `labeled=false` points to `[NaN, NaN]` per the SLP 3.0 spec.
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

/**
 * Interactive 3-state cycle order for a placed keypoint on the canvas:
 * visible (supervise present) → occluded (supervise absent) → unlabeled (don't supervise) → visible.
 */
export const CYCLE_POINT_STATES = ["visible", "occluded", "unlabeled"] as const;
export type CyclePointState = (typeof CYCLE_POINT_STATES)[number];

export const POINT_STATE_LABELS: Record<PointState, string> = {
  visible: "Visible",
  occluded: "Occluded",
  absent: "Absent",
  unlabeled: "Unlabeled",
};

export const POINT_STATE_DESCRIPTIONS: Record<PointState, string> = {
  visible: "supervise present",
  occluded: "supervise absent",
  absent: "supervise absent (no position)",
  unlabeled: "don't supervise",
};

/** Next state in the 3-state cycle: visible → occluded → unlabeled → visible. */
export function nextCyclePointState(state: PointState): CyclePointState {
  switch (state) {
    case "visible":
      return "occluded";
    case "occluded":
      return "unlabeled";
    case "unlabeled":
    case "absent":
      return "visible";
  }
}

/**
 * True when a point has finite `(x, y)` coordinates (placed on canvas, whether
 * visible, occluded, or unlabeled in memory).
 */
export function hasPointCoords(p: PointLike): boolean {
  return Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
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
 * - `unlabeled` sets `visible = false`, `complete = false`, `labeled = false`
 *   while preserving any finite `(x, y)` coordinates in memory so the node does
 *   not disappear from the canvas during editing (unplaced NaN points stay NaN).
 *
 * Returns `true` when the transition is valid; returns `false` only when
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
      // visible first before setting labeled = false. Preserve finite `xy` in
      // memory so the user can see and toggle the node back without losing it.
      p.visible = false;
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
