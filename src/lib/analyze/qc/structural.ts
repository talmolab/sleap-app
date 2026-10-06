/**
 * Structural V3 QC features: curvature along a node chain + convex-hull metrics.
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/features/structural.js`, itself a port of
 * `sleap/qc/features/structural.py`), a lab JS port of Python `sleap.qc`
 * intended for integration into sleap-app. The Python uses
 * `scipy.spatial.ConvexHull`; here we use Andrew's monotone chain (same hull →
 * same area/perimeter/compactness).
 */
import { isVisible, type Pose, type Pt } from "./util";

/** Curvature summary along an ordered node chain. */
export interface CurvatureResult {
  /** Signed curvature (pi - interior angle) at each interior chain vertex; NaN where unmeasurable. */
  curvatures: number[];
  maxCurvature: number;
  meanCurvature: number;
  curvatureStd: number;
  signChanges: number;
}

/** The chain vertex owning `maxCurvature`: `[vertex, armA, armB]` + its signed curvature. */
export interface WorstCurvature {
  nodes: number[];
  curvature: number;
}

/** Convex-hull metrics over a pose's visible points. */
export interface ConvexHullResult {
  hullArea: number;
  hullPerimeter: number;
  hullAspectRatio: number;
  compactness: number;
  nHullPoints: number;
}

/** Curvature (pi - interior angle, signed) along an ordered node chain. */
export function computeCurvature(pose: Pose, chain: number[]): CurvatureResult {
  if (chain.length < 3) {
    return {
      curvatures: [],
      maxCurvature: 0,
      meanCurvature: 0,
      curvatureStd: 0,
      signChanges: 0,
    };
  }
  const curv: number[] = [];
  for (let i = 1; i < chain.length - 1; i++) {
    const a = pose[chain[i - 1]],
      c = pose[chain[i]],
      b = pose[chain[i + 1]];
    if (!isVisible(a) || !isVisible(c) || !isVisible(b)) {
      curv.push(Number.NaN);
      continue;
    }
    const v1 = [a[0] - c[0], a[1] - c[1]];
    const v2 = [b[0] - c[0], b[1] - c[1]];
    const n1 = Math.hypot(v1[0], v1[1]),
      n2 = Math.hypot(v2[0], v2[1]);
    if (n1 < 1e-8 || n2 < 1e-8) {
      curv.push(Number.NaN);
      continue;
    }
    const cos = Math.max(
      -1,
      Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)),
    );
    let k = Math.PI - Math.acos(cos);
    const cross = v1[0] * v2[1] - v1[1] * v2[0];
    if (cross !== 0) k *= Math.sign(cross);
    curv.push(k);
  }
  const valid = curv.filter((x) => !Number.isNaN(x));
  let signChanges = 0;
  for (let i = 1; i < valid.length; i++)
    if (Math.sign(valid[i]) !== Math.sign(valid[i - 1])) signChanges++;
  const absVals = valid.map(Math.abs);
  const m = valid.length ? valid.reduce((s, x) => s + x, 0) / valid.length : 0;
  const variance = valid.length
    ? valid.reduce((s, x) => s + (x - m) * (x - m), 0) / valid.length
    : 0;
  return {
    curvatures: curv,
    maxCurvature: absVals.length ? Math.max(...absVals) : 0,
    meanCurvature: absVals.length
      ? absVals.reduce((s, x) => s + x, 0) / absVals.length
      : 0,
    curvatureStd: Math.sqrt(variance),
    signChanges,
  };
}

/**
 * The chain vertex that OWNS `maxCurvature` — the argmax that computeCurvature's
 * reduction discards. Returns the vertex plus its two arms in the order the UI
 * wants for drawing an angle (`[vertex, armA, armB]`), or null when no vertex is
 * measurable.
 */
export function worstCurvatureVertex(
  pose: Pose,
  chain: number[] | null,
): WorstCurvature | null {
  if (!chain || chain.length < 3) return null;
  const { curvatures } = computeCurvature(pose, chain);
  let best = -1,
    bestAbs = -Infinity;
  for (let k = 0; k < curvatures.length; k++) {
    const a = Math.abs(curvatures[k]);
    if (Number.isNaN(a) || a <= bestAbs) continue;
    bestAbs = a;
    best = k;
  }
  if (best < 0) return null;
  // curvatures[k] is measured at chain[k+1], between chain[k] and chain[k+2].
  return {
    nodes: [chain[best + 1], chain[best], chain[best + 2]],
    curvature: curvatures[best],
  };
}

/** Andrew's monotone chain convex hull -> ordered hull vertices (CCW). */
function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Convex-hull area / perimeter / aspect-ratio / compactness over visible points. */
export function computeConvexHull(pose: Pose): ConvexHullResult {
  const vis = pose.filter(isVisible);
  const degenerate: ConvexHullResult = {
    hullArea: 0,
    hullPerimeter: 0,
    hullAspectRatio: 1,
    compactness: 0,
    nHullPoints: vis.length,
  };
  if (vis.length < 3) return degenerate;
  const hull = convexHull(vis);
  if (hull.length < 3) return { ...degenerate, nHullPoints: 0 };
  let area = 0,
    perimeter = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i],
      b = hull[(i + 1) % hull.length];
    area += a[0] * b[1] - b[0] * a[1]; // shoelace
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  area = Math.abs(area) / 2;
  const xs = hull.map((p) => p[0]),
    ys = hull.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    hullArea: area,
    hullPerimeter: perimeter,
    hullAspectRatio: height > 0 ? width / height : 1,
    compactness: perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0,
    nHullPoints: hull.length,
  };
}
