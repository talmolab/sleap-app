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
