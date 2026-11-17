/**
 * Structural (not object-identity) view of a project's skeletons. Pure: no UI
 * imports, safe for analysis code.
 *
 * Old `.slp` files (and some merges) can carry two or more skeleton OBJECTS
 * that are really the same skeleton (same node names in the same order, same
 * edges and symmetries). Neither PyQt SLEAP nor Python sleap-io removes those on
 * load, and on `main` every workflow simply used `skeletons[0]`, which works
 * for them because points are stored positionally. So "does this project
 * really have several skeletons?" counts structurally DISTINCT skeletons, and
 * identical duplicates behave exactly as before.
 */

import type { Instance, Labels, Skeleton } from "@talmolab/sleap-io.js";

/** Same nodes (same order), edges and symmetries — interchangeable for points. */
export function sameSkeletonStructure(a: Skeleton, b: Skeleton): boolean {
  if (a === b) return true;
  if (typeof a?.matches !== "function" || !b) return false;
  return a.matches(b, { requireSameOrder: true });
}

type LabelsLike = Pick<Labels, "skeletons"> & {
  labeledFrames?: { instances: Instance[] }[];
};

/**
 * The skeletons that matter for "how many skeletons does this project have?":
 * `skeletons[0]` (what single-skeleton workflows read), every skeleton an
 * instance uses, and the active skeleton (one just added but not yet used).
 * A skeleton nothing uses — e.g. a duplicate whose instances were re-pointed
 * by a skeleton edit — doesn't count.
 */
export function relevantSkeletons(
  labels: LabelsLike,
  active?: Skeleton | null,
): Skeleton[] {
  const out = new Set<Skeleton>();
  if (labels.skeletons[0]) out.add(labels.skeletons[0]);
  if (active && labels.skeletons.includes(active)) out.add(active);
  for (const lf of labels.labeledFrames ?? []) {
    for (const inst of lf.instances) {
      if (inst.skeleton) out.add(inst.skeleton);
    }
  }
  return [...out];
}

/** Group skeletons into structurally identical classes. */
export function structuralGroups(skeletons: readonly Skeleton[]): Skeleton[][] {
  const groups: Skeleton[][] = [];
  for (const sk of skeletons) {
    const group = groups.find((g) => sameSkeletonStructure(g[0], sk));
    if (group) group.push(sk);
    else groups.push([sk]);
  }
  return groups;
}

/**
 * Number of structurally distinct skeletons the project really uses (see
 * {@link relevantSkeletons}). 0 or 1 for every single-skeleton project,
 * including ones with identical duplicate skeleton objects.
 */
export function distinctSkeletonCount(
  labels: LabelsLike | null | undefined,
  active?: Skeleton | null,
): number {
  if (!labels?.skeletons?.length) return 0;
  // Fast path: one skeleton object (nearly every project) needs no scan.
  if (labels.skeletons.length === 1) return 1;
  return structuralGroups(relevantSkeletons(labels, active)).length;
}
