/**
 * Pure geometry for the skeleton builder's "connect" pen: turn a freehand stroke
 * into an ordered list of node→node edges by testing the stroke's SEGMENTS (not
 * just sampled cursor points) against each node's hit-circle, so a fast stroke
 * can't skip a small node between mouse-move samples. React/canvas-free → unit
 * testable. The caller validates each pair with isValidEdgeSelection before
 * creating an edge (self/duplicate rejection lives there, not here).
 */
export interface Pt {
  x: number;
  y: number;
}

/** Squared distance from point c to segment a→b, plus the clamped parameter t. */
function distToSegment(c: Pt, a: Pt, b: Pt): { d2: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((c.x - a.x) * abx + (c.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * abx;
  const py = a.y + t * aby;
  const dx = c.x - px;
  const dy = c.y - py;
  return { d2: dx * dx + dy * dy, t };
}

/**
 * Node indices whose hit-circle (center positions[i], `radius`) is crossed by the
 * segment p0→p1, ordered by position along the segment (entry order). Unplaced
 * (null) positions are skipped.
 */
export function nodesCrossedBySegment(
  positions: (Pt | null)[],
  radius: number,
  p0: Pt,
  p1: Pt
): number[] {
  const r2 = radius * radius;
  const hits: { idx: number; t: number }[] = [];
  for (let i = 0; i < positions.length; i++) {
    const c = positions[i];
    if (!c) continue;
    const { d2, t } = distToSegment(c, p0, p1);
    if (d2 <= r2) hits.push({ idx: i, t });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.map((h) => h.idx);
}

/**
 * Ordered [src,dst] node-index pairs formed by a pen stroke. Walks the polyline,
 * tracking the last node touched; each crossing into a DIFFERENT node emits
 * [prev, new]. Consecutive same-node samples are ignored. Does not dedup
 * non-adjacent repeats nor consult an existing edge set — the caller validates.
 */
export function penStrokeToEdges(
  positions: (Pt | null)[],
  radius: number,
  stroke: Pt[],
  startNode: number | null = null
): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  let last = startNode;
  for (let i = 0; i + 1 < stroke.length; i++) {
    const crossed = nodesCrossedBySegment(positions, radius, stroke[i], stroke[i + 1]);
    for (const idx of crossed) {
      if (idx === last) continue;
      if (last !== null) edges.push([last, idx]);
      last = idx;
    }
  }
  return edges;
}
