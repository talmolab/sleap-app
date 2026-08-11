/**
 * Pure helper for the Instances panel's readable named-point list.
 *
 * Pairs each of an instance's keypoints with its skeleton node name, in point
 * order, for on-screen display. The clipboard copy still emits the plain
 * `np.array([...])` (see `formatPointsAsPython`); this is display-only.
 */

import type { Instance, PredictedInstance } from "../types";

export interface NamedPoint {
  /** Node name from the skeleton, in point order. */
  name: string;
  /** Whether the keypoint is visible (invisible ones render as such). */
  visible: boolean;
  /** X coordinate (NaN when not visible, matching the np.nan copy handling). */
  x: number;
  /** Y coordinate (NaN when not visible). */
  y: number;
}

/**
 * Zip an instance's points with their skeleton node names (in point order).
 * Node names come from `instance.skeleton.nodes`; falls back to the point's own
 * derived name, then a positional placeholder, so the list is never blank.
 */
export function instanceNamedPoints(
  instance: Instance | PredictedInstance,
): NamedPoint[] {
  const nodes = instance.skeleton?.nodes ?? [];
  return instance.points.map((pt, i) => ({
    name: nodes[i]?.name ?? pt.name ?? `node ${i}`,
    visible: pt.visible,
    x: pt.xy[0],
    y: pt.xy[1],
  }));
}
