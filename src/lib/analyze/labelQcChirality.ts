/**
 * Chirality (left/right mirror-flip) detection (Analyze menu, Tier 3). A whole-
 * instance L/R flip is invisible to distance/unsigned-angle features, so it needs
 * a *signed* statistic: which side of the body midline each symmetric pair's
 * "left" member sits on. We learn the canonical side per pair (majority over the
 * loaded instances) then flag instances where enough pairs disagree.
 *
 * Ported from the SLEAP fork `sleap/qc/features/chirality.py`. Pure — plain
 * points arrays (rows `[x, y]`, NaN = invisible) + symmetric-pair indices; the
 * only linear algebra is a hand-rolled 2×2 PCA (the fork's SVD principal axis).
 */

type Vec2 = [number, number];

function isVis(p: number[]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/**
 * Principal axis (unit direction of max variance) + centroid of 2D points.
 * Analytic 2×2 covariance eigenvector — equivalent to the fork's SVD `vh[0]`.
 * Returns null for <2 points or a degenerate (coincident) cloud.
 */
export function principalDirection(pts: number[][]): { origin: Vec2; axis: Vec2 } | null {
  if (pts.length < 2) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let maxAbs = 0;
  for (const [x, y] of pts) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy));
  }
  if (maxAbs < 1e-6) return null;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const lambda = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let vx: number;
  let vy: number;
  if (Math.abs(sxy) > 1e-12) {
    vx = lambda - syy;
    vy = sxy;
  } else if (sxx >= syy) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }
  const n = Math.hypot(vx, vy);
  if (n < 1e-6) return null;
  return { origin: [mx, my], axis: [vx / n, vy / n] };
}

function projectToPolyline(
  point: number[],
  polyline: number[][],
): { foot: Vec2; tangent: Vec2 } | null {
  let bestD2 = Infinity;
  let bestFoot: Vec2 | null = null;
  let bestTan: Vec2 | null = null;
  for (let k = 0; k < polyline.length - 1; k++) {
    const a = polyline[k];
    const b = polyline[k + 1];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const segLen2 = abx * abx + aby * aby;
    if (segLen2 < 1e-12) continue;
    let t = ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const foot: Vec2 = [a[0] + t * abx, a[1] + t * aby];
    const d2 = (point[0] - foot[0]) ** 2 + (point[1] - foot[1]) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestFoot = foot;
      const len = Math.sqrt(segLen2);
      bestTan = [abx / len, aby / len];
    }
  }
  if (!bestTan || !bestFoot) return null;
  return { foot: bestFoot, tangent: bestTan };
}

/** sign(cross(local tangent, left − foot)) — +1 left of the midline, −1 right,
 *  0 on it; null if a member is invisible or no usable segment exists. */
export function signedSideLocal(
  left: number[],
  right: number[],
  polyline: number[][],
): number | null {
  if (!isVis(left) || !isVis(right)) return null;
  const mid = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
  const proj = projectToPolyline(mid, polyline);
  if (!proj) return null;
  const relx = left[0] - proj.foot[0];
  const rely = left[1] - proj.foot[1];
  return Math.sign(proj.tangent[0] * rely - proj.tangent[1] * relx);
}

function orderMidlineByPca(instances: number[][][], midlineIndices: number[]): number[] {
  if (midlineIndices.length < 2) return [...midlineIndices];
  const sums = new Map<number, number>();
  const counts = new Map<number, number>();
  for (const points of instances) {
    const pca = principalDirection(points.filter(isVis));
    if (!pca) continue;
    for (const i of midlineIndices) {
      if (isVis(points[i])) {
        const proj =
          (points[i][0] - pca.origin[0]) * pca.axis[0] +
          (points[i][1] - pca.origin[1]) * pca.axis[1];
        sums.set(i, (sums.get(i) ?? 0) + proj);
        counts.set(i, (counts.get(i) ?? 0) + 1);
      }
    }
  }
  if (midlineIndices.every((i) => (counts.get(i) ?? 0) === 0)) return [...midlineIndices];
  const meanProj = (i: number) => (sums.get(i) ?? 0) / (counts.get(i) || 1);
  return [...midlineIndices].sort((a, b) => meanProj(a) - meanProj(b));
}

function resolveMidline(
  points: number[][],
  orderedMidline: number[],
  axisAnchors: Vec2 | null,
  exclude: Set<number>,
): number[][] | null {
  const poly = orderedMidline.map((i) => points[i]).filter(isVis);
  if (poly.length >= 2) return poly;
  if (axisAnchors) {
    const [i, j] = axisAnchors;
    if (i !== j && isVis(points[i]) && isVis(points[j])) {
      const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (d >= 1e-6) return [points[i], points[j]];
    }
  }
  const nonSym: number[][] = [];
  for (let i = 0; i < points.length; i++) {
    if (!exclude.has(i) && isVis(points[i])) nonSym.push(points[i]);
  }
  const pca = principalDirection(nonSym);
  if (!pca) return null;
  return [pca.origin, [pca.origin[0] + pca.axis[0], pca.origin[1] + pca.axis[1]]];
}

export interface ChiralityModel {
  /** "a,b" pair key → canonical side (+1 / −1) of the left member. */
  canonical: Map<string, number>;
  orderedMidline: number[];
  axisAnchors: Vec2 | null;
  pairs: [number, number][];
}

/**
 * Learn the canonical side per symmetric pair from the loaded instances (majority
 * sign; ties → +1), after ordering the non-symmetric midline nodes nose→tail.
 */
export function buildChiralityModel(
  instances: number[][][],
  pairs: [number, number][],
  nNodes: number,
): ChiralityModel {
  const exclude = new Set<number>();
  for (const [a, b] of pairs) {
    exclude.add(a);
    exclude.add(b);
  }
  const midlineIndices: number[] = [];
  for (let i = 0; i < nNodes; i++) if (!exclude.has(i)) midlineIndices.push(i);
  const orderedMidline = orderMidlineByPca(instances, midlineIndices);
  const axisAnchors: Vec2 | null =
    orderedMidline.length >= 2
      ? [orderedMidline[0], orderedMidline[orderedMidline.length - 1]]
      : null;

  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const points of instances) {
    const poly = resolveMidline(points, orderedMidline, axisAnchors, exclude);
    if (!poly) continue;
    for (const [a, b] of pairs) {
      if (!isVis(points[a]) || !isVis(points[b])) continue;
      const side = signedSideLocal(points[a], points[b], poly);
      if (side === null || side === 0) continue;
      const k = `${a},${b}`;
      sums.set(k, (sums.get(k) ?? 0) + side);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const canonical = new Map<string, number>();
  for (const [a, b] of pairs) {
    const k = `${a},${b}`;
    const c = counts.get(k) ?? 0;
    if (c === 0) continue;
    canonical.set(k, (sums.get(k) ?? 0) / c >= 0 ? 1 : -1);
  }
  return { canonical, orderedMidline, axisAnchors, pairs };
}

/**
 * Fraction of an instance's co-visible symmetric pairs whose side disagrees with
 * the learned canonical side (0 = clean, 1 = fully flipped). Returns 0 when fewer
 * than `minPairs` pairs are scorable (matching the fork).
 */
export function chiralityWrongFraction(
  points: number[][],
  model: ChiralityModel,
  minPairs = 2,
): { wrongFraction: number; nPairs: number } {
  const exclude = new Set<number>();
  for (const [a, b] of model.pairs) {
    exclude.add(a);
    exclude.add(b);
  }
  const poly = resolveMidline(points, model.orderedMidline, model.axisAnchors, exclude);
  if (!poly) return { wrongFraction: 0, nPairs: 0 };

  let nPairs = 0;
  let nWrong = 0;
  for (const [a, b] of model.pairs) {
    const canon = model.canonical.get(`${a},${b}`);
    if (canon === undefined) continue;
    if (!isVis(points[a]) || !isVis(points[b])) continue;
    const side = signedSideLocal(points[a], points[b], poly);
    if (side === null || side === 0) continue;
    nPairs++;
    if (side !== canon) nWrong++;
  }
  if (nPairs < minPairs) return { wrongFraction: 0, nPairs };
  return { wrongFraction: nWrong / nPairs, nPairs };
}

// ── Symmetry-pair inference by node name (chirality.py) ───────────────────────
const _LR_TOKENS: [string, string][] = [
  ["left", "right"],
  ["l", "r"],
];
const _SEP = "[ _\\-.]?";

function parseLrToken(name: string): { key: string; side: "left" | "right" } | null {
  for (const [lt, rt] of _LR_TOKENS) {
    for (const [tok, side] of [[lt, "left"] as const, [rt, "right"] as const]) {
      let m = name.match(new RegExp(`^(.+?)${_SEP}${tok}$`, "i"));
      if (m && m[1]) return { key: `S:${m[1].toLowerCase()}`, side };
      m = name.match(new RegExp(`^${tok}${_SEP}(.+)$`, "i"));
      if (m && m[1]) return { key: `P:${m[1].toLowerCase()}`, side };
    }
  }
  return null;
}

/** Infer L/R symmetric pairs from node names (`Ear_L`/`Ear_R`, `left_eye`/`right_eye`)
 *  when a skeleton defines no symmetries. Each node appears in at most one pair. */
export function inferSymmetryPairsByName(nodeNames: string[]): [number, number][] {
  const groups = new Map<string, { left?: number; right?: number }>();
  nodeNames.forEach((name, idx) => {
    const parsed = parseLrToken(name);
    if (!parsed) return;
    const g = groups.get(parsed.key) ?? {};
    if (g[parsed.side] === undefined) g[parsed.side] = idx;
    groups.set(parsed.key, g);
  });
  const pairs: [number, number][] = [];
  const used = new Set<number>();
  for (const g of groups.values()) {
    if (
      g.left !== undefined &&
      g.right !== undefined &&
      g.left !== g.right &&
      !used.has(g.left) &&
      !used.has(g.right)
    ) {
      pairs.push([g.left, g.right]);
      used.add(g.left);
      used.add(g.right);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}
