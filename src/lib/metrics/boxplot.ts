/**
 * Pure math for the per-node distance boxplot in the detailed-metrics dialog.
 *
 * Mirrors the classic SLEAP `DetailedMetricsDialog._plot_distances` (a seaborn
 * boxplot of `dist.dists` grouped by node). uPlot has no native boxplot, so we
 * compute five-number summaries here and render a small inline SVG. All
 * quartiles use numpy's default linear-interpolation percentile so the numbers
 * line up with the Python reference.
 */

/**
 * Linear-interpolation percentile over an already-sorted, finite ascending
 * array (numpy default, aka "linear"/"C=1"). Returns NaN for an empty input.
 *
 * @param sorted ascending, finite values
 * @param p percentile in [0, 100]
 */
export function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** Five-number (plus p95) summary for one node's error distribution. */
export interface NodeBoxStats {
  /** Node label (name or `node {index}` fallback). */
  node: string;
  /** Number of finite (non-null / non-NaN) samples contributing. */
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  p95: number;
  max: number;
}

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Compute per-node boxplot statistics from a `dists` matrix (`n_pairs ×
 * n_nodes`). Each column is one node's error across all matched pairs; `null`
 * / `NaN` entries (missing nodes) are ignored. Nodes with no finite samples
 * still produce a row (all stats NaN, count 0) so the axis stays stable.
 *
 * @param dists n_pairs × n_nodes error matrix (may contain null/NaN)
 * @param nodeNames optional node labels; falls back to `node {i}`
 */
export function computeNodeBoxplots(
  dists: (number | null)[][] | null | undefined,
  nodeNames?: string[] | null,
): NodeBoxStats[] {
  const rows = Array.isArray(dists) ? dists : [];
  // Node count is the widest row (defensive against ragged input).
  let nNodes = 0;
  for (const row of rows) {
    if (Array.isArray(row)) nNodes = Math.max(nNodes, row.length);
  }
  if (nNodes === 0 && nodeNames) nNodes = nodeNames.length;

  const out: NodeBoxStats[] = [];
  for (let j = 0; j < nNodes; j++) {
    const col: number[] = [];
    for (const row of rows) {
      const v = Array.isArray(row) ? row[j] : undefined;
      if (isFiniteNumber(v)) col.push(v);
    }
    col.sort((a, b) => a - b);
    const label = nodeNames?.[j] ?? `node ${j}`;
    if (col.length === 0) {
      out.push({ node: label, count: 0, min: NaN, q1: NaN, median: NaN, q3: NaN, p95: NaN, max: NaN });
      continue;
    }
    out.push({
      node: label,
      count: col.length,
      min: col[0],
      q1: percentileSorted(col, 25),
      median: percentileSorted(col, 50),
      q3: percentileSorted(col, 75),
      p95: percentileSorted(col, 95),
      max: col[col.length - 1],
    });
  }
  return out;
}

/**
 * Upper x-axis bound for the distance plot. Mirrors classic SLEAP:
 * `ceil(ceil(nanpercentile(all, 95) / 5) + 1) * 5` — round the 95th percentile
 * up to a "nice" multiple of 5 with a little headroom. Falls back to 5 when
 * there are no finite samples.
 */
export function distanceAxisMax(dists: (number | null)[][] | null | undefined): number {
  const flat: number[] = [];
  const rows = Array.isArray(dists) ? dists : [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const v of row) if (isFiniteNumber(v)) flat.push(v);
  }
  if (flat.length === 0) return 5;
  flat.sort((a, b) => a - b);
  const p95 = percentileSorted(flat, 95);
  const xmax = Math.ceil(Math.ceil(p95 / 5) + 1) * 5;
  return Math.max(5, xmax);
}
