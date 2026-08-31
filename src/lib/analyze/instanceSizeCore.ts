/**
 * Pure array-only math for the Instance Size Distribution (Analyze menu).
 * No sleap-io.js objects — only plain numbers — so it is trivially unit-testable
 * and structured-clone safe (the same split used by statisticSeriesCore.ts).
 *
 * Ported from the SLEAP fork: `sleap/gui/learning/size.py` (bbox = max-min of the
 * visible points, `size = max(w, h)`) and `widgets/size_distribution.py` (the
 * statistics panel: mean±std, median, 90/95/99th percentiles, outliers > mean+2σ).
 */
import { percentileSorted } from "@/lib/metrics/boxplot";

export interface BBox {
  w: number;
  h: number;
  /** max(w, h) — the fork's per-instance "size". */
  size: number;
}

/**
 * Axis-aligned bounding box of an instance's visible points (rows `[x, y]` from
 * `Instance.numpy()`). NaN (invisible) points are ignored. Returns `null` when
 * no point has a finite coordinate.
 */
export function bboxSize(points: number[][]): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const p of points) {
    const x = p[0];
    const y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    any = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!any) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  return { w, h, size: Math.max(w, h) };
}

export interface SizeSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Population standard deviation (ddof=0), matching numpy's `np.std` default. */
  std: number;
  median: number;
  p90: number;
  p95: number;
  p99: number;
  /** Number of sizes greater than `mean + 2*std`. */
  outlierCount: number;
}

const EMPTY: SizeSummary = {
  count: 0,
  min: NaN,
  max: NaN,
  mean: NaN,
  std: NaN,
  median: NaN,
  p90: NaN,
  p95: NaN,
  p99: NaN,
  outlierCount: 0,
};

/**
 * Summary statistics over a list of instance sizes. Non-finite entries are
 * ignored; an empty (or all-non-finite) input yields `count: 0` with NaN stats.
 */
export function summarizeSizes(sizes: number[]): SizeSummary {
  const vals = sizes.filter((s) => Number.isFinite(s));
  const n = vals.length;
  if (n === 0) return { ...EMPTY };
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  const threshold = mean + 2 * std;
  let outlierCount = 0;
  for (const v of vals) if (v > threshold) outlierCount++;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    std,
    median: percentileSorted(sorted, 50),
    p90: percentileSorted(sorted, 90),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    outlierCount,
  };
}
