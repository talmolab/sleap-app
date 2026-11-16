/**
 * Compare model predictions: which poses are the same animal, and where the
 * models disagree.
 *
 * Matching (multi-animal): on each frame, poses from different models are
 * grouped so each group is one animal. When every model's file has the same
 * set of track names, poses are grouped by track. Otherwise they're matched
 * by the Hungarian method on mean node distance: the model with the most poses
 * on the frame seeds the groups, and each other model's poses are assigned to
 * the closest group (a pose farther than {@link matchGate} from every group
 * starts its own).
 *
 * Disagreement (like Lightning Pose's ensemble variance): per group and node,
 * the spread of the models' positions — the RMS distance from their mean, i.e.
 * sqrt(var x + var y), in pixels. A node with at least two models placing it
 * and a spread above the threshold is flagged.
 */

import type { OverlayPose } from "./core";

/**
 * Minimum-cost assignment for a (possibly rectangular) cost matrix
 * (Hungarian / Kuhn–Munkres, O(n³)). Returns `assign[row] = col`, or -1 for a
 * row left unassigned when there are more rows than columns. Infinite costs
 * are treated as "never pair" (callers drop such pairs afterwards).
 */
export function hungarian(cost: readonly (readonly number[])[]): number[] {
  const nRows = cost.length;
  const nCols = nRows > 0 ? cost[0].length : 0;
  if (nRows === 0) return [];
  if (nCols === 0) return new Array(nRows).fill(-1);
  const n = Math.max(nRows, nCols);
  // Finite stand-in for Infinity, bigger than any real total.
  let maxFinite = 0;
  for (const row of cost) for (const c of row) if (Number.isFinite(c)) maxFinite = Math.max(maxFinite, Math.abs(c));
  const BIG = (maxFinite + 1) * (n + 1);
  const a = (i: number, j: number) => {
    if (i >= nRows || j >= nCols) return 0;
    const c = cost[i][j];
    return Number.isFinite(c) ? c : BIG;
  };
  // 1-indexed potentials, as in the classic e-maxx formulation.
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const assign = new Array(nRows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j] - 1;
    if (i >= 0 && i < nRows && j - 1 < nCols) assign[i] = j - 1;
  }
  return assign;
}

/** Mean distance over the nodes both poses have; Infinity when they share none. */
export function meanNodeDistance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < a.length && i + 1 < b.length; i += 2) {
    const dx = a[i] - b[i];
    const dy = a[i + 1] - b[i + 1];
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      sum += Math.hypot(dx, dy);
      n++;
    }
  }
  return n > 0 ? sum / n : Infinity;
}

/** Diagonal of a pose's bounding box (0 for fewer than two nodes). */
export function poseSize(xy: Float64Array): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < xy.length; i += 2) {
    const x = xy[i];
    const y = xy[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0) : 0;
}

/**
 * Farthest two poses can be (mean node distance) and still count as the same
 * animal: half the reference pose's size, but never under 20 px so tiny or
 * one-node skeletons still match.
 */
export function matchGate(reference: Float64Array): number {
  return Math.max(20, 0.5 * poseSize(reference));
}

/**
 * Match `poses` to `targets` one-to-one by mean node distance (Hungarian),
 * dropping pairs farther apart than the target's {@link matchGate}.
 * Returns `match[poseIdx] = targetIdx` or -1.
 */
export function matchPoses(poses: readonly Float64Array[], targets: readonly Float64Array[]): number[] {
  if (poses.length === 0) return [];
  if (targets.length === 0) return poses.map(() => -1);
  const cost = poses.map((p) => targets.map((t) => meanNodeDistance(p, t)));
  const assign = hungarian(cost);
  return assign.map((t, i) => (t >= 0 && cost[i][t] <= matchGate(targets[t]) ? t : -1));
}

/** One model's pose on the frame, by layer (model) and index in that layer's poses. */
export interface GroupMember {
  layer: number;
  pose: number;
}

/** A layer as matching sees it: the model's poses on this frame. */
export interface MatchLayer {
  poses: readonly OverlayPose[];
}

/** Mean position per node over the members that have it (NaN where none do). */
function groupMean(layers: readonly MatchLayer[], members: readonly GroupMember[], nValues: number): Float64Array {
  const out = new Float64Array(nValues);
  for (let k = 0; k < nValues; k += 2) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const m of members) {
      const xy = layers[m.layer].poses[m.pose].xy;
      if (Number.isFinite(xy[k]) && Number.isFinite(xy[k + 1])) {
        sx += xy[k];
        sy += xy[k + 1];
        n++;
      }
    }
    out[k] = n > 0 ? sx / n : NaN;
    out[k + 1] = n > 0 ? sy / n : NaN;
  }
  return out;
}

/**
 * Group the poses on one frame so each group is one animal (see the module
 * comment). `byTrack` groups by track name instead of position.
 */
export function groupAcrossModels(layers: readonly MatchLayer[], byTrack: boolean): GroupMember[][] {
  if (byTrack) {
    const groups = new Map<string, GroupMember[]>();
    const loose: GroupMember[][] = [];
    layers.forEach((layer, li) =>
      layer.poses.forEach((pose, pi) => {
        if (pose.trackName === null) {
          loose.push([{ layer: li, pose: pi }]);
          return;
        }
        const g = groups.get(pose.trackName);
        if (g) g.push({ layer: li, pose: pi });
        else groups.set(pose.trackName, [{ layer: li, pose: pi }]);
      })
    );
    return [...groups.values(), ...loose];
  }

  let ref = -1;
  layers.forEach((l, i) => {
    if (ref < 0 || l.poses.length > layers[ref].poses.length) ref = i;
  });
  if (ref < 0) return [];
  const groups: GroupMember[][] = layers[ref].poses.map((_, pi) => [{ layer: ref, pose: pi }]);
  layers.forEach((layer, li) => {
    if (li === ref || layer.poses.length === 0) return;
    const nValues = layer.poses[0].xy.length;
    const means = groups.map((g) => groupMean(layers, g, nValues));
    const match = matchPoses(
      layer.poses.map((p) => p.xy),
      means
    );
    match.forEach((gi, pi) => {
      if (gi >= 0) groups[gi].push({ layer: li, pose: pi });
      else groups.push([{ layer: li, pose: pi }]);
    });
  });
  return groups;
}

/** Whether every model has tracks and they all use the same track names. */
export function modelsShareTracks(trackNameSets: readonly ReadonlySet<string>[]): boolean {
  if (trackNameSets.length < 2) return false;
  const first = trackNameSets[0];
  if (first.size === 0) return false;
  return trackNameSets.every((s) => s.size === first.size && [...s].every((n) => first.has(n)));
}

/** One node where the models disagree. */
export interface Disagreement {
  group: number;
  node: number;
  /** Mean position of the models' placements, source-frame pixels. */
  x: number;
  y: number;
  /** RMS distance of the placements from (x, y), pixels. */
  spread: number;
}

/** Spread per node for one group; NaN where fewer than two models placed the node. */
export function nodeSpreads(layers: readonly MatchLayer[], members: readonly GroupMember[]): { mean: Float64Array; spread: Float64Array } {
  const nValues = members.length > 0 ? layers[members[0].layer].poses[members[0].pose].xy.length : 0;
  const mean = groupMean(layers, members, nValues);
  const spread = new Float64Array(nValues / 2);
  for (let k = 0; k < nValues; k += 2) {
    let ss = 0;
    let n = 0;
    for (const m of members) {
      const xy = layers[m.layer].poses[m.pose].xy;
      if (Number.isFinite(xy[k]) && Number.isFinite(xy[k + 1])) {
        ss += (xy[k] - mean[k]) ** 2 + (xy[k + 1] - mean[k + 1]) ** 2;
        n++;
      }
    }
    spread[k / 2] = n >= 2 ? Math.sqrt(ss / n) : NaN;
  }
  return { mean, spread };
}

/** Every node, in every group with two or more models, whose spread exceeds `threshold` px. */
export function findDisagreements(
  layers: readonly MatchLayer[],
  groups: readonly GroupMember[][],
  threshold: number
): Disagreement[] {
  const out: Disagreement[] = [];
  groups.forEach((g, gi) => {
    if (new Set(g.map((m) => m.layer)).size < 2) return;
    const { mean, spread } = nodeSpreads(layers, g);
    for (let node = 0; node < spread.length; node++) {
      const s = spread[node];
      if (Number.isFinite(s) && s > threshold) {
        out.push({ group: gi, node, x: mean[2 * node], y: mean[2 * node + 1], spread: s });
      }
    }
  });
  return out;
}
