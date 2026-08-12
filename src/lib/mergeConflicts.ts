/**
 * Conflict enumeration for Merge into Project (A3).
 *
 * A conflict is a CONNECTED COMPONENT of the bipartite "within-5px" graph over
 * {base instances ∪ donor instances} on a shared (matched-video, frameIdx). A
 * base instance can clash with several donors and vice versa, so pairwise
 * matches are grouped into clusters and resolved as a unit (survivor set) — see
 * the design doc. This module is pure/data-only; the spatial matching primitive
 * comes from io (`InstanceMatcher`), the resolution/apply lives elsewhere.
 */

import { Instance, InstanceMatcher, InstanceMatchMethod } from "@talmolab/sleap-io.js";
import type { MergeResult } from "@talmolab/sleap-io.js";
import type { Labels, Video } from "@/types";

/** Matchers shared by A2's merge and A3's conflict apply (see MergeIntoProjectCommand). */
const MERGE_MATCHERS = { video: "basename", track: "name" } as const;

/** A conflict cluster as index sets into a frame's base/donor instance arrays. */
export interface Cluster {
  baseIdxs: number[];
  donorIdxs: number[];
}

/** One resolved conflict cluster on a shared frame (live instance references). */
export interface Conflict {
  /** Stable id for React keys: `${videoIdx}:${frameIdx}:${clusterIdx}`. */
  id: string;
  /** The BASE video the frame belongs to (donor video mapped through match). */
  video: Video;
  frameIdx: number;
  /** Cluster's base-side user instances (live refs into the base frame). */
  baseInstances: Instance[];
  /** Cluster's donor-side user instances (live refs into the donor frame). */
  donorInstances: Instance[];
  /** Min mean-node distance (px) among the cluster's matched pairs — Δpx triage. */
  distance: number;
}

/** Exact-type user instance (excludes PredictedInstance). */
const isUser = (inst: Instance): boolean => inst.constructor === Instance;

/**
 * Group raw matched pairs `[baseIdx, donorIdx]` into connected components.
 *
 * Only instances that appear in at least one pair are included (unmatched
 * instances aren't conflicts). Output is deterministic: clusters in first-seen
 * base-then-donor order, indices within a cluster in first-seen order.
 */
export function buildClusters(
  matches: ReadonlyArray<readonly [number, number]>
): Cluster[] {
  const parent = new Map<string, string>();
  const ensure = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path-compress.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    ensure(a);
    ensure(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // First-seen order of each index, for deterministic output.
  const orderedBase: number[] = [];
  const orderedDonor: number[] = [];
  for (const [b, d] of matches) {
    if (!parent.has(`b${b}`)) orderedBase.push(b);
    if (!parent.has(`d${d}`)) orderedDonor.push(d);
    union(`b${b}`, `d${d}`);
  }

  const byRoot = new Map<string, Cluster>();
  const order: string[] = [];
  const add = (key: string, side: "base" | "donor", idx: number) => {
    const root = find(key);
    let c = byRoot.get(root);
    if (!c) {
      c = { baseIdxs: [], donorIdxs: [] };
      byRoot.set(root, c);
      order.push(root);
    }
    const arr = side === "base" ? c.baseIdxs : c.donorIdxs;
    if (!arr.includes(idx)) arr.push(idx);
  };
  for (const b of orderedBase) add(`b${b}`, "base", b);
  for (const d of orderedDonor) add(`d${d}`, "donor", d);

  return order.map((r) => byRoot.get(r)!);
}

/**
 * Enumerate user-vs-user merge conflicts between `base` and `donor`, WITHOUT
 * mutating either. Video/skeleton/track mapping comes from io `match()`
 * (basename video, name tracks — same as A2/the apply); per shared frame, io's
 * `InstanceMatcher` (spatial, `threshold` px, default 5) finds clashing pairs,
 * which {@link buildClusters} groups into connected components.
 *
 * Predictions are excluded (A3 is user-vs-user; predictions flow through the
 * merge strategy). Returns live instance references so the apply step can delete
 * the exact losers.
 */
export async function enumerateConflicts(
  base: Labels,
  donor: Labels,
  opts: { threshold?: number } = {}
): Promise<Conflict[]> {
  const threshold = opts.threshold ?? 5;
  const matchResult = await base.match(donor, MERGE_MATCHERS);
  const videoMap = matchResult.videoMap as Map<Video, Video>;
  const matcher = new InstanceMatcher(InstanceMatchMethod.SPATIAL, { threshold });

  const conflicts: Conflict[] = [];
  for (const dFrame of donor.labeledFrames) {
    const mappedVideo = videoMap.get(dFrame.video) ?? dFrame.video;
    const baseFrames = base.find({
      video: mappedVideo,
      frameIdx: dFrame.frameIdx,
    });
    if (!baseFrames.length) continue; // donor-only frame → no clash

    const baseUser = baseFrames[0].instances.filter(isUser);
    const donorUser = dFrame.instances.filter(isUser);
    if (!baseUser.length || !donorUser.length) continue;

    const pairs = matcher.findMatches(baseUser, donorUser); // [i, j, score]
    if (!pairs.length) continue;

    const clusters = buildClusters(pairs.map(([i, j]) => [i, j] as const));
    const videoIdx = base.videos.indexOf(mappedVideo);
    clusters.forEach((cluster, ci) => {
      // Δpx = min mean-node distance among this cluster's pairs (score = 1/(1+d)).
      let best = Infinity;
      for (const [i, j, score] of pairs) {
        if (cluster.baseIdxs.includes(i) && cluster.donorIdxs.includes(j)) {
          const dist = score > 0 ? 1 / score - 1 : Infinity;
          if (dist < best) best = dist;
        }
      }
      conflicts.push({
        id: `${videoIdx}:${dFrame.frameIdx}:${ci}`,
        video: mappedVideo,
        frameIdx: dFrame.frameIdx,
        baseInstances: cluster.baseIdxs.map((i) => baseUser[i]),
        donorInstances: cluster.donorIdxs.map((j) => donorUser[j]),
        distance: best === Infinity ? 0 : best,
      });
    });
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Resolution + apply
// ---------------------------------------------------------------------------

/** Per-cluster resolution: keep the base pose, the donor pose, or both. */
export type ConflictChoice = "base" | "donor" | "both";

/** A conflict paired with the user's (or default) choice. */
export interface ResolvedConflict {
  conflict: Conflict;
  choice: ConflictChoice;
}

/**
 * Compile per-cluster choices into the exact instances to delete from each side
 * before a `keep_both` merge:
 * - `base`  → drop the cluster's donor instances
 * - `donor` → drop the cluster's base instances
 * - `both`  → drop nothing
 *
 * Clusters are disjoint connected components, so each instance appears in at
 * most one conflict — the delete sets never contradict.
 */
export function compileDeletions(resolved: ResolvedConflict[]): {
  base: Set<Instance>;
  donor: Set<Instance>;
} {
  const base = new Set<Instance>();
  const donor = new Set<Instance>();
  for (const { conflict, choice } of resolved) {
    if (choice === "base") {
      for (const d of conflict.donorInstances) donor.add(d);
    } else if (choice === "donor") {
      for (const b of conflict.baseInstances) base.add(b);
    }
    // "both": keep everything.
  }
  return { base, donor };
}

/** Remove the given instances from a Labels in place, then reindex. */
function deleteInstances(labels: Labels, toDelete: Set<Instance>): void {
  if (!toDelete.size) return;
  for (const lf of labels.labeledFrames) {
    if (lf.instances.some((i) => toDelete.has(i))) {
      lf.instances = lf.instances.filter((i) => !toDelete.has(i));
    }
  }
  // Instances changed but the frame COUNT did not — io's count-guarded track
  // index would miss it. Force a rebuild (same lesson as the A2 undo fix).
  labels.reindex();
}

/**
 * Apply per-conflict resolutions by pre-deleting the losers, then a single
 * `keep_both` merge — `keep_both` is a dumb concatenator, so the survivors are
 * exactly the resolved result (design doc). Mutates `base` (and the transient
 * `donor`) in place; the caller wraps this in an undo snapshot.
 *
 * With every choice `"both"` (the default) this reduces to a plain
 * `base.merge(donor, keep_both)` — i.e. identical to A2's Keep-both strategy.
 */
export async function applyConflictResolutions(
  base: Labels,
  donor: Labels,
  resolved: ResolvedConflict[]
): Promise<MergeResult> {
  const { base: baseDel, donor: donorDel } = compileDeletions(resolved);
  deleteInstances(base, baseDel);
  deleteInstances(donor, donorDel);
  return base.merge(donor, { ...MERGE_MATCHERS, frame: "keep_both" });
}
