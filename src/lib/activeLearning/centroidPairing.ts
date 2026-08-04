/**
 * Free-centroid pairing helpers (issue #212).
 *
 * A free centroid anchor is stored as a first-class {@link UserCentroid} on
 * `frame.centroids`, separate from the pose keypoints, so the pose model never
 * treats it as a keypoint. This module holds the label-mutating helpers that
 * back that flow: resolving the pose skeleton, topping up empty pose instances
 * so Phase-2 has one pose instance to label per centroid, and — the SINGLE
 * source of truth for which centroid belongs to which pose —
 * {@link pairCentroidsToPoses}.
 *
 * The pairing is computed ONCE and recorded on `centroid.instance` (a native
 * sleap-io back-link that persists to the SLP `/centroids` `instance` column),
 * so every consumer (the Phase-2 work list, the canvas overlay) reads the same
 * answer instead of re-guessing it from geometry on each repaint.
 */

import { Instance } from "@talmolab/sleap-io.js";
import type { LabeledFrame, Labels, Skeleton } from "@talmolab/sleap-io.js";
import { instanceCropCenter } from "./generateCrops";

/**
 * The pose skeleton to pair centroids against.
 *
 * Normally the project's first skeleton, but a project can pick up a SECOND,
 * 1-node skeleton called "centroid": that's how `sleap-nn predict
 * --centroid_output instance` represents detections, and once merged it stays in
 * the file. If such a skeleton were ever ordered first, returning it would make
 * every pose instance look foreign and the whole sweep would come up empty — so
 * skip a lone-"centroid" skeleton when a real pose skeleton exists.
 */
export function poseSkeletonOf(labels: Labels): Skeleton | null {
  const skels = labels.skeletons;
  if (skels.length === 0) return null;
  const isCentroidOnly = (s: Skeleton) =>
    s.nodes.length === 1 && s.nodes[0]?.name.toLowerCase() === "centroid";
  return skels.find((s) => !isCentroidOnly(s)) ?? skels[0];
}

/** Options for {@link pairCentroidsToPoses}. */
export interface PairCentroidsOptions {
  /**
   * Include locator-predicted centroids in the matching (default true). Turning
   * it off drops them from the candidate set entirely, exactly as the Phase-2
   * work list does when the sweep is restricted to human seeds.
   */
  includePredicted?: boolean;
}

/**
 * Match a frame's first-class centroid annotations to its pose instances.
 *
 * Returns an array PARALLEL to `frame.centroids` whose entries are indices into
 * `frame.instances` (`-1` = this centroid has no partner: it was filtered out,
 * has a non-finite location, or there were more centroids than poses).
 *
 * Pairing is GEOMETRIC, not positional: a pose instance with placed points
 * matches its nearest centroid (greedy, ascending distance, with MUTUAL
 * EXCLUSION so no pose is ever claimed twice), so a pose that was partially
 * labeled in an earlier sweep stays glued to ITS animal even after instances are
 * added, deleted, or reordered. The pose key is {@link instanceCropCenter} — a
 * fixed bounding-box anchor, not a running mean, so it doesn't drift as nodes
 * are placed. Empty pose instances carry no geometry and are interchangeable —
 * they take the remaining centroids in frame order.
 *
 * PURE: reads the frame, mutates nothing. {@link linkCentroidsToPoses} is what
 * writes the answer onto `centroid.instance`.
 */
export function pairCentroidsToPoses(
  frame: LabeledFrame,
  poseSkel: Skeleton,
  options: PairCentroidsOptions = {},
): number[] {
  const includePredicted = options.includePredicted ?? true;
  const poseForCentroidFull = new Array<number>(frame.centroids.length).fill(-1);

  // Candidate centroids, keeping each one's index into the FULL
  // `frame.centroids` array so the result stays parallel to it.
  const centroids: { x: number; y: number; idx: number }[] = [];
  frame.centroids.forEach((c, idx) => {
    const [x, y] = c.xy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (c.isPredicted && !includePredicted) return;
    centroids.push({ x, y, idx });
  });
  const poses: { center: [number, number] | null; idx: number }[] = [];
  frame.instances.forEach((inst, idx) => {
    if (inst.skeleton !== poseSkel) return;
    poses.push({ center: instanceCropCenter(inst, poseSkel, undefined), idx });
  });
  if (centroids.length === 0 || poses.length === 0) return poseForCentroidFull;

  // Greedy nearest matching between PLACED poses and centroids, ascending by
  // distance (ties broken by centroid then pose order, for determinism).
  const candidates: { ci: number; pi: number; d: number }[] = [];
  for (let ci = 0; ci < centroids.length; ci++) {
    for (let pi = 0; pi < poses.length; pi++) {
      const pc = poses[pi].center;
      if (!pc) continue;
      const dx = pc[0] - centroids[ci].x;
      const dy = pc[1] - centroids[ci].y;
      candidates.push({ ci, pi, d: dx * dx + dy * dy });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.ci - b.ci || a.pi - b.pi);
  const poseForCentroid = new Array<number>(centroids.length).fill(-1);
  const centroidTaken = new Set<number>();
  const poseTaken = new Set<number>();
  for (const { ci, pi } of candidates) {
    if (centroidTaken.has(ci) || poseTaken.has(pi)) continue;
    poseForCentroid[ci] = pi;
    centroidTaken.add(ci);
    poseTaken.add(pi);
  }
  // Remaining centroids take the remaining (empty) poses in frame order.
  let nextFree = 0;
  for (let ci = 0; ci < centroids.length; ci++) {
    if (poseForCentroid[ci] >= 0) continue;
    while (nextFree < poses.length && poseTaken.has(nextFree)) nextFree++;
    if (nextFree >= poses.length) break;
    poseForCentroid[ci] = nextFree;
    poseTaken.add(nextFree);
  }

  for (let ci = 0; ci < centroids.length; ci++) {
    const pi = poseForCentroid[ci];
    if (pi >= 0) poseForCentroidFull[centroids[ci].idx] = poses[pi].idx;
  }
  return poseForCentroidFull;
}

/**
 * Record {@link pairCentroidsToPoses}'s answer on `centroid.instance` for every
 * frame, so the binding is decided ONCE instead of re-guessed by each consumer.
 *
 * Only MISSING links are filled in: a centroid that already carries a link (a
 * locator prediction, or a project loaded back from disk) keeps it, and the pose
 * it points at is treated as taken so two centroids can never share one
 * instance. Mutates `labels`; returns how many links were newly assigned (0 when
 * everything was already linked, which callers use to detect a true no-op).
 */
export function linkCentroidsToPoses(labels: Labels, poseSkel: Skeleton): number {
  let linked = 0;
  for (const lf of labels.labeledFrames) {
    // Poses already spoken for by an existing link are off the table.
    const claimed = new Set<number>();
    for (const c of lf.centroids) {
      if (!c.instance) continue;
      const i = lf.instances.indexOf(c.instance);
      if (i >= 0) claimed.add(i);
    }
    const poseForCentroid = pairCentroidsToPoses(lf, poseSkel);
    for (let ci = 0; ci < poseForCentroid.length; ci++) {
      const c = lf.centroids[ci];
      if (!c || c.instance) continue;
      const pi = poseForCentroid[ci];
      if (pi < 0 || claimed.has(pi)) continue;
      c.instance = lf.instances[pi];
      claimed.add(pi);
      linked += 1;
    }
  }
  return linked;
}

/**
 * Repoint any centroid linked to `from` at `to`. Call this wherever an instance
 * is REPLACED in place (adopt-on-touch, convert-prediction-to-instance): the
 * `.instance` back-link is by object identity, so a silent swap would orphan the
 * centroid and its overlay color would jump.
 */
export function relinkCentroids(frame: LabeledFrame, from: Instance, to: Instance): void {
  for (const c of frame.centroids) {
    if (c.instance === from) c.instance = to;
  }
}

/** What {@link ensurePairedPoseInstances} changed. */
export interface EnsurePairedResult {
  /** Empty pose instances appended so every centroid has a partner. */
  created: number;
  /** Centroids whose `.instance` back-link was newly filled in. */
  linked: number;
}

/**
 * Ensure every frame has at least as many pose instances as it has (finite)
 * first-class centroid annotations (`frame.centroids`), appending empty pose
 * instances (all nodes unplaced) so Phase-2 has a pose instance to label per
 * centroid — then record the centroid→pose binding on `centroid.instance`
 * ({@link linkCentroidsToPoses}). Pairing is EAGER: the instances exist and the
 * links are set up front, before any keypoint is placed.
 *
 * Mutates `labels`; returns what changed, so a caller can tell a true no-op
 * (nothing created AND nothing newly linked) from real work.
 */
export function ensurePairedPoseInstances(
  labels: Labels,
  poseSkel: Skeleton,
): EnsurePairedResult {
  let created = 0;
  for (const lf of labels.labeledFrames) {
    const nCentroid = lf.centroids.filter(
      (c) => Number.isFinite(c.xy[0]) && Number.isFinite(c.xy[1]),
    ).length;
    let nPose = lf.instances.filter((i) => i.skeleton === poseSkel).length;
    while (nPose < nCentroid) {
      lf.instances.push(Instance.empty({ skeleton: poseSkel }));
      nPose += 1;
      created += 1;
    }
  }
  return { created, linked: linkCentroidsToPoses(labels, poseSkel) };
}
