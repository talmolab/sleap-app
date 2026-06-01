/**
 * Loss-curve metric + formatting helpers for the live training monitor.
 * Pure functions, no React/store deps. Parity with sleap PyQt
 * sleap/gui/widgets/monitor.py (LossViewer/LossPlot).
 */
import type { BatchSample, EpochSample, RuntimeMetrics } from "@/stores/trainingStore";

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

function mmss(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Multi-line runtime title (one string per line). Parity with
 * monitor.py:update_runtime_title, minus matplotlib LaTeX markup. Losses are
 * formatted toExponential(3) (PyQt ":.3e"); times as mm:ss.
 */
export function formatRuntimeTitle(args: {
  epoch: number;
  maxEpochs: number;
  totalRuntimeMs: number;
  epochRuntimeMs: number | null;
  metrics: RuntimeMetrics;
  plateauPatience: number | null;
  lastValLoss: number | null;
  bestValLoss: number | null;
  bestValEpoch: number | null;
}): string[] {
  const lines: string[] = [];

  let head = `Training Epoch ${args.epoch + 1} / Total Runtime: ${mmss(args.totalRuntimeMs / 1000)}`;
  if (args.epochRuntimeMs != null) {
    head += ` / Epoch Runtime: ${mmss(args.epochRuntimeMs / 1000)}`;
  }
  lines.push(head);

  const { metrics } = args;
  if (args.lastValLoss != null) {
    if (metrics.meanEpochTimeSec != null && metrics.etaNext10Min != null) {
      lines.push(
        `Mean Time per Epoch: ${mmss(metrics.meanEpochTimeSec)} / ETA Next 10 Epochs: ${metrics.etaNext10Min} min`,
      );
      if (metrics.inPlateau && args.plateauPatience != null) {
        lines.push(`Epochs in Plateau: ${metrics.epochsInPlateau} / ${args.plateauPatience}`);
      }
    }
    lines.push(`Last Epoch Validation Loss: ${args.lastValLoss.toExponential(3)}`);
    if (args.bestValLoss != null && args.bestValEpoch != null) {
      lines.push(
        `Best Epoch Validation Loss: ${args.bestValLoss.toExponential(3)} (epoch ${args.bestValEpoch + 1})`,
      );
    }
  }
  return lines;
}

/** Build x/train/val arrays for the loss chart. x is 1-based epoch (PyQt parity). */
export function buildLossPlotData(samples: EpochSample[]): {
  x: number[];
  train: (number | null)[];
  val: (number | null)[];
} {
  return {
    x: samples.map((s) => s.epoch + 1),
    train: samples.map((s) => s.trainLoss),
    val: samples.map((s) => s.valLoss),
  };
}

/** Max batch scatter points actually DRAWN by uPlot (see buildLossPlotDataBatched). */
const MAX_DRAWN_BATCH_POINTS = 2000;

/** Evenly subsample `arr` to at most `target` items, always keeping the last one. */
function downsampleEven<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const stride = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * stride)]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Unified batch-x-axis chart data (PyQt LossViewer parity). x-axis = global batch
 * number. The dense `batch` series is per-batch train loss; `train`/`val` are
 * epoch-averaged losses placed at epoch boundaries (x = (epoch+1)*epochSize);
 * `best` is a single-point marker at the best-val epoch. All series share the
 * sorted union of x values, with null where a series has no point at that x.
 */
export function buildLossPlotDataBatched(
  batchSamples: BatchSample[],
  epochSamples: EpochSample[],
  epochSize: number,
  bestValEpoch: number | null,
  bestValLoss: number | null,
  batchesToShow: number = -1,
): {
  x: number[];
  batch: (number | null)[];
  train: (number | null)[];
  val: (number | null)[];
  best: (number | null)[];
} {
  // When batchesToShow > 0, window the dense batch trace to the LAST N points.
  // Epoch train/val/best points are always kept (sparse, span the full range),
  // matching PyQt which only windows the batch trace.
  const windowedBatches =
    batchesToShow > 0 && batchSamples.length > batchesToShow
      ? batchSamples.slice(batchSamples.length - batchesToShow)
      : batchSamples;

  // Cap the number of DRAWN batch points. uPlot renders each scatter point as an
  // individual marker; ~20k markers blocks the main thread ~800ms/redraw. Downsampling
  // the drawn dots (evenly, last point kept) is visually identical at typical chart
  // widths and keeps redraws cheap. The epoch train/val/best points are unaffected.
  const drawnBatches = downsampleEven(windowedBatches, MAX_DRAWN_BATCH_POINTS);

  const batchAt = new Map<number, number>();
  for (const b of drawnBatches) batchAt.set(b.globalBatch, b.loss);

  const trainAt = new Map<number, number | null>();
  const valAt = new Map<number, number | null>();
  for (const e of epochSamples) {
    const bx = (e.epoch + 1) * epochSize;
    trainAt.set(bx, e.trainLoss);
    valAt.set(bx, e.valLoss);
  }

  const bestX = bestValEpoch != null ? (bestValEpoch + 1) * epochSize : null;

  const xset = new Set<number>();
  for (const b of drawnBatches) xset.add(b.globalBatch);
  for (const e of epochSamples) xset.add((e.epoch + 1) * epochSize);
  const xs = Array.from(xset).sort((a, b) => a - b);

  const batch: (number | null)[] = [];
  const train: (number | null)[] = [];
  const val: (number | null)[] = [];
  const best: (number | null)[] = [];
  for (const x of xs) {
    batch.push(batchAt.has(x) ? (batchAt.get(x) as number) : null);
    train.push(trainAt.has(x) ? (trainAt.get(x) ?? null) : null);
    val.push(valAt.has(x) ? (valAt.get(x) ?? null) : null);
    best.push(bestX != null && x === bestX ? bestValLoss : null);
  }
  return { x: xs, batch, train, val, best };
}
