/**
 * Loss-curve metric + formatting helpers for the live training monitor.
 * Pure functions, no React/store deps. Parity with sleap PyQt
 * sleap/gui/widgets/monitor.py (LossViewer/LossPlot).
 */
import type { EpochSample, RuntimeMetrics } from "@/stores/trainingStore";

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

/**
 * y-axis [min,max] for the loss chart. Parity with monitor.py:_calculate_ylim
 * (log-space padding + optional IQR outlier rejection). Returns null when there
 * is no finite data to fit (caller falls back to a default range).
 */
export function computeYRange(
  values: number[],
  opts: { logScale: boolean; ignoreOutliers: boolean },
): [number, number] | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

  if (opts.logScale) {
    const pos = finite.filter((v) => v > 0).sort((a, b) => a - b);
    if (pos.length === 0) return null;
    const logY = pos.map((v) => Math.log10(v));
    let logMin = logY[0];
    let logMax = logY[logY.length - 1];
    if (opts.ignoreOutliers && logY.length >= 4) {
      const q1 = quantile(logY, 0.25);
      const q3 = quantile(logY, 0.75);
      const iqr = q3 - q1;
      logMin = Math.max(q1 - 1.5 * iqr, logY[0]);
      logMax = Math.min(q3 + 1.5 * iqr, logY[logY.length - 1]);
    }
    const pad = logMax > logMin ? (logMax - logMin) * 0.02 : 0.05;
    return [10 ** (logMin - pad), 10 ** (logMax + pad)];
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const dy = (max - min) * 0.02;
  if (opts.ignoreOutliers && sorted.length >= 1) {
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    return [Math.max(q1 - iqr * 1.5, min - dy), Math.min(q3 + iqr * 1.5, max + dy)];
  }
  return [min - dy, max + dy];
}

/**
 * Mean-epoch-time / ETA / plateau metrics. Parity with monitor.py:1017-1047.
 * - meanEpochTimeSec = elapsed / nEpochsCompleted
 * - etaNext10Min = floor(meanEpochTimeSec * 10 / 60)
 * - plateau: improvement iff valLoss < bestSoFar - (minDelta ?? 0);
 *   epochsInPlateau increments on non-improvement, resets to 0 on improvement.
 */
export function computeRuntimeMetrics(
  epochSamples: EpochSample[],
  startedAtMs: number,
  nowMs: number,
  plateauMinDelta: number | null,
): RuntimeMetrics {
  const valSamples = epochSamples.filter(
    (s) => s.valLoss != null && Number.isFinite(s.valLoss),
  );

  let bestVal = Infinity;
  let bestValEpoch: number | null = null;
  let epochsInPlateau = 0;
  let inPlateau = false;
  const delta = plateauMinDelta ?? 0;

  for (const s of valSamples) {
    const v = s.valLoss as number;
    const isBetter = bestValEpoch === null ? true : v < bestVal - delta;
    if (isBetter) {
      bestVal = v;
      bestValEpoch = s.epoch;
      epochsInPlateau = 0;
      inPlateau = false;
    } else {
      epochsInPlateau += 1;
      inPlateau = true;
    }
  }

  let meanEpochTimeSec: number | null = null;
  let etaNext10Min: number | null = null;
  const nCompleted = epochSamples.length;
  if (nCompleted >= 1) {
    const elapsedSec = (nowMs - startedAtMs) / 1000;
    meanEpochTimeSec = elapsedSec / nCompleted;
    etaNext10Min = Math.floor((meanEpochTimeSec * 10) / 60);
  }

  return { meanEpochTimeSec, etaNext10Min, epochsInPlateau, inPlateau, bestValEpoch };
}
