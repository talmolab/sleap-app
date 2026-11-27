/**
 * Pure helpers for the "Merge into Project" feature (File ▸ Merge into Project…).
 *
 * Kept free of React / store / io-call side effects so they are unit-testable in
 * isolation. The actual merge runs through sleap-io.js `Labels.merge` in
 * {@link file://./../commands/mergeProjectCommands.ts}; the preview uses the
 * non-mutating `Labels.match`. This module only:
 *   - maps the dialog's strategy radio to io's `FrameStrategy` string,
 *   - summarizes a `MatchResult` into the preview panel's counts, and
 *   - formats a `MergeResult` into the result toast line.
 *
 * See docs / memory `project_merge_into_project_design` for the locked A2 scope.
 */

import {
  Edge,
  Instance,
  InstanceMatcher,
  InstanceMatchMethod,
  Node,
  Skeleton,
  type Labels,
  type MatchResult,
  type MergeResult,
} from "@talmolab/sleap-io.js";
import type { Video } from "@/types";
import { remapInstancePoints, type UnmappedNodeFill } from "@/lib/skeletonIO";
import { buildClusters, type Conflict } from "@/lib/mergeConflicts";

/** The four conflict-resolution choices the dialog exposes. */
export type MergeStrategyChoice = "smart" | "keep_both" | "new_wins" | "base_wins";

export interface MergeStrategyOption {
  value: MergeStrategyChoice;
  label: string;
  hint: string;
}

/** Radio options, in display order (Smart is the default/first). */
export const MERGE_STRATEGY_OPTIONS: MergeStrategyOption[] = [
  {
    value: "smart",
    label: "Smart / auto",
    hint: "Recommended — keep both unless they are the same instance",
  },
  { value: "keep_both", label: "Keep both", hint: "Keep every instance from both files" },
  { value: "new_wins", label: "New wins", hint: "On conflict, keep the incoming instance" },
  { value: "base_wins", label: "Base wins", hint: "On conflict, keep this project's instance" },
];

/**
 * Map a UI strategy choice to sleap-io.js's `FrameStrategy` string (the raw
 * value passed as `merge`'s `frame` option). "new/base wins" map to
 * keep_new/keep_original — on a per-frame conflict io keeps that side's
 * instance.
 */
export function mergeStrategyToFrameStrategy(choice: MergeStrategyChoice): string {
  switch (choice) {
    case "smart":
      return "auto";
    case "keep_both":
      return "keep_both";
    case "new_wins":
      return "keep_new";
    case "base_wins":
      return "keep_original";
  }
}

/** Structural preview derived from a non-mutating `Labels.match`. */
export interface MatchPreview {
  videosMatched: number;
  videosNew: number;
  /** Basenames of the incoming videos with no match (appended as new). */
  newVideoNames: string[];
  skeletonsMatched: number;
  skeletonsNew: number;
  tracksMatched: number;
  tracksNew: number;
  /**
   * True when the incoming project's skeleton(s) differ structurally from this
   * project's. Retained as `skeletonBlocked` for backwards compatibility with
   * callers/tests that inspect the raw `MatchResult` check; the Merge dialog
   * now offers skeleton reconciliation (unify or keep separate) instead of
   * hard-blocking.
   */
  skeletonBlocked: boolean;
  /** Alias for `skeletonBlocked`: true when skeleton reconciliation is needed. */
  skeletonDiffers: boolean;
}

/** How to reconcile differing skeletons during File ▸ Merge into Project…. */
export type SkeletonMergeMode = "unify" | "separate";

/** Node-level diff when merging a project whose skeleton differs from the base. */
export interface SkeletonMergeDiff {
  /** True when both projects have a single skeleton that can be unified. */
  canUnify: boolean;
  /** Node names present in both skeletons (in base order). */
  sharedNodes: string[];
  /** Node names present only in the base project's skeleton. */
  baseOnlyNodes: string[];
  /** Node names present only in the incoming project's skeleton. */
  donorOnlyNodes: string[];
  /** Total node count of the unified skeleton (`base + donorOnly`). */
  unionNodeCount: number;
  /** Recommended reconciliation mode for this pair of projects. */
  defaultMode: SkeletonMergeMode;
}

/** Basename of a Video filename (string, or first element of an image-seq list). */
function videoBasename(filename: unknown): string {
  const s = Array.isArray(filename)
    ? String(filename[0] ?? "")
    : String(filename ?? "");
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** Reduce a `MatchResult` to the dialog's preview counts. */
export function summarizeMatch(match: MatchResult): MatchPreview {
  const differs = isMergeBlockedBySkeleton(match);
  return {
    videosMatched: match.nVideosMatched,
    videosNew: match.unmatchedVideos.length,
    newVideoNames: match.unmatchedVideos.map((v) =>
      videoBasename((v as { filename?: unknown }).filename)
    ),
    skeletonsMatched: match.nSkeletonsMatched,
    skeletonsNew: match.unmatchedSkeletons.length,
    tracksMatched: match.nTracksMatched,
    tracksNew: match.unmatchedTracks.length,
    skeletonBlocked: differs,
    skeletonDiffers: differs,
  };
}

/**
 * True when the incoming file's skeleton(s) did not structurally match this
 * project's skeletons in `Labels.match`.
 */
export function isMergeBlockedBySkeleton(match: MatchResult): boolean {
  return !match.allSkeletonsMatched;
}

/**
 * Describe how two projects' skeletons differ so `MergeProjectDialog` can
 * offer node-union reconciliation (with `unmapped: "unlabeled" | "absent"`)
 * or keeping both as separate skeletons. Returns `null` when skeletons match.
 */
export function describeSkeletonMergeDiff(
  base: Labels,
  donor: Labels,
  match: MatchResult,
): SkeletonMergeDiff | null {
  if (match.allSkeletonsMatched) return null;
  const baseSkel = base.skeletons.length === 1 ? base.skeletons[0] : null;
  const donorSkel = donor.skeletons.length === 1 ? donor.skeletons[0] : null;
  if (!baseSkel || !donorSkel) {
    return {
      canUnify: false,
      sharedNodes: [],
      baseOnlyNodes: [],
      donorOnlyNodes: [],
      unionNodeCount: 0,
      defaultMode: "separate",
    };
  }

  const baseNames = baseSkel.nodes.map((n) => n.name);
  const donorNames = donorSkel.nodes.map((n) => n.name);
  const baseSet = new Set(baseNames);
  const donorSet = new Set(donorNames);

  const sharedNodes = baseNames.filter((n) => donorSet.has(n));
  const baseOnlyNodes = baseNames.filter((n) => !donorSet.has(n));
  const donorOnlyNodes = donorNames.filter((n) => !baseSet.has(n));

  return {
    canUnify: true,
    sharedNodes,
    baseOnlyNodes,
    donorOnlyNodes,
    unionNodeCount: baseNames.length + donorOnlyNodes.length,
    defaultMode: sharedNodes.length > 0 ? "unify" : "separate",
  };
}

/**
 * Build a unified skeleton taking the node union (`base` nodes in order, then
 * `donor`-only nodes in order), the union of edges, and non-conflicting
 * symmetries from both skeletons.
 */
export function buildUnifiedSkeleton(
  baseSkel: Skeleton,
  donorSkel: Skeleton,
): Skeleton {
  const baseNames = baseSkel.nodes.map((n) => n.name);
  const baseSet = new Set(baseNames);
  const donorOnlyNames = donorSkel.nodes
    .map((n) => n.name)
    .filter((name) => !baseSet.has(name));
  const unionNames = [...baseNames, ...donorOnlyNames];

  const unified = new Skeleton({
    nodes: unionNames,
    name: baseSkel.name || donorSkel.name,
  });

  const nodeByName = new Map(unified.nodes.map((n) => [n.name, n]));
  const seenEdges = new Set<string>();
  const addEdge = (srcName: string, dstName: string) => {
    const key = `${srcName}\0${dstName}`;
    if (seenEdges.has(key)) return;
    const src = nodeByName.get(srcName);
    const dst = nodeByName.get(dstName);
    if (!src || !dst) return;
    seenEdges.add(key);
    unified.edges.push(new Edge(src, dst));
  };

  for (const e of baseSkel.edges) addEdge(e.source.name, e.destination.name);
  for (const e of donorSkel.edges) addEdge(e.source.name, e.destination.name);

  unified.rebuildCache(unified.nodes);

  const pairedNodes = new Set<string>();
  const addSym = (leftName: string, rightName: string) => {
    if (pairedNodes.has(leftName) || pairedNodes.has(rightName)) return;
    try {
      unified.addSymmetry(leftName, rightName);
      pairedNodes.add(leftName);
      pairedNodes.add(rightName);
    } catch {
      // Skip symmetries that cannot be recreated on the union.
    }
  };
  for (const [l, r] of baseSkel.symmetryNames) addSym(l, r);
  for (const [l, r] of donorSkel.symmetryNames) addSym(l, r);

  return unified;
}

function applyStructureInPlace(
  target: Skeleton,
  template: Skeleton,
  labels: Labels,
  unmapped: UnmappedNodeFill,
): void {
  const oldNodes = [...target.nodes];
  const newNodes = template.nodes.map((n) => new Node(n.name));
  const byName = new Map(newNodes.map((n) => [n.name, n]));

  target.name = template.name;
  target.nodes = newNodes;
  target.edges = template.edges
    .map((e) => {
      const s = byName.get(e.source.name);
      const d = byName.get(e.destination.name);
      return s && d ? new Edge(s, d) : null;
    })
    .filter((e): e is Edge => e !== null);
  target.rebuildCache(target.nodes);

  target.symmetries = [];
  for (const [l, r] of template.symmetryNames) {
    try {
      target.addSymmetry(l, r);
    } catch {
      // best effort
    }
  }

  const emptyLinks = new Map<string, string>();
  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) {
      inst.points = remapInstancePoints(inst, oldNodes, newNodes, emptyLinks, unmapped);
      inst.skeleton = target;
    }
  }
}

/**
 * Reconcile two single-skeleton `Labels` in place to their node-union skeleton
 * before calling `Labels.merge`. Missing nodes on each side are filled per
 * `unmapped` (`"unlabeled"` sets `labeled: false` for SLP 3.0; `"absent"`
 * writes legacy absent points).
 */
export function reconcileSkeletonsInPlace(
  base: Labels,
  donor: Labels,
  unmapped: UnmappedNodeFill = "unlabeled",
): Skeleton | null {
  if (base.skeletons.length !== 1 || donor.skeletons.length !== 1) return null;
  const baseSkel = base.skeletons[0];
  const donorSkel = donor.skeletons[0];
  const unified = buildUnifiedSkeleton(baseSkel, donorSkel);

  applyStructureInPlace(baseSkel, unified, base, unmapped);
  applyStructureInPlace(donorSkel, unified, donor, unmapped);
  return baseSkel;
}

/**
 * Non-mutating conflict enumeration for a planned `"unify"` skeleton merge.
 * Compares temporary instances remapped onto the unified skeleton on shared
 * frames, returning `Conflict` entries referencing the LIVE `base` and `donor`
 * instances so `applyConflictResolutions` can delete exact losers.
 */
export async function enumerateUnifiedConflicts(
  base: Labels,
  donor: Labels,
  unmapped: UnmappedNodeFill = "unlabeled",
  opts: { threshold?: number } = {},
): Promise<Conflict[]> {
  if (base.skeletons.length !== 1 || donor.skeletons.length !== 1) return [];
  const baseSkel = base.skeletons[0];
  const donorSkel = donor.skeletons[0];
  const unified = buildUnifiedSkeleton(baseSkel, donorSkel);
  const threshold = opts.threshold ?? 5;

  const matchResult = await base.match(donor, { video: "basename", track: "name" });
  const videoMap = matchResult.videoMap as Map<Video, Video>;
  const matcher = new InstanceMatcher(InstanceMatchMethod.SPATIAL, { threshold });
  const emptyLinks = new Map<string, string>();
  const isUser = (inst: Instance) => inst.constructor === Instance;

  const conflicts: Conflict[] = [];
  for (const dFrame of donor.labeledFrames) {
    const mappedVideo = videoMap.get(dFrame.video) ?? dFrame.video;
    const baseFrames = base.find({
      video: mappedVideo,
      frameIdx: dFrame.frameIdx,
    });
    if (!baseFrames.length) continue;

    const baseFrame = baseFrames[0];
    const baseUser = baseFrame.instances.filter(isUser);
    const donorUser = dFrame.instances.filter(isUser);
    if (!baseUser.length || !donorUser.length) continue;

    const baseClones = baseUser.map(
      (inst) =>
        new Instance({
          skeleton: unified,
          points: remapInstancePoints(
            inst,
            baseSkel.nodes,
            unified.nodes,
            emptyLinks,
            unmapped,
          ),
        }),
    );
    const donorClones = donorUser.map(
      (inst) =>
        new Instance({
          skeleton: unified,
          points: remapInstancePoints(
            inst,
            donorSkel.nodes,
            unified.nodes,
            emptyLinks,
            unmapped,
          ),
        }),
    );

    const pairs = matcher.findMatches(baseClones, donorClones);
    if (!pairs.length) continue;

    const clusters = buildClusters(pairs.map(([i, j]) => [i, j] as const));
    const videoIdx = base.videos.indexOf(mappedVideo);
    clusters.forEach((cluster, ci) => {
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
        baseColorIndices: cluster.baseIdxs.map((i) =>
          baseFrame.instances.indexOf(baseUser[i]),
        ),
        donorInstances: cluster.donorIdxs.map((j) => donorUser[j]),
        distance: best === Infinity ? 0 : best,
      });
    });
  }
  return conflicts;
}

/** Concise toast line summarizing a completed merge. */
export function mergeResultSummary(result: MergeResult): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  let msg = `Merged ${plural(result.instancesAdded, "instance")} across ${plural(
    result.framesMerged,
    "frame"
  )}`;
  if (result.conflicts.length > 0) {
    msg += `, ${plural(result.conflicts.length, "conflict")} resolved`;
  }
  if (result.errors.length > 0) {
    msg += `, ${plural(result.errors.length, "error")}`;
  }
  return `${msg}.`;
}
