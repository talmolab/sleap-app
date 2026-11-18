/**
 * Keypoint review: proofreading one node (e.g. *nose*) across the project's
 * labels, one instance at a time. This module builds the list to step
 * through; the store (keypointReviewStore) drives the canvas.
 *
 * Labels only: user instances of one skeleton, never predictions.
 */
import type { Instance, Labels, Skeleton } from "@talmolab/sleap-io.js";
import { sameSkeletonStructure } from "@/lib/skeletonStructure";
import { fitSimilarity, applySimilarity, typicalPose, type Pose } from "@/lib/analyze/qc/typicalPose";

/** Which instances to go through. */
export type KeypointReviewSource = "all" | "suggestions" | "qc" | "worst";

export const KEYPOINT_REVIEW_SOURCES: { source: KeypointReviewSource; label: string; title: string }[] = [
  { source: "all", label: "All labels", title: "Every labeled instance, in frame order" },
  { source: "suggestions", label: "Suggestions", title: "Instances on suggested frames only" },
  { source: "qc", label: "QC blames it", title: "Instances Label QC flagged with this node behind the flag" },
  {
    source: "worst",
    label: "Worst first",
    title: "Furthest from where this node usually sits relative to the rest of the body first",
  },
];

export interface KeypointReviewItem {
  videoIdx: number;
  frameIdx: number;
  /** Index into the frame's `userInstances`. */
  instIdx: number;
  /**
   * "worst" only: how far the node is from its typical spot, in body radii
   * (the instance's RMS node distance from its centre). Infinity when the
   * node isn't placed; null when it can't be scored.
   */
  offBy?: number | null;
}

export const keypointItemKey = (v: number, f: number, i: number) => `${v}:${f}:${i}`;

/** Visible, placed nodes as `[x, y]`; the rest NaN. */
export function visiblePose(inst: Instance): Pose {
  return inst.points.map((p) =>
    p.visible && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]) ? [p.xy[0], p.xy[1]] : [NaN, NaN],
  );
}

/** Every user instance of `skeleton` (or a structurally identical one), in video and frame order. */
function allItems(labels: Labels, skeleton: Skeleton): (KeypointReviewItem & { inst: Instance })[] {
  const out: (KeypointReviewItem & { inst: Instance })[] = [];
  labels.videos.forEach((video, videoIdx) => {
    const frames = [...labels.find({ video })].sort((a, b) => a.frameIdx - b.frameIdx);
    for (const lf of frames) {
      lf.userInstances.forEach((inst, instIdx) => {
        if (inst.skeleton !== skeleton && !sameSkeletonStructure(inst.skeleton, skeleton)) return;
        out.push({ videoIdx, frameIdx: lf.frameIdx, instIdx, inst });
      });
    }
  });
  return out;
}

/**
 * How far `node` sits from where the typical pose puts it, fitted on the
 * instance's other nodes, in body radii. Infinity when the node isn't placed;
 * null when there are too few other nodes to fit.
 */
export function nodeOffBy(template: Pose, pose: Pose, node: number): number | null {
  const at = pose[node];
  if (!at || !Number.isFinite(at[0])) return Infinity;
  const others = pose.map((p, i) => (i === node ? [NaN, NaN] : p));
  const placed = others.filter((p) => Number.isFinite(p[0]));
  if (placed.length < 2) return null;
  const t = fitSimilarity(template, others);
  if (!t) return null;
  const expected = applySimilarity(t, template)[node];
  if (!expected || !Number.isFinite(expected[0])) return null;
  const cx = placed.reduce((s, p) => s + p[0], 0) / placed.length;
  const cy = placed.reduce((s, p) => s + p[1], 0) / placed.length;
  const radius = Math.sqrt(placed.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / placed.length);
  if (!(radius > 0)) return null;
  return Math.hypot(at[0] - expected[0], at[1] - expected[1]) / radius;
}

export interface KeypointQueueOptions {
  skeleton: Skeleton;
  node: number;
  source: KeypointReviewSource;
  /** "qc": keys ({@link keypointItemKey}) of the instances QC blames this node on. */
  qcBlamed?: ReadonlySet<string>;
}

/** The instances to go through for `node`, in review order. */
export function buildKeypointQueue(labels: Labels, opts: KeypointQueueOptions): KeypointReviewItem[] {
  const items = allItems(labels, opts.skeleton);
  const strip = ({ videoIdx, frameIdx, instIdx, offBy }: KeypointReviewItem) =>
    offBy === undefined ? { videoIdx, frameIdx, instIdx } : { videoIdx, frameIdx, instIdx, offBy };

  if (opts.source === "suggestions") {
    const suggested = new Set(
      (labels.suggestions ?? []).map((s) => `${labels.videos.indexOf(s.video)}:${s.frameIdx}`),
    );
    return items.filter((it) => suggested.has(`${it.videoIdx}:${it.frameIdx}`)).map(strip);
  }
  if (opts.source === "qc") {
    const blamed = opts.qcBlamed ?? new Set<string>();
    return items.filter((it) => blamed.has(keypointItemKey(it.videoIdx, it.frameIdx, it.instIdx))).map(strip);
  }
  if (opts.source === "worst") {
    const poses = items.map((it) => visiblePose(it.inst));
    const template = typicalPose(poses);
    const scored = items.map((it, i) => ({
      ...it,
      offBy: template ? nodeOffBy(template, poses[i], opts.node) : null,
    }));
    // Worst placed nodes first; then unscorable; unplaced last (often just hidden).
    const rank = (x: number | null | undefined) =>
      x === Infinity ? 2 : x === null || x === undefined ? 1 : 0;
    scored.sort((a, b) => {
      const r = rank(a.offBy) - rank(b.offBy);
      return r !== 0 || rank(a.offBy) !== 0 ? r : (b.offBy as number) - (a.offBy as number);
    });
    return scored.map(strip);
  }
  return items.map(strip);
}
