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

/** Median of a list of numbers (assumes non-empty). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Per-axis nanmedian centroid of an instance's points (rows [x, y]).
 * INTENTIONALLY matches summary.py get_centroid = np.nanmedian(points, axis=0),
 * and deliberately DIFFERS from the app's MEAN centroid (centroidXy /
 * TrailRenderer.computeCentroid). Used ONLY by min-centroid-proximity.
 * Returns null when no point has a finite coordinate.
 */
export function medianCentroid(points: number[][]): [number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    if (!Number.isNaN(p[0]) && !Number.isNaN(p[1])) {
      xs.push(p[0]);
      ys.push(p[1]);
    }
  }
  if (xs.length === 0) return null;
  return [median(xs), median(ys)];
}

/**
 * Minimum pairwise Euclidean distance between centroids.
 * Ports summary.py min_centroid_dist: <2 centroids -> NaN; otherwise
 * the min off-diagonal distance.
 */
export function minCentroidDistance(centroids: Array<[number, number]>): number {
  if (centroids.length < 2) return NaN;
  let min = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    for (let j = i + 1; j < centroids.length; j++) {
      const dx = centroids[i][0] - centroids[j][0];
      const dy = centroids[i][1] - centroids[j][1];
      const d = Math.hypot(dx, dy);
      if (!Number.isNaN(d) && d < min) min = d;
    }
  }
  return min === Infinity ? NaN : min;
}

/**
 * Given a per-frame, per-track anchor location matrix
 * (loc[frameIdx][trackIdx] = [x, y], NaN for unknown), compute the
 * reduced-across-tracks frame-to-frame displacement, aligned so that the
 * displacement ARRIVING at frame f sits at index f. Returns a dense array
 * indexed by frame.
 *
 * INTENTIONALLY DIVERGES FROM summary.py:202-203: summary.py's in-place
 * `result[1:] = result[:-1]` (on a length-(frames-1) array) shifts the series
 * forward AND DROPS the last frame's displacement off the end (a latent bug).
 * We KEEP the last frame's value: each diff loc[f+1]-loc[f] is placed at the
 * arrival index f+1, and the final diff is preserved (NOT dropped).
 */
export function primaryDisplacementFromMatrix(
  loc: Array<Array<[number, number]>>,
  reduction: Reduction,
): number[] {
  const frames = loc.length;
  if (frames === 0) return [];
  const trackCount = loc[0].length;
  const out: number[] = new Array(frames).fill(0);
  // displacement[f] = reduce_over_tracks(loc[f+1] - loc[f]); placed at index f+1
  // so the displacement is attributed to the frame it ARRIVES at. The final
  // diff (f = frames-2 -> arrival index frames-1) is kept, NOT dropped.
  for (let f = 0; f < frames - 1; f++) {
    const dists: number[] = [];
    for (let tr = 0; tr < trackCount; tr++) {
      const dx = loc[f + 1][tr][0] - loc[f][tr][0];
      const dy = loc[f + 1][tr][1] - loc[f][tr][1];
      dists.push(Math.hypot(dx, dy));
    }
    let v = reduceValues(dists, reduction);
    if (Number.isNaN(v)) v = 0; // summary.py: result[np.isnan(result)] = 0
    out[f + 1] = v;
  }
  return out;
}
