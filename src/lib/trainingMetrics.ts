/**
 * Loss-curve metric + formatting helpers for the live training monitor.
 * Pure functions, no React/store deps. Parity with sleap PyQt
 * sleap/gui/widgets/monitor.py (LossViewer/LossPlot).
 */

/**
 * Linear-interpolation quantile matching numpy.quantile's default
 * ("linear" method). `sorted` MUST be ascending.
 */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
