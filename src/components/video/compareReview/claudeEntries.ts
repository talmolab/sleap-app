/**
 * Claude's corrections in the Review disagreements window: which queue items
 * they belong to, and their poses for drawing.
 *
 * The window's queue is the models' disagreements plus Claude's corrections
 * on the video. A correction whose prediction is one of the disagreeing
 * animals joins that item (a "Claude's suggestion" pane next to the models');
 * any other (a low-confidence prediction, or no models loaded) is an item of
 * its own, with the project's prediction as the one "model" pane. Items are
 * worst first: a disagreement by its largest spread, a Claude-only item by
 * how far Claude's fix moves a node (px).
 */
import { correctionResult, proposalInstance, type Proposal } from "@/stores/proposalStore";
import { matchGate, meanNodeDistance } from "@/lib/modelOverlay/matching";
import { reviewItemKey, type ReviewGroup } from "@/lib/modelOverlay/review";

export type ReviewEntry =
  | {
      kind: "models";
      key: string;
      frame: number;
      group: ReviewGroup;
      /** Claude's correction of this animal's prediction, if any. */
      claude: Proposal | null;
      sortPx: number;
    }
  | { kind: "claude"; key: string; frame: number; claude: Proposal; sortPx: number };

/** The node names a proposal's indices refer to (its instance's skeleton), else `fallback`. */
function ownNodeNames(p: Proposal, fallback: readonly string[]): readonly string[] {
  return (proposalInstance(p) ?? correctionResult(p))?.skeleton.nodeNames ?? fallback;
}

/** The prediction Claude looked at, `[x0, y0, …]` in `nodeNames` order (NaN where not visible). */
export function proposalPoseXy(p: Proposal, nodeNames: readonly string[]): Float64Array {
  const pose = JSON.parse(p.fingerprint) as [number | null, number | null, boolean][];
  const own = ownNodeNames(p, nodeNames);
  const out = new Float64Array(nodeNames.length * 2).fill(NaN);
  nodeNames.forEach((name, i) => {
    const q = pose[own.indexOf(name)];
    if (q && q[2] && Number.isFinite(q[0]) && Number.isFinite(q[1])) {
      out[2 * i] = q[0]!;
      out[2 * i + 1] = q[1]!;
    }
  });
  return out;
}

/** Claude's corrected pose, same order: the prediction with Claude's moves; nodes it hides are NaN. */
export function correctedPoseXy(p: Proposal, nodeNames: readonly string[]): Float64Array {
  const out = proposalPoseXy(p, nodeNames);
  const own = ownNodeNames(p, nodeNames);
  for (const [k, v] of Object.entries(p.after)) {
    const i = nodeNames.indexOf(own[Number(k)]);
    if (i < 0) continue;
    out[2 * i] = v ? v[0] : NaN;
    out[2 * i + 1] = v ? v[1] : NaN;
  }
  return out;
}

/** Indices (in `nodeNames` order) of the nodes Claude moves or hides. */
export function changedNodes(p: Proposal, nodeNames: readonly string[]): number[] {
  const own = ownNodeNames(p, nodeNames);
  return Object.keys(p.after)
    .map((k) => nodeNames.indexOf(own[Number(k)]))
    .filter((i) => i >= 0);
}

/** How far Claude's fix moves a node, at most (px; 0 for "as is" or only hiding nodes). */
export function claudeMovePx(p: Proposal): number {
  let max = 0;
  for (const [k, v] of Object.entries(p.after)) {
    const b = p.before[Number(k)];
    if (v && b) max = Math.max(max, Math.hypot(v[0] - b[0], v[1] - b[1]));
  }
  return max;
}

/**
 * The window's queue: each disagreement (with Claude's correction of that
 * animal attached, when there is one) plus Claude's other corrections, worst
 * first. Only the newest correction per prediction counts.
 */
export function buildEntries(
  groups: readonly ReviewGroup[],
  corrections: readonly Proposal[],
  nodeNames: readonly string[],
): ReviewEntry[] {
  const latest = new Map<string, Proposal>();
  for (const p of corrections) latest.set(`${p.frameIdx}:${p.fingerprint}`, p);
  const byFrame = new Map<number, number[]>();
  groups.forEach((g, gi) => {
    const list = byFrame.get(g.frame);
    if (list) list.push(gi);
    else byFrame.set(g.frame, [gi]);
  });
  const attached = new Map<number, Proposal>();
  const loose: Proposal[] = [];
  for (const p of latest.values()) {
    const xy = proposalPoseXy(p, nodeNames);
    let best = -1;
    let bestD = Infinity;
    for (const gi of byFrame.get(p.frameIdx) ?? []) {
      if (attached.has(gi)) continue;
      const c = groups[gi].consensus;
      const d = meanNodeDistance(xy, c);
      if (d <= matchGate(c) && d < bestD) {
        best = gi;
        bestD = d;
      }
    }
    if (best >= 0) attached.set(best, p);
    else loose.push(p);
  }
  const entries: ReviewEntry[] = [
    ...groups.map((g, gi) => ({
      kind: "models" as const,
      key: reviewItemKey(g),
      frame: g.frame,
      group: g,
      claude: attached.get(gi) ?? null,
      sortPx: g.maxSpread,
    })),
    ...loose.map((p) => ({
      kind: "claude" as const,
      key: `claude:${p.id}`,
      frame: p.frameIdx,
      claude: p,
      sortPx: claudeMovePx(p),
    })),
  ];
  return entries.sort((a, b) => b.sortPx - a.sortPx || a.frame - b.frame);
}
