/**
 * Numeric helpers for the statistical QC engine (the `sleap.qc` port).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp (`src/lib/qc/checks/util.js`),
 * a lab JS port of Python `sleap.qc` intended for integration into sleap-app.
 * These reproduce the NumPy idioms `sleap.qc` relies on — POPULATION mean/std
 * (÷N, ddof=0), a 1e-6 std floor, and visibility = both coords finite.
 *
 * A "pose" is `number[][]` of shape (nNodes, 2); an invisible/unlabeled node is
 * `[NaN, NaN]`. On our sleap-io.js (0.5.x) a pose matrix comes from
 * `instance.numpy({ invisibleAsNaN: true })`, decoupling this engine from the
 * columnar point API.
 */

/** A single keypoint `[x, y]` (invisible = `[NaN, NaN]`). */
export type Pt = number[];
/** A pose: one `[x, y]` per skeleton node, in node order. */
export type Pose = number[][];

/** A node is visible iff both coordinates are finite. */
export const isVisible = (p: Pt | null | undefined): boolean =>
  p != null && !Number.isNaN(p[0]) && !Number.isNaN(p[1]);

/** Euclidean distance between two points. */
export const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Per-node visibility mask for a pose. */
export const visibilityMask = (pose: Pose): boolean[] => pose.map(isVisible);

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Population std (np.std, ddof=0); 0 for an empty/singleton set. */
export function std(xs: number[]): number {
  if (!xs.length) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
}

/** Population std with a floor (mirrors `safe_std` / `np.maximum(std, 1e-6)`). */
export const safeStd = (xs: number[], minVal = 1e-6): number =>
  Math.max(std(xs), minVal);

/** Mean, or 0 for an empty set. */
export const safeMean = (xs: number[]): number => (xs.length ? mean(xs) : 0);

export const maxAbs = (xs: number[]): number =>
  xs.length ? Math.max(...xs.map((x) => Math.abs(x))) : 0;

export const meanAbs = (xs: number[]): number =>
  xs.length ? mean(xs.map((x) => Math.abs(x))) : 0;

/** Visible points of a pose as `[x, y][]`. */
export const visiblePoints = (pose: Pose): Pt[] => pose.filter(isVisible);

/**
 * Axis-aligned bbox `[minX, minY, maxX, maxY]` over visible points, or `null`
 * when fewer than `min` nodes are visible.
 */
export function bbox(pose: Pose, min = 2): [number, number, number, number] | null {
  const vis = visiblePoints(pose);
  if (vis.length < min) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of vis) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
