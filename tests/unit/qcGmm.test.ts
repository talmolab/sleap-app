/**
 * Unit tests for the QC GMM (Gaussian mixture) detector.
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp (src/lib/qc/checks/gmm.test.js),
 * a lab JS port of Python `sleap.qc` intended for integration into sleap-app.
 * The reference's source-text assertion (sorted copy built at fit time) is
 * dropped; the percentile behavior it guarded is tested directly instead.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "../bun-test";
import {
  GaussianMixture,
  GMMDetector,
  standardScalerFit,
  scalerTransform,
} from "@/lib/analyze/qc/gmm";

describe("StandardScaler", () => {
  it("standardizes to mean 0 / unit scale (ddof=0)", () => {
    const s = standardScalerFit([[0], [2]]);
    expect(s.mean[0]).toBeCloseTo(1, 12);
    expect(s.scale[0]).toBeCloseTo(1, 12);
    expect(scalerTransform([[0], [2]], s)).toEqual([[-1], [1]]);
  });

  it("gives a constant column scale 1 instead of dividing by zero", () => {
    const s = standardScalerFit([[3, 0], [3, 2]]);
    expect(s.scale[0]).toBe(1);
    expect(scalerTransform([[3, 0]], s)[0][0]).toBe(0);
  });
});

describe("GaussianMixture.scoreSamples", () => {
  it("matches the analytic isotropic Gaussian log-density", () => {
    const g = GaussianMixture.fromParams({ weights: [1], means: [[0, 0]], covariances: [[[1, 0], [0, 1]]] });
    expect(g.scoreSamples([[0, 0]])[0]).toBeCloseTo(-Math.log(2 * Math.PI), 10);
    expect(g.scoreSamples([[1, 0]])[0]).toBeCloseTo(-Math.log(2 * Math.PI) - 0.5, 10);
  });

  it("handles full (non-diagonal) covariance via Cholesky", () => {
    // cov=[[2,1],[1,2]], |cov|=3, at x=[1,1]: dᵀ cov⁻¹ d = (1/3)(2−1−1+2) = 2/3
    const g = GaussianMixture.fromParams({ weights: [1], means: [[0, 0]], covariances: [[[2, 1], [1, 2]]] });
    const expected = -0.5 * (2 * Math.log(2 * Math.PI) + Math.log(3) + 2 / 3);
    expect(g.scoreSamples([[1, 1]])[0]).toBeCloseTo(expected, 10);
  });

  it("mixes components (logsumexp of weighted densities)", () => {
    const g = GaussianMixture.fromParams({
      weights: [0.5, 0.5],
      means: [[0, 0], [10, 0]],
      covariances: [[[1, 0], [0, 1]], [[1, 0], [0, 1]]],
    });
    // at the origin the far component is negligible: ~ log(0.5) - log(2π)
    expect(g.scoreSamples([[0, 0]])[0]).toBeCloseTo(Math.log(0.5) - Math.log(2 * Math.PI), 6);
  });

  it("fits two well-separated groups to their means", () => {
    const pts = [[-1.0], [-0.8], [-0.6], [1.0], [1.2], [1.4]];
    const g = new GaussianMixture({ nComponents: 2 }).fit(pts);
    const means = g.means.map((m) => m[0]).sort((a, b) => a - b);
    expect(means[0]).toBeCloseTo(-0.8, 3);
    expect(means[1]).toBeCloseTo(1.2, 3);
    expect(g.weights[0]).toBeCloseTo(0.5, 3);
  });
});

describe("GMMDetector", () => {
  const frac = (x: number) => x - Math.floor(x);
  const cluster = Array.from({ length: 60 }, (_, i) => [
    frac(Math.sin(i * 12.9898) * 43758.5453) * 2 - 1,
    frac(Math.sin((i + 100) * 78.233) * 43758.5453) * 2 - 1,
  ]); // blob in [-1,1]^2

  it("flags a far outlier maximally and an interior point less", () => {
    const det = new GMMDetector({ nComponents: 5 }).fit(cluster);
    const outlier = det.scoreOne([100, 100]);
    expect(outlier).toBeGreaterThan(0.99); // below all training log-likelihoods
    expect(det.scoreOne([0, 0])).toBeLessThan(outlier);
  });

  it("is deterministic (seeded EM)", () => {
    const a = new GMMDetector({ nComponents: 5 }).fit(cluster).scoreOne([5, 5]);
    const b = new GMMDetector({ nComponents: 5 }).fit(cluster).scoreOne([5, 5]);
    expect(a).toBe(b);
  });

  it("uses at most one component per 10 rows", () => {
    expect(new GMMDetector({ nComponents: 5 }).fit(cluster.slice(0, 25)).nComponentsUsed).toBe(2);
    expect(new GMMDetector({ nComponents: 5 }).fit(cluster.slice(0, 5)).nComponentsUsed).toBe(1);
  });

  it("scores the valley between two groups as the least typical (the 1-D example)", () => {
    const pts = Array.from({ length: 30 }, (_, i) => [i < 15 ? -0.8 + (i % 5) * 0.05 : 1.2 + (i % 5) * 0.05]);
    const det = new GMMDetector({ nComponents: 2 }).fit(pts);
    expect(det.scoreOne([0.2])).toBe(1); // every training pose is more typical
    expect(det.scoreOne([-0.7])).toBeLessThan(0.95);
  });

  it("returns NaN for a vector with NaNs", () => {
    const det = new GMMDetector({ nComponents: 5 }).fit(cluster);
    expect(Number.isNaN(det.scoreOne([Number.NaN, 0]))).toBe(true);
    expect(det.logLikelihoodOne([Number.NaN, 0])).toBe(-Infinity);
  });

  it("attributes improbability to the off dimension (worstFeature)", () => {
    const det = new GMMDetector({ nComponents: 5 }).fit(cluster);
    expect(det.worstFeature([100, 0]).index).toBe(0); // far in x -> dimension 0
    expect(det.worstFeature([0, 100]).index).toBe(1); // far in y -> dimension 1
    // the per-feature contributions decompose the (positive-definite) Mahalanobis distance
    const sum = det.worstFeature([100, 0]).contributions.reduce((s, c) => s + c, 0);
    expect(sum).toBeGreaterThan(0);
    expect(det.worstFeature([0, 0]).index).toBeGreaterThanOrEqual(0); // interior point: still defined
  });
});

describe("the percentile score", () => {
  // Reference behavior: score = 1 - (#training log-likelihoods strictly below ll) / #training.
  const det = (trainLL: number[]) => {
    const d = new GMMDetector();
    d.setTrainingLogLikelihoods(trainLL);
    return d;
  };
  const reduceWay = (trainLL: number[], ll: number) =>
    1 - trainLL.reduce((s, t) => s + (t < ll ? 1 : 0), 0) / trainLL.length;

  it("matches a full count on data with many ties and out-of-range queries", () => {
    const rng = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const trainLL = Array.from({ length: 400 }, (_, i) => Math.round(rng(i + 1) * 40) / 4);
    const d = det(trainLL);
    for (const q of [...trainLL, -1e9, 1e9, 0, 2.5, 2.5000001]) {
      expect(d.percentileScore(q)).toBeCloseTo(reduceWay(trainLL, q), 12);
    }
  });

  it("drops non-finite training values from the count but keeps them in the denominator", () => {
    const d = det([1, 2, Number.NaN, 3, 4]);
    expect(d.percentileScore(2.5)).toBeCloseTo(1 - 2 / 5, 12);
  });
});

/**
 * Parity with PyQt SLEAP's `sleap/qc/gmm.py` (sklearn). The fixture was made by
 * fitting that GMMDetector on a fixed 120 x 18 matrix (three correlated blobs)
 * and saving its scaler, mixture parameters, training log-likelihoods and the
 * scores of 15 query rows (10 training rows + 5 far-off rows).
 */
describe("parity with sleap.qc's sklearn GMM", () => {
  const fx = JSON.parse(readFileSync("tests/fixtures/qc/gmm_sklearn_parity.json", "utf8")) as {
    train: number[][];
    scaler: { mean: number[]; scale: number[] };
    gmm: { weights: number[]; means: number[][]; covariances: number[][][] };
    trainLogLikelihoods: number[];
    queries: number[][];
    queryLogLikelihoods: number[];
    queryScores: number[];
  };
  const loaded = GMMDetector.fromParams({ scaler: fx.scaler, gmm: fx.gmm, trainLL: fx.trainLogLikelihoods });

  it("computes the same log-likelihood as sklearn with sklearn's fitted parameters", () => {
    fx.queries.forEach((q, i) => {
      const ll = loaded.logLikelihoodOne(q);
      expect(Math.abs(ll - fx.queryLogLikelihoods[i]) / Math.max(1, Math.abs(fx.queryLogLikelihoods[i]))).toBeLessThan(1e-9);
    });
  });

  it("ranks sklearn's log-likelihoods into the same 0–1 scores as sleap.qc", () => {
    // Ranked from sklearn's own values: a training row recomputed here can differ
    // from its stored value in the 13th digit, which flips a strict tie with itself.
    fx.queryLogLikelihoods.forEach((ll, i) =>
      expect(loaded.percentileScore(ll)).toBeCloseTo(fx.queryScores[i], 12),
    );
  });

  it("fitting here agrees with sklearn on what is stable across fits", () => {
    // Which in-distribution rows land in the bottom 5% depends on the EM start, in
    // sklearn too (this fixture's row 6 is flagged with random_state=0 and not 42),
    // so only the stable parts are compared: far-off rows score 1 and ~5% of the
    // training rows are flagged.
    const own = new GMMDetector({ nComponents: 5 }).fit(fx.train);
    fx.queries.slice(10).forEach((q) => expect(own.scoreOne(q)).toBe(1));
    const flagged = fx.train.filter((r) => own.scoreOne(r) >= own.flagThreshold).length;
    expect(flagged).toBeGreaterThanOrEqual(5);
    expect(flagged).toBeLessThanOrEqual(8);
  });
});
