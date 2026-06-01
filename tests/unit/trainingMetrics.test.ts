import { describe, it, expect } from "../bun-test";
import {
  quantile,
  computeYRange,
  computeRuntimeMetrics,
  formatRuntimeTitle,
  buildLossPlotData,
  buildLossPlotDataBatched,
} from "@/lib/trainingMetrics";
import type { EpochSample } from "@/stores/trainingStore";

const ep = (epoch: number, trainLoss: number, valLoss: number): EpochSample => ({
  epoch, trainLoss, valLoss,
});

describe("quantile", () => {
  it("computes the median with linear interpolation", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
  });
  it("computes q1 and q3 like numpy.quantile default", () => {
    // numpy.quantile([1,2,3,4,5], 0.25) === 2 ; 0.75 === 4
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBeCloseTo(2, 10);
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBeCloseTo(4, 10);
  });
  it("returns the single value for a 1-element array", () => {
    expect(quantile([7], 0.25)).toBe(7);
  });
});

describe("computeYRange", () => {
  it("returns null when no positive data in log scale", () => {
    expect(computeYRange([0, -1], { logScale: true, ignoreOutliers: false })).toBeNull();
  });
  it("pads log range in log space", () => {
    const r = computeYRange([1, 10, 100], { logScale: true, ignoreOutliers: false });
    expect(r).not.toBeNull();
    // log10 range is [0,2]; pad = 2*0.02 = 0.04 → [10^-0.04, 10^2.04]
    expect(r![0]).toBeCloseTo(10 ** -0.04, 6);
    expect(r![1]).toBeCloseTo(10 ** 2.04, 4);
  });
  it("pads linear range by 2% of peak-to-peak", () => {
    const r = computeYRange([1, 2, 3], { logScale: false, ignoreOutliers: false });
    // ptp = 2, dy = 0.04 → [1-0.04, 3+0.04]
    expect(r![0]).toBeCloseTo(0.96, 6);
    expect(r![1]).toBeCloseTo(3.04, 6);
  });
  it("clamps outliers via IQR when enabled and >=4 points (linear)", () => {
    const r = computeYRange([1, 2, 3, 4, 100], { logScale: false, ignoreOutliers: true });
    // q1=2, q3=4, iqr=2 → upper clamp min(q3+3, max+dy) = min(7, 100+dy) = 7
    expect(r![1]).toBeCloseTo(7, 6);
  });
});

describe("computeRuntimeMetrics", () => {
  it("computes mean epoch time and ETA over completed epochs", () => {
    const samples = [ep(0, 1.0, 0.9), ep(1, 0.8, 0.7)]; // 2 epochs
    // started at t=0, now=120_000ms (120s) → mean = 60s/epoch, ETA10 = floor(600/60)=10 min
    const m = computeRuntimeMetrics(samples, 0, 120_000, null);
    expect(m.meanEpochTimeSec).toBeCloseTo(60, 6);
    expect(m.etaNext10Min).toBe(10);
  });
  it("tracks best val epoch and plateau count", () => {
    const samples = [ep(0, 1, 0.5), ep(1, 0.9, 0.6), ep(2, 0.8, 0.7)];
    const m = computeRuntimeMetrics(samples, 0, 30_000, null);
    expect(m.bestValEpoch).toBe(0);        // 0.5 is best
    expect(m.inPlateau).toBe(true);        // last (0.7) did not improve
    expect(m.epochsInPlateau).toBe(2);     // epochs 1 and 2 both non-improving
  });
  it("resets plateau on improvement and honors minDelta", () => {
    const samples = [ep(0, 1, 0.50), ep(1, 0.9, 0.499)]; // tiny improvement
    const withDelta = computeRuntimeMetrics(samples, 0, 20_000, 0.01); // 0.499 not < 0.50-0.01=0.49
    expect(withDelta.inPlateau).toBe(true);
    expect(withDelta.epochsInPlateau).toBe(1);
    const noDelta = computeRuntimeMetrics(samples, 0, 20_000, null); // 0.499 < 0.50 → improves
    expect(noDelta.inPlateau).toBe(false);
    expect(noDelta.epochsInPlateau).toBe(0);
    expect(noDelta.bestValEpoch).toBe(1);
  });
  it("returns empty-ish metrics for no val samples", () => {
    const m = computeRuntimeMetrics([ep(0, 1, NaN)], 0, 10_000, null);
    expect(m.bestValEpoch).toBeNull();
    expect(m.epochsInPlateau).toBe(0);
  });
});

describe("formatRuntimeTitle", () => {
  it("renders epoch + total runtime line", () => {
    const lines = formatRuntimeTitle({
      epoch: 4, maxEpochs: 100, totalRuntimeMs: 65_000, epochRuntimeMs: 5_000,
      metrics: { meanEpochTimeSec: null, etaNext10Min: null, epochsInPlateau: 0, inPlateau: false, bestValEpoch: null },
      plateauPatience: null, lastValLoss: null, bestValLoss: null, bestValEpoch: null,
    });
    expect(lines[0]).toContain("Epoch 5");          // epoch+1
    expect(lines[0]).toContain("01:05");            // total runtime mm:ss
    expect(lines[0]).toContain("00:05");            // epoch runtime
  });
  it("includes ETA, plateau, last and best val lines when available", () => {
    const lines = formatRuntimeTitle({
      epoch: 9, maxEpochs: 100, totalRuntimeMs: 600_000, epochRuntimeMs: null,
      metrics: { meanEpochTimeSec: 60, etaNext10Min: 10, epochsInPlateau: 3, inPlateau: true, bestValEpoch: 2 },
      plateauPatience: 10, lastValLoss: 0.0123, bestValLoss: 0.0099, bestValEpoch: 2,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("Mean Time per Epoch: 01:00");
    expect(joined).toContain("ETA Next 10 Epochs: 10 min");
    expect(joined).toContain("Epochs in Plateau: 3 / 10");
    expect(joined).toMatch(/Last Epoch Validation Loss: 1\.230e-2/);
    expect(joined).toMatch(/Best Epoch Validation Loss: 9\.900e-3 \(epoch 3\)/); // bestValEpoch+1
  });
});

describe("buildLossPlotData", () => {
  it("builds aligned [x, train, val] arrays with 1-based epochs", () => {
    const d = buildLossPlotData([
      { epoch: 0, trainLoss: 1.0, valLoss: 0.9 },
      { epoch: 1, trainLoss: 0.8, valLoss: null },
    ]);
    expect(d.x).toEqual([1, 2]);
    expect(d.train).toEqual([1.0, 0.8]);
    expect(d.val).toEqual([0.9, null]);
  });
  it("returns empty arrays for no samples", () => {
    const d = buildLossPlotData([]);
    expect(d.x).toEqual([]);
    expect(d.train).toEqual([]);
    expect(d.val).toEqual([]);
  });
});

describe("buildLossPlotDataBatched", () => {
  it("aligns batch trace + epoch train/val + best on a unified x-axis", () => {
    const d = buildLossPlotDataBatched(
      [ { globalBatch: 0, loss: 1.0 }, { globalBatch: 1, loss: 0.9 } ], // batchSamples
      [ { epoch: 0, trainLoss: 0.95, valLoss: 0.8 } ],                  // epochSamples
      2,        // epochSize → epoch-0 boundary at (0+1)*2 = 2
      0,        // bestValEpoch
      0.8,      // bestValLoss
    );
    expect(d.x).toEqual([0, 1, 2]);
    expect(d.batch).toEqual([1.0, 0.9, null]);
    expect(d.train).toEqual([null, null, 0.95]);
    expect(d.val).toEqual([null, null, 0.8]);
    expect(d.best).toEqual([null, null, 0.8]);   // best at (0+1)*2 = 2
  });

  it("returns empty arrays when there is no data", () => {
    const d = buildLossPlotDataBatched([], [], 1, null, null);
    expect(d.x).toEqual([]);
    expect(d.batch).toEqual([]);
    expect(d.train).toEqual([]);
    expect(d.val).toEqual([]);
    expect(d.best).toEqual([]);
  });

  it("handles a batch point coinciding with an epoch boundary (shared x)", () => {
    // epochSize=2, epoch 0 boundary at x=2; a batch point also lands at x=2
    const d = buildLossPlotDataBatched(
      [ { globalBatch: 2, loss: 0.7 } ],
      [ { epoch: 0, trainLoss: 0.75, valLoss: 0.6 } ],
      2, 0, 0.6,
    );
    expect(d.x).toEqual([2]);
    expect(d.batch).toEqual([0.7]);   // batch value present
    expect(d.train).toEqual([0.75]);  // AND epoch values present at same x
    expect(d.val).toEqual([0.6]);
    expect(d.best).toEqual([0.6]);
  });

  it("carries null epoch losses through (no val that epoch)", () => {
    const d = buildLossPlotDataBatched(
      [],
      [ { epoch: 0, trainLoss: 0.5, valLoss: null } ],
      3, null, null,
    );
    expect(d.x).toEqual([3]);          // (0+1)*3
    expect(d.train).toEqual([0.5]);
    expect(d.val).toEqual([null]);
    expect(d.best).toEqual([null]);
  });
});

describe("buildLossPlotDataBatched windowing", () => {
  it("keeps only the last N batch points but all epoch points", () => {
    const batches = [
      { globalBatch: 0, loss: 1.0 },
      { globalBatch: 1, loss: 0.9 },
      { globalBatch: 2, loss: 0.8 },
      { globalBatch: 3, loss: 0.7 },
    ];
    const epochs = [{ epoch: 0, trainLoss: 0.85, valLoss: 0.6 }]; // boundary x = (0+1)*4 = 4
    const d = buildLossPlotDataBatched(batches, epochs, 4, 0, 0.6, 2); // batchesToShow=2
    // only last 2 batch points (globalBatch 2,3) + the epoch boundary at x=4
    expect(d.x).toEqual([2, 3, 4]);
    expect(d.batch).toEqual([0.8, 0.7, null]);
    expect(d.train).toEqual([null, null, 0.85]);
    expect(d.val).toEqual([null, null, 0.6]);
  });
  it("shows all batch points when batchesToShow <= 0 (All)", () => {
    const batches = [ { globalBatch: 0, loss: 1.0 }, { globalBatch: 1, loss: 0.9 } ];
    const d = buildLossPlotDataBatched(batches, [], 1, null, null, -1);
    expect(d.x).toEqual([0, 1]);
    expect(d.batch).toEqual([1.0, 0.9]);
  });
});

describe("buildLossPlotDataBatched downsampling (uPlot render cap)", () => {
  it("caps drawn batch points to ~2000 and always keeps the most recent point", () => {
    // 5000 batches, "All" — must downsample so uPlot doesn't draw 5000 markers.
    const batches = Array.from({ length: 5000 }, (_, i) => ({ globalBatch: i, loss: 1 / (i + 1) }));
    const d = buildLossPlotDataBatched(batches, [], 1, null, null, -1);
    expect(d.x.length).toBe(2001);            // 2000 even samples + the kept last point
    expect(d.x.length).toBeGreaterThan(1900); // far fewer than the raw 5000
    expect(d.x[d.x.length - 1]).toBe(4999);   // most recent batch preserved
    expect(d.batch[d.batch.length - 1]).toBe(1 / 5000);
  });

  it("does not downsample when batch count is under the cap", () => {
    const batches = Array.from({ length: 100 }, (_, i) => ({ globalBatch: i, loss: 1 }));
    const d = buildLossPlotDataBatched(batches, [], 1, null, null, -1);
    expect(d.x.length).toBe(100);
  });

  it("keeps all epoch train/val points even when batch points are downsampled", () => {
    const batches = Array.from({ length: 5000 }, (_, i) => ({ globalBatch: i, loss: 0.5 }));
    const epochs = [
      { epoch: 0, trainLoss: 0.4, valLoss: 0.6 },
      { epoch: 1, trainLoss: 0.3, valLoss: 0.5 },
    ];
    const d = buildLossPlotDataBatched(batches, epochs, 2500, null, null, -1);
    // both epoch boundaries (x = 2500, 5000) must carry their train/val values
    expect(d.train.filter((v) => v != null)).toEqual([0.4, 0.3]);
    expect(d.val.filter((v) => v != null)).toEqual([0.6, 0.5]);
  });
});
