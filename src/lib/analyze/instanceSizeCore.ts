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

/**
 * Size a crop must have to contain an instance under rotation augmentation that
 * samples uniformly from `[-maxAngleDegrees, +maxAngleDegrees]`. Port of the
 * fork's `InstanceSizeInfo.get_rotated_size`.
 *
 * For a `w × h` box rotated by θ the axis-aligned bbox is
 * `(w·|cosθ| + h·|sinθ|) × (w·|sinθ| + h·|cosθ|)`; the worst case over the range
 * is at 0°, at the boundary angle, or (for ranges reaching 45°) at 45°. Angles
 * beyond 90° repeat by symmetry, so the range is clamped to 90°.
 *
 * Returns the raw size (`max(w, h)`) when the angle is 0, and NaN for non-finite
 * dimensions.
 */
export function rotatedSize(w: number, h: number, maxAngleDegrees: number): number {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return NaN;
  const raw = Math.max(w, h);
  if (maxAngleDegrees === 0) return raw;
  const maxAngle = Math.min(Math.abs(maxAngleDegrees), 90); // symmetry beyond 90
  const angles = new Set<number>([0, maxAngle]);
  if (maxAngle >= 45) angles.add(45);
  let max = 0;
  for (const a of angles) {
    const t = (a * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const newW = w * c + h * s;
    const newH = w * s + h * c;
    max = Math.max(max, newW, newH);
  }
  return max;
}

/** A "nice" number near `x` (Heckbert): 1, 2, 5, or 10 × a power of ten. */
function niceNum(x: number, round: boolean): number {
  if (!(x > 0)) return 0;
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/**
 * Evenly-spaced "nice" axis ticks covering `[min, max]` (Heckbert's algorithm),
 * so a chart axis reads 70, 80, 90, ... rather than 74.3, 88.6, .... Returns a
 * single tick when `min === max`, and `[]` for non-finite bounds.
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  let lo = min;
  let hi = max;
  if (hi < lo) [lo, hi] = [hi, lo];
  const n = Math.max(2, Math.floor(targetCount));
  const range = niceNum(hi - lo, false);
  const step = niceNum(range / (n - 1), true);
  if (!(step > 0)) return [lo, hi];
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const count = Math.round((niceMax - niceMin) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    // Round to the step's precision to shed float drift (e.g. 0.30000000000000004).
    const v = niceMin + i * step;
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
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

export interface SizeHistogram {
  /** Number of bins (0 for empty input, 1 for a single distinct value). */
  binCount: number;
  min: number;
  max: number;
  /** (max - min) / binCount; 0 when all values are identical. */
  binWidth: number;
  /** Bin boundaries, length `binCount + 1` (empty when `binCount` is 0). */
  edges: number[];
  /** Per-bin counts, length `binCount`. */
  counts: number[];
}

/**
 * Evenly-spaced histogram of instance sizes over `[min, max]`. Non-finite entries
 * are ignored. The maximum value is placed in the last bin (not its own extra
 * bin). A single distinct value collapses to one bin; no finite input yields an
 * empty histogram (`binCount: 0`).
 *
 * Pass an explicit `range` to fix the axis (the histogram X-min / X-max controls):
 * bins span `[range.min, range.max]` and values outside that window are dropped
 * (matching numpy `histogram(range=...)`), while summary stats still use all data.
 */
export function binSizes(
  sizes: number[],
  binCount = 24,
  range?: { min: number; max: number },
): SizeHistogram {
  const vals = sizes.filter((s) => Number.isFinite(s));
  if (vals.length === 0) {
    return { binCount: 0, min: NaN, max: NaN, binWidth: NaN, edges: [], counts: [] };
  }
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const v of vals) {
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  let min = range && Number.isFinite(range.min) ? range.min : dataMin;
  let max = range && Number.isFinite(range.max) ? range.max : dataMax;
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const inRange = vals.filter((v) => v === min).length;
    return { binCount: 1, min, max, binWidth: 0, edges: [min, max], counts: [inRange] };
  }
  const bins = Math.max(1, Math.floor(binCount));
  const binWidth = (max - min) / bins;
  const edges: number[] = [];
  for (let i = 0; i <= bins; i++) edges.push(min + i * binWidth);
  const counts = new Array<number>(bins).fill(0);
  for (const v of vals) {
    if (v < min || v > max) continue; // drop values outside an explicit range
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= bins) idx = bins - 1; // max value lands in the last bin
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return { binCount: bins, min, max, binWidth, edges, counts };
}

/**
 * The bin index a size falls into (clamped to `[0, binCount-1]`); the max value
 * lands in the last bin. Returns -1 for a non-finite size or an empty histogram.
 */
export function binIndexOf(hist: SizeHistogram, size: number): number {
  if (!Number.isFinite(size) || hist.binCount === 0) return -1;
  if (hist.binWidth === 0) return 0;
  let idx = Math.floor((size - hist.min) / hist.binWidth);
  if (idx >= hist.binCount) idx = hist.binCount - 1;
  if (idx < 0) idx = 0;
  return idx;
}
