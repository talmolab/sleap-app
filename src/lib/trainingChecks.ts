/**
 * Pre-run checks that block training, ported from legacy SLEAP's
 * `LearningDialog._validate_pipeline` (sleap/gui/learning/dialog.py) and the
 * skeleton helpers it uses (sleap/sleap_io_adaptors/skeleton_utils.py).
 */

type SkeletonLike = {
  nodes: { name: string }[];
  edges: { source: { name: string }; destination: { name: string } }[];
};

type LabelsLike = {
  tracks: unknown[];
  labeledFrames: Array<{ userInstances: Array<{ track?: unknown }> }>;
};

export interface ArborescenceProblems {
  /** Nodes that are not the target of any edge, when there is more than one. */
  roots: string[];
  /** Nodes that are the target of more than one edge. */
  multiParent: string[];
  /** Each directed cycle, as its node names in order. */
  cycles: string[][];
}

/**
 * Why `skeleton` is not an arborescence (a directed tree with one root), or
 * `null` when it is. Bottom-up's part affinity fields group nodes by walking
 * the edges from the root, so sleap-nn needs this shape.
 */
export function arborescenceProblems(skeleton: SkeletonLike): ArborescenceProblems | null {
  const names = skeleton.nodes.map((n) => n.name);
  const inDegree = new Map(names.map((n) => [n, 0]));
  const children = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of skeleton.edges) {
    inDegree.set(e.destination.name, (inDegree.get(e.destination.name) ?? 0) + 1);
    children.get(e.source.name)?.push(e.destination.name);
  }

  const rootNames = names.filter((n) => inDegree.get(n) === 0);
  const roots = rootNames.length > 1 ? rootNames : [];
  const multiParent = names.filter((n) => (inDegree.get(n) ?? 0) > 1);
  const cycles = findCycles(names, children);

  // No root at all implies a cycle, so these three cover every non-tree.
  if (roots.length === 0 && multiParent.length === 0 && cycles.length === 0) return null;
  return { roots, multiParent, cycles };
}

/** One cycle per strongly connected group of nodes, found by depth-first search. */
function findCycles(names: string[], children: Map<string, string[]>): string[][] {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const inCycle = new Set<string>();

  const visit = (n: string) => {
    state.set(n, "visiting");
    stack.push(n);
    for (const c of children.get(n) ?? []) {
      if (state.get(c) === "visiting") {
        if (!inCycle.has(c)) {
          const cycle = stack.slice(stack.indexOf(c));
          cycle.forEach((m) => inCycle.add(m));
          cycles.push([...cycle, c]);
        }
      } else if (!state.has(c)) {
        visit(c);
      }
    }
    stack.pop();
    state.set(n, "done");
  };

  for (const n of names) if (!state.has(n)) visit(n);
  return cycles;
}

/** Legacy SLEAP's message for a skeleton bottom-up can't train on. */
export function arborescenceMessage(p: ArborescenceProblems): string {
  const parts = ["Bottom-Up needs a skeleton that is a tree with one root."];
  if (p.roots.length > 0) {
    parts.push(`There are several root nodes (nodes no edge points to): ${p.roots.join(", ")}.`);
  }
  if (p.multiParent.length > 0) {
    parts.push(`These nodes are the target of more than one edge: ${p.multiParent.join(", ")}.`);
  }
  if (p.cycles.length > 0) {
    parts.push(`The edges form a cycle: ${p.cycles.map((c) => c.join(" → ")).join("; ")}.`);
  }
  return parts.join(" ");
}

/**
 * Whether any user-labeled instance has a track, which ID models need to
 * learn identities from. Predicted instances don't count, as in legacy
 * `_validate_id_model`.
 */
export function hasTrackedUserInstances(labels: LabelsLike | null | undefined): boolean {
  if (!labels || labels.tracks.length === 0) return false;
  return labels.labeledFrames.some((lf) => lf.userInstances.some((inst) => inst.track != null));
}

export const ID_NO_TRACKS_MESSAGE =
  "ID models learn from tracks: assign a track to some labeled instances first.";
