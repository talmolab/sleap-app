/**
 * Pure geometric Label QC primitives (Analyze menu, Tier 3). Operates only on
 * plain points arrays (rows `[x, y]`, NaN = invisible) + skeleton index data —
 * no sleap-io objects — so it is unit-testable. Ported from the SLEAP fork
 * `sleap/qc/features/ordering.py` (chain-order) with more checks to follow
 * (chirality, split-duplicate).
 */

function isVisible(p: number[]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

// ── Chain-order (ordering.py) ────────────────────────────────────────────────

/** Turning angle (radians, [0, π]) at `curr` between segments prev→curr and
 *  curr→next; 0 when either segment has ~zero length. */
export function turningAngle(prev: number[], curr: number[], next: number[]): number {
  const v1x = curr[0] - prev[0];
  const v1y = curr[1] - prev[1];
  const v2x = next[0] - curr[0];
  const v2y = next[1] - curr[1];
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-8 || n2 < 1e-8) return 0;
  const c = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
  return Math.acos(c);
}

function orient(a: number[], b: number[], c: number[]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Whether segments a1→a2 and b1→b2 PROPERLY cross (strict; shared endpoints or
 *  near-collinear touches do not count). Mirrors `_segments_intersect`. */
export function segmentsProperlyIntersect(
  a1: number[],
  a2: number[],
  b1: number[],
  b2: number[],
): boolean {
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  if (Math.min(Math.abs(d1), Math.abs(d2), Math.abs(d3), Math.abs(d4)) <= 1e-8) return false;
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

export interface ChainOrderStats {
  /** inversions / interior nodes over the visible sub-chain (0 if <3 visible). */
  inversionRate: number;
  /** Count of non-adjacent visible-segment proper crossings. */
  intersectionCount: number;
  /** Number of interior nodes in the visible sub-chain (max(0, visible-2)). */
  interiorCount: number;
}

/**
 * Chain-ordering diagnostics for one instance along one ordered `chain` of node
 * indices: how many interior turns exceed `maxTurnDeg` (out-of-order), and how
 * many non-adjacent segments cross (a tangled chain). Invisible chain nodes are
 * dropped before measuring.
 */
export function chainOrderStats(
  points: number[][],
  chain: number[],
  maxTurnDeg = 60,
): ChainOrderStats {
  const seq = chain.map((i) => points[i]).filter(isVisible);
  const interiorCount = Math.max(0, seq.length - 2);
  const maxTurn = (maxTurnDeg * Math.PI) / 180;

  let inversions = 0;
  for (let k = 1; k < seq.length - 1; k++) {
    if (turningAngle(seq[k - 1], seq[k], seq[k + 1]) > maxTurn) inversions++;
  }

  let intersectionCount = 0;
  const nSeg = seq.length - 1;
  for (let i = 0; i < nSeg; i++) {
    for (let j = i + 2; j < nSeg; j++) {
      if (segmentsProperlyIntersect(seq[i], seq[i + 1], seq[j], seq[j + 1])) intersectionCount++;
    }
  }

  return {
    inversionRate: interiorCount > 0 ? inversions / interiorCount : 0,
    intersectionCount,
    interiorCount,
  };
}

// ── Skeleton chain derivation ────────────────────────────────────────────────

function bfsFarthest(
  adj: Map<number, number[]>,
  start: number,
): { far: number; parent: Map<number, number> } {
  const parent = new Map<number, number>([[start, -1]]);
  const queue = [start];
  let far = start;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    for (const w of adj.get(u) ?? []) {
      if (!parent.has(w)) {
        parent.set(w, u);
        queue.push(w);
        far = w;
      }
    }
  }
  return { far, parent };
}

/**
 * The longest simple path (diameter) through the skeleton graph, as an ordered
 * list of node indices — the default "chain" for chain-order checks when no
 * chain is configured. Double-BFS (exact for trees, which skeletons usually are).
 * Returns `[]` when there are no edges.
 */
export function longestSkeletonChain(edgeIndices: number[][], nNodes: number): number[] {
  void nNodes;
  if (edgeIndices.length === 0) return [];
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const [a, b] of edgeIndices) {
    link(a, b);
    link(b, a);
  }
  const { far: u } = bfsFarthest(adj, edgeIndices[0][0]);
  const { far: v, parent } = bfsFarthest(adj, u);
  const path: number[] = [];
  for (let cur = v; cur !== -1; cur = parent.get(cur) ?? -1) path.push(cur);
  return path;
}
