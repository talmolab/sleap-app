/**
 * Array-only statistic math, shared by the main-thread facade
 * (statisticSeries.ts) and the Web Worker (statisticSeries.worker.ts).
 * No sleap-io.js objects here — only plain numbers/arrays — so it is
 * trivially unit-testable and structured-clone safe.
 *
 * Ported from sleap/info/summary.py reduction semantics.
 */

export type Reduction = "sum" | "max" | "min" | "mean";

/** Reduce a list of numbers per summary.py semantics. */
export function reduceValues(values: number[], reduction: Reduction): number {
  switch (reduction) {
    case "sum": {
      // np.sum (NaN-propagating in numpy, but velocity callers pre-filter NaN).
      let s = 0;
      for (const v of values) s += Number.isNaN(v) ? 0 : v;
      return s;
    }
    case "max": {
      let m = -Infinity;
      for (const v of values) if (!Number.isNaN(v) && v > m) m = v;
      return m === -Infinity ? 0 : m;
    }
    case "min": {
      // min(x, default=0) for scores; nanmin behavior (ignore NaN).
      let m = Infinity;
      for (const v of values) if (!Number.isNaN(v) && v < m) m = v;
      return m === Infinity ? 0 : m;
    }
    case "mean": {
      // np.nanmean: mean of non-NaN; all-NaN -> NaN.
      let s = 0;
      let n = 0;
      for (const v of values) {
        if (!Number.isNaN(v)) {
          s += v;
          n += 1;
        }
      }
      return n === 0 ? NaN : s / n;
    }
  }
}

/**
 * Per-node Euclidean distance between two instances' point arrays
 * (rows of [x, y] from Instance.numpy()), reduced per summary.py
 * _calculate_frame_velocity (sum/mean/max over nodes).
 * Assumes same node ordering/length (same skeleton).
 *
 * HYBRID parity with summary.py:110 / :262 — sum and max use NaN-PROPAGATING
 * np.sum / np.max, so ANY invisible (NaN) node makes the WHOLE per-instance
 * value NaN; the caller (pointDisplacementSeries) then adds 0 for that
 * instance (summary.py:262). mean uses np.nanmean (ignore NaN nodes).
 */
export function instanceVelocity(
  pointsA: number[][],
  pointsB: number[][],
  reduction: Reduction,
): number {
  const n = Math.min(pointsA.length, pointsB.length);
  const dists: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = pointsA[i][0] - pointsB[i][0];
    const dy = pointsA[i][1] - pointsB[i][1];
    dists.push(Math.hypot(dx, dy)); // NaN if either coord NaN
  }
  if (reduction === "sum" || reduction === "max") {
    // NaN-propagate for sum/max: any NaN node => whole instance NaN.
    if (dists.some((d) => Number.isNaN(d))) return NaN;
  }
  return reduceValues(dists, reduction);
}
