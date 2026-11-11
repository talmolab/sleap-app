/**
 * Gaussian mixture (GMM) anomaly detector: fits a few full-covariance "clusters"
 * of typical poses to the standardized feature vectors and scores each pose by
 * how unlikely it is under them, as a percentile of the training poses.
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp (`src/lib/qc/checks/gmm.js`,
 * itself a port of `sleap/qc/gmm.py`'s sklearn GaussianMixture path), a lab JS
 * port of Python `sleap.qc` intended for integration into sleap-app.
 *
 * Parity: scoring (`scoreSamples`) is the same math as sklearn's and matches it
 * exactly given the same fitted parameters (`GaussianMixture.fromParams`). The
 * fit itself can't bit-match sklearn (different k-means initialization and RNG),
 * so fitted scores are close to, not identical with, PyQt SLEAP's. The fit is
 * seeded, so the same labels always give the same scores here.
 *
 * Added for sleap-app: {@link GaussianMixture.fitSteps} (yield between EM rounds
 * so a large fit can run without freezing the UI) and {@link LikelihoodRank}.
 */

const LOG_2PI = Math.log(2 * Math.PI);

type Row = ArrayLike<number>;
type Matrix = Float64Array[];

// ---- small linear algebra on symmetric positive-definite D×D matrices ----

function cholesky(A: Row[], n: number): Matrix {
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) s = 1e-12; // guard a non-positive-definite matrix (regCovar normally prevents it)
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Solve L y = b (lower-triangular forward substitution). */
function forwardSolve(L: Matrix, b: Row, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

/** Solve Lᵀ v = b (upper-triangular back substitution; (Lᵀ)ᵢⱼ = Lⱼᵢ). */
function backSolveT(L: Matrix, b: Row, n: number): Float64Array {
  const v = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= L[j][i] * v[j];
    v[i] = s / L[i][i];
  }
  return v;
}

function logsumexp(arr: number[]): number {
  let m = -Infinity;
  for (const x of arr) if (x > m) m = x;
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of arr) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** log N(x | mean, cov), with cov given by its Cholesky factor L and logDet = log|cov|. */
function logGaussian(x: Row, mean: Row, L: Matrix, logDet: number, n: number): number {
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = x[i] - mean[i];
  const z = forwardSolve(L, d, n); // ‖z‖² = dᵀ cov⁻¹ d
  let quad = 0;
  for (let i = 0; i < n; i++) quad += z[i] * z[i];
  return -0.5 * (n * LOG_2PI + logDet + quad);
}

// ---- StandardScaler (ddof=0; a zero-variance column gets scale 1, like sklearn) ----

export interface Scaler {
  mean: Float64Array;
  scale: Float64Array;
}

export function standardScalerFit(X: Row[]): Scaler {
  const n = X.length;
  const d = X[0].length;
  const mean = new Float64Array(d);
  const scale = new Float64Array(d);
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += X[i][j];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i][j] - m) * (X[i][j] - m);
    v /= n;
    mean[j] = m;
    scale[j] = Math.sqrt(v) || 1;
    if (scale[j] <= 1e-12) scale[j] = 1;
  }
  return { mean, scale };
}

const scaleRow = (row: Row, { mean, scale }: Scaler): number[] =>
  Array.from(row, (v, j) => (v - mean[j]) / scale[j]);

export const scalerTransform = (X: Row[], s: Scaler): number[][] => X.map((r) => scaleRow(r, s));

// ---- Gaussian mixture (full covariance), fitted by EM ----

export interface GaussianMixtureOptions {
  nComponents?: number;
  /** Added to each covariance diagonal (sklearn `reg_covar`), so no cluster collapses. */
  regCovar?: number;
  maxIter?: number;
  /** Stop when the mean log-likelihood changes by less than this between rounds. */
  tol?: number;
  seed?: number;
}

export class GaussianMixture {
  K: number;
  regCovar: number;
  maxIter: number;
  tol: number;
  seed: number;
  d = 0;
  weights: number[] = [];
  means: Float64Array[] = [];
  covariances: Matrix[] = [];
  /** Cholesky factors, log-determinants and log-weights, rebuilt by `prepare()`. */
  chol: Matrix[] = [];
  logDet: number[] = [];
  logW: number[] = [];

  constructor({ nComponents = 1, regCovar = 1e-6, maxIter = 100, tol = 1e-3, seed = 42 }: GaussianMixtureOptions = {}) {
    this.K = nComponents;
    this.regCovar = regCovar;
    this.maxIter = maxIter;
    this.tol = tol;
    this.seed = seed;
  }

  /** Load already-fitted parameters (e.g. from sklearn) to score with them. */
  static fromParams({ weights, means, covariances }: { weights: number[]; means: Row[]; covariances: Row[][] }): GaussianMixture {
    const gmm = new GaussianMixture({ nComponents: weights.length });
    gmm.weights = weights;
    gmm.means = means.map((m) => Float64Array.from(m));
    gmm.covariances = covariances.map((c) => c.map((r) => Float64Array.from(r)));
    gmm.prepare();
    return gmm;
  }

  prepare(): void {
    const d = this.means[0].length;
    this.d = d;
    this.chol = this.covariances.map((cov) => cholesky(cov, d));
    this.logDet = this.chol.map((L) => {
      let s = 0;
      for (let i = 0; i < d; i++) s += Math.log(L[i][i]);
      return 2 * s;
    });
    this.logW = this.weights.map((w) => Math.log(w));
  }

  /** Weighted log-density of `x` under each component. */
  componentLogProbs(x: Row): number[] {
    const out = new Array<number>(this.K);
    for (let k = 0; k < this.K; k++) out[k] = this.logW[k] + logGaussian(x, this.means[k], this.chol[k], this.logDet[k], this.d);
    return out;
  }

  /** log p(x) per sample (matches sklearn `GaussianMixture.score_samples`). */
  scoreSamples(X: Row[]): number[] {
    return X.map((x) => logsumexp(this.componentLogProbs(x)));
  }

  fit(X: Row[]): this {
    const steps = this.fitSteps(X);
    while (!steps.next().done) {
      // run every EM round to completion
    }
    return this;
  }

  /**
   * The EM fit as a generator that yields once per round, so an async caller
   * can hand control back to the UI (and honor a cancel) between rounds.
   */
  *fitSteps(X: Row[]): Generator<number, void, void> {
    const n = X.length;
    const d = X[0].length;
    this.d = d;
    const rng = mulberry32(this.seed);

    // Initialize like sklearn (init_params="kmeans"): k-means++ seeds refined by
    // k-means to convergence, then a hard assignment -> initial parameters. (The
    // reference stopped at the seeds, which left small, unstable components.)
    const labels = kmeans(X, kmeanspp(X, this.K, rng));
    this.mStep(X, oneHot(labels, this.K));

    let prev = -Infinity;
    for (let iter = 0; iter < this.maxIter; iter++) {
      this.prepare();
      // E-step: each row's membership in each component.
      const resp = new Array<number[]>(n);
      let ll = 0;
      for (let i = 0; i < n; i++) {
        const comp = this.componentLogProbs(X[i]);
        const norm = logsumexp(comp);
        ll += norm;
        resp[i] = comp.map((c) => Math.exp(c - norm));
      }
      ll /= n; // mean log-likelihood (sklearn's convergence measure)
      // M-step: centers, spreads and weights from those memberships.
      this.mStep(X, resp);
      yield iter;
      if (Math.abs(ll - prev) < this.tol) break;
      prev = ll;
    }
    this.prepare();
  }

  private mStep(X: Row[], resp: number[][]): void {
    const n = X.length;
    const d = this.d;
    const Nk = new Array<number>(this.K).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < this.K; k++) Nk[k] += resp[i][k];

    this.weights = Nk.map((nk) => nk / n);
    this.means = Array.from({ length: this.K }, () => new Float64Array(d));
    for (let k = 0; k < this.K; k++) {
      const m = this.means[k];
      for (let i = 0; i < n; i++) {
        const r = resp[i][k];
        for (let j = 0; j < d; j++) m[j] += r * X[i][j];
      }
      for (let j = 0; j < d; j++) m[j] /= Nk[k] || 1;
    }
    this.covariances = Array.from({ length: this.K }, () => identity(d, 0));
    const diff = new Float64Array(d);
    for (let k = 0; k < this.K; k++) {
      const cov = this.covariances[k];
      const m = this.means[k];
      for (let i = 0; i < n; i++) {
        const r = resp[i][k];
        if (r === 0) continue;
        for (let j = 0; j < d; j++) diff[j] = X[i][j] - m[j];
        for (let a = 0; a < d; a++) {
          const ra = r * diff[a];
          const row = cov[a];
          for (let b = 0; b < d; b++) row[b] += ra * diff[b];
        }
      }
      for (let a = 0; a < d; a++) {
        for (let b = 0; b < d; b++) cov[a][b] /= Nk[k] || 1;
        cov[a][a] += this.regCovar;
      }
    }
  }
}

// ---- percentile ranking of log-likelihoods ----

/**
 * Ranks a log-likelihood against the training poses':
 * score = 1 − (training log-likelihoods strictly below it) / (training count).
 * Non-finite training values are left out of the count but kept in the count of
 * training poses, as the reference does. A binary search over a sorted copy
 * replaces a full scan per scored pose.
 */
export class LikelihoodRank {
  private sorted: Float64Array;
  private total: number;

  constructor(trainLL: number[]) {
    this.total = trainLL.length;
    this.sorted = Float64Array.from(trainLL.filter((t) => Number.isFinite(t))).sort();
  }

  score(ll: number): number {
    const a = this.sorted;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < ll) lo = mid + 1;
      else hi = mid;
    }
    return 1 - lo / this.total;
  }
}

// ---- detector (mirrors sleap/qc/gmm.py GMMDetector) ----

export interface GMMDetectorOptions {
  nComponents?: number;
  /** Percent of training poses treated as anomalous (5 => flag score ≥ 0.95). */
  percentileThreshold?: number;
}

export interface WorstFeature {
  /** Feature index the GMM finds most off, or -1 if unfitted / NaN input. */
  index: number;
  /** Per-feature terms of the Mahalanobis distance under the closest component. */
  contributions: number[];
  component: number;
}

export class GMMDetector {
  nComponents: number;
  percentileThreshold: number;
  nComponentsUsed = 0;
  scaler: Scaler | null = null;
  gmm: GaussianMixture | null = null;
  trainLL: number[] = [];
  private rank: LikelihoodRank = new LikelihoodRank([]);

  constructor({ nComponents = 5, percentileThreshold = 5.0 }: GMMDetectorOptions = {}) {
    this.nComponents = nComponents;
    this.percentileThreshold = percentileThreshold;
  }

  /** A detector with already-fitted parameters (e.g. from sklearn), for scoring only. */
  static fromParams({
    scaler,
    gmm,
    trainLL,
    percentileThreshold,
  }: {
    scaler: { mean: number[]; scale: number[] };
    gmm: { weights: number[]; means: Row[]; covariances: Row[][] };
    trainLL: number[];
    percentileThreshold?: number;
  }): GMMDetector {
    const det = new GMMDetector({ nComponents: gmm.weights.length, percentileThreshold });
    det.nComponentsUsed = gmm.weights.length;
    det.scaler = { mean: Float64Array.from(scaler.mean), scale: Float64Array.from(scaler.scale) };
    det.gmm = GaussianMixture.fromParams(gmm);
    det.setTrainingLogLikelihoods(trainLL);
    return det;
  }

  /** Score at or above which a pose is flagged (5% => 0.95). */
  get flagThreshold(): number {
    return 1 - this.percentileThreshold / 100;
  }

  fit(matrix: Row[]): this {
    const steps = this.fitSteps(matrix);
    while (!steps.next().done) {
      // run to completion
    }
    return this;
  }

  /** Fit as a generator yielding once per EM round (see {@link GaussianMixture.fitSteps}). */
  *fitSteps(matrix: Row[]): Generator<number, void, void> {
    const valid = matrix.filter((r) => Array.from(r).every((x) => !Number.isNaN(x)));
    if (valid.length < 2) throw new Error("Need at least 2 valid instances to fit GMM");
    // At most one component per 10 rows, as sleap.qc does.
    this.nComponentsUsed = Math.max(1, Math.min(this.nComponents, Math.floor(valid.length / 10)));
    this.scaler = standardScalerFit(valid);
    const scaled = scalerTransform(valid, this.scaler);
    const gmm = new GaussianMixture({ nComponents: this.nComponentsUsed });
    yield* gmm.fitSteps(scaled);
    this.gmm = gmm;
    this.setTrainingLogLikelihoods(gmm.scoreSamples(scaled));
  }

  /** Set the training log-likelihoods the percentile score ranks against. */
  setTrainingLogLikelihoods(trainLL: number[]): void {
    this.trainLL = trainLL;
    this.rank = new LikelihoodRank(trainLL);
  }

  /** Raw log p(x) under the fitted mixture (higher = more typical); -Infinity for NaN input. */
  logLikelihoodOne(vector: Row): number {
    if (!this.gmm || !this.scaler) return -Infinity;
    if (Array.from(vector).some((x) => Number.isNaN(x))) return -Infinity;
    return this.gmm.scoreSamples([scaleRow(vector, this.scaler)])[0];
  }

  /** 0–1 anomaly score: share of training poses more typical than this one; NaN for NaN input. */
  scoreOne(vector: Row): number {
    if (Array.from(vector).some((x) => Number.isNaN(x))) return Number.NaN;
    return this.rank.score(this.logLikelihoodOne(vector));
  }

  /** Percentile score for an already-computed log-likelihood. */
  percentileScore(ll: number): number {
    return this.rank.score(ll);
  }

  /**
   * Which feature makes this vector improbable. Under the most responsible
   * component, the squared Mahalanobis distance splits exactly per feature,
   * dᵀ Σ⁻¹ d = Σⱼ dⱼ · (Σ⁻¹ d)ⱼ, so the largest term is the feature the GMM finds
   * most off, accounting for learned feature correlations (unlike a plain z).
   */
  worstFeature(vector: Row): WorstFeature {
    const none: WorstFeature = { index: -1, contributions: [], component: -1 };
    if (!this.gmm || !this.scaler) return none;
    const xs = scaleRow(vector, this.scaler);
    if (xs.some((v) => Number.isNaN(v))) return none;
    const g = this.gmm;
    const n = g.d;
    const comp = g.componentLogProbs(xs);
    let kBest = 0;
    for (let k = 1; k < g.K; k++) if (comp[k] > comp[kBest]) kBest = k;
    const mean = g.means[kBest];
    const L = g.chol[kBest];
    const d = new Float64Array(n);
    for (let j = 0; j < n; j++) d[j] = xs[j] - mean[j];
    const prec = backSolveT(L, forwardSolve(L, d, n), n); // Σ⁻¹ d
    const contributions = new Array<number>(n);
    let index = -1;
    let best = -Infinity;
    for (let j = 0; j < n; j++) {
      const c = d[j] * prec[j];
      contributions[j] = c;
      if (c > best) {
        best = c;
        index = j;
      }
    }
    return { index, contributions, component: kBest };
  }
}

// ---- helpers ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sqDist(a: Row, b: Row): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const dd = a[i] - b[i];
    s += dd * dd;
  }
  return s;
}

function argminDist(x: Row, centers: Row[]): number {
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k < centers.length; k++) {
    const d = sqDist(x, centers[k]);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/** Lloyd's k-means from the given centers; returns each row's cluster label. */
function kmeans(X: Row[], init: number[][], maxIter = 300): number[] {
  const K = init.length;
  const d = X[0].length;
  let centers = init.map((c) => Float64Array.from(c));
  let labels = X.map((x) => argminDist(x, centers));
  for (let iter = 0; iter < maxIter; iter++) {
    const sums = Array.from({ length: K }, () => new Float64Array(d));
    const counts = new Array<number>(K).fill(0);
    X.forEach((x, i) => {
      const k = labels[i];
      counts[k]++;
      for (let j = 0; j < d; j++) sums[k][j] += x[j];
    });
    // An emptied cluster keeps its old center.
    centers = sums.map((s, k) => (counts[k] ? s.map((v) => v / counts[k]) : centers[k]));
    const next = X.map((x) => argminDist(x, centers));
    if (next.every((l, i) => l === labels[i])) break;
    labels = next;
  }
  return labels;
}

function kmeanspp(X: Row[], K: number, rng: () => number): number[][] {
  const centers = [Array.from(X[Math.floor(rng() * X.length)])];
  while (centers.length < K) {
    const d2 = X.map((x) => {
      let m = Infinity;
      for (const c of centers) m = Math.min(m, sqDist(x, c));
      return m;
    });
    const total = d2.reduce((s, v) => s + v, 0) || 1;
    let r = rng() * total;
    let idx = 0;
    for (; idx < X.length; idx++) {
      r -= d2[idx];
      if (r <= 0) break;
    }
    centers.push(Array.from(X[Math.min(idx, X.length - 1)]));
  }
  return centers;
}

const oneHot = (labels: number[], K: number): number[][] =>
  labels.map((l) => {
    const r = new Array<number>(K).fill(0);
    r[l] = 1;
    return r;
  });

const identity = (d: number, diag: number): Matrix =>
  Array.from({ length: d }, (_, i) => {
    const row = new Float64Array(d);
    row[i] = diag;
    return row;
  });
