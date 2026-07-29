/**
 * Pure, array-only numerical core for the image-features suggestion pipeline.
 *
 * Runs inside the Vite `?worker` (imageFeatures.worker.ts) but is defined here,
 * decoupled from the Worker runtime, so it can be unit-tested directly (bun
 * cannot host a Web Worker). Mirrors the statisticSeriesWorkerCore pattern.
 *
 * The orchestrator (imageFeatures.ts) decodes + crops + downscales each frame on
 * the main thread (canvas), then transfers the small RGBA buffers here. This
 * module does the heavy math: grayscale auto-detect → flatten → Gram-trick PCA →
 * seeded k-means++ → per-cluster frame pick. All inputs are structured-clone
 * safe (typed arrays + plain numbers) — no sleap-io.js objects.
 */
import { Matrix, EigenvalueDecomposition } from "ml-matrix";
import { mulberry32 } from "./seededRng";

/** A decoded, already cropped+downscaled frame: RGBA pixels + its frame index. */
export interface WorkerFrameBuffer {
  /** 0-based frame index in the source video. */
  frameIdx: number;
  width: number;
  height: number;
  /** RGBA, length `width * height * 4`. */
  data: Uint8ClampedArray;
}

/**
 * Whether EVERY pixel of EVERY frame is achromatic (R=G=B). Early-exits on the
 * first chromatic pixel, so color videos return almost immediately; a true
 * grayscale video scans each small buffer once. Mirrors SLEAP's behaviour of
 * inheriting the source's channel count (grayscale sources → 1 channel).
 */
export function detectGrayscale(frames: WorkerFrameBuffer[]): boolean {
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) return false;
    }
  }
  return true;
}

/**
 * Flatten one frame's RGBA buffer to a feature vector, dropping alpha. When
 * `grayscale`, collapse to one channel (the R value — exact, since detection
 * guarantees R=G=B); otherwise keep R,G,B interleaved, row-major. The result
 * length is `width*height` (grayscale) or `width*height*3`.
 */
export function flattenFrame(
  frame: WorkerFrameBuffer,
  grayscale: boolean
): number[] {
  const d = frame.data;
  const nPx = frame.width * frame.height;
  const out = new Array<number>(grayscale ? nPx : nPx * 3);
  let o = 0;
  for (let i = 0; i < d.length; i += 4) {
    out[o++] = d[i];
    if (!grayscale) {
      out[o++] = d[i + 1];
      out[o++] = d[i + 2];
    }
  }
  return out;
}

/**
 * Dual ("Gram-trick") PCA. Returns the top-`nComponents` principal-component
 * SCORES (projected coordinates) for the `n_samples × n_features` data `X`.
 *
 * Raw flattened frames have huge feature counts (e.g. 128²·3 ≈ 49k) but few
 * samples (~200), so forming the `n_features²` covariance matrix would OOM.
 * Instead we eigendecompose the tiny `n_samples × n_samples` Gram matrix
 * `G = Xc·Xcᵀ` of the CENTERED data: if `Xc = U S Vᵀ` then `G = U S² Uᵀ`, so the
 * eigenvectors of `G` are `U` and the eigenvalues are `S²`. The PCA scores are
 * `T = Xc·V = U·S`, i.e. each eigenvector column scaled by `sqrt(eigenvalue)`.
 *
 * Eigenvector sign is arbitrary, so score columns may be sign-flipped versus
 * sklearn/SVD — irrelevant for k-means (a per-axis reflection preserves
 * Euclidean distance). Components beyond the data's rank come back ~0.
 */
export function gramPCA(X: number[][], nComponents: number): number[][] {
  const n = X.length;
  if (n === 0) return [];

  const M = new Matrix(X);
  // Center each feature (column) across samples.
  const means = M.mean("column");
  const Xc = M.clone().subRowVector(means);
  // Gram matrix G = Xc · Xcᵀ  (n × n, symmetric PSD).
  const G = Xc.mmul(Xc.transpose());

  const evd = new EigenvalueDecomposition(G, { assumeSymmetric: true });
  const eigVals = evd.realEigenvalues;
  const eigVecs = evd.eigenvectorMatrix;

  // Order eigenpairs by descending eigenvalue and take the top-k.
  const order = eigVals.map((_, i) => i).sort((a, b) => eigVals[b] - eigVals[a]);
  const k = Math.min(nComponents, n);

  const scores: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(k);
    for (let j = 0; j < k; j++) {
      const idx = order[j];
      // Clamp tiny negative eigenvalues (numerical noise) to 0.
      const lambda = Math.max(0, eigVals[idx]);
      row[j] = eigVecs.get(i, idx) * Math.sqrt(lambda);
    }
    scores.push(row);
  }
  return scores;
}

/** Squared Euclidean distance between two equal-length vectors. */
function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/**
 * Seeded k-means++ clustering. Returns a length-`n` array of cluster labels
 * (0..k-1). Hand-rolled (rather than a library) so the whole pipeline is
 * reproducible from a single seed: `rng` drives both the k-means++ seeding
 * (D²-weighted center selection) and is the only source of randomness, so a
 * given seed always yields the same clustering.
 *
 * `k` is clamped to the sample count; `k <= 1` (or a single sample) trivially
 * assigns everything to cluster 0.
 */
export function kmeansPlusPlus(
  points: number[][],
  k: number,
  rng: () => number,
  maxIter = 50
): number[] {
  const n = points.length;
  if (n === 0) return [];
  const kk = Math.min(k, n);
  if (kk <= 1) return new Array<number>(n).fill(0);

  // --- k-means++ seeding: first center uniform, rest ∝ D² to nearest center.
  const centers: number[][] = [];
  const first = Math.min(n - 1, Math.floor(rng() * n));
  centers.push(points[first].slice());
  const dist2 = points.map((p) => sqDist(p, centers[0]));
  for (let c = 1; c < kk; c++) {
    let total = 0;
    for (const d of dist2) total += d;
    let idx: number;
    if (total <= 0) {
      // All points coincide with existing centers; pick any.
      idx = Math.min(n - 1, Math.floor(rng() * n));
    } else {
      let target = rng() * total;
      idx = n - 1;
      for (let i = 0; i < n; i++) {
        target -= dist2[i];
        if (target <= 0) {
          idx = i;
          break;
        }
      }
    }
    centers.push(points[idx].slice());
    for (let i = 0; i < n; i++) {
      const d = sqDist(points[i], centers[c]);
      if (d < dist2[i]) dist2[i] = d;
    }
  }

  // --- Lloyd iterations to convergence (or maxIter).
  const dims = points[0].length;
  const assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = sqDist(points[i], centers[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed) break;

    const sums = centers.map(() => new Array<number>(dims).fill(0));
    const counts = new Array<number>(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      const p = points[i];
      for (let d = 0; d < dims; d++) sums[c][d] += p[d];
    }
    for (let c = 0; c < kk; c++) {
      if (counts[c] === 0) continue; // keep the old center for an empty cluster
      for (let d = 0; d < dims; d++) centers[c][d] = sums[c][d] / counts[c];
    }
  }
  return assign;
}

/**
 * Pick up to `perCluster` sample indices from each of the `k` clusters, chosen
 * uniformly at random (seeded `rng`, partial Fisher-Yates). Returns the flat
 * list of selected SAMPLE indices; a sample belongs to exactly one cluster, so
 * the picks are automatically unique across clusters. The caller maps each
 * index back to its frame index and looks up its cluster group via
 * `assignments[index]`.
 */
export function pickPerCluster(
  assignments: number[],
  k: number,
  perCluster: number,
  rng: () => number
): number[] {
  const groups: number[][] = Array.from({ length: k }, () => []);
  assignments.forEach((c, i) => {
    if (c >= 0 && c < k) groups[c].push(i);
  });

  const picked: number[] = [];
  for (let c = 0; c < k; c++) {
    const pool = groups[c].slice();
    const take = Math.min(perCluster, pool.length);
    for (let i = 0; i < take; i++) {
      const j = i + Math.min(Math.floor(rng() * (pool.length - i)), pool.length - i - 1);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      picked.push(pool[i]);
    }
  }
  return picked;
}

/** A single selected suggestion: source frame index + its k-means cluster group. */
export interface ImageFeaturesPick {
  frameIdx: number;
  group: number;
}

/**
 * A structured-clone-safe clustering job: the already cropped+downscaled RGBA
 * frame buffers plus the (already validated) numeric parameters. The seed makes
 * the whole clustering reproducible.
 */
export interface ImageFeaturesJob {
  frames: WorkerFrameBuffer[];
  pcaComponents: number;
  nClusters: number;
  perCluster: number;
  seed: number;
}

export interface ImageFeaturesResult {
  picks: ImageFeaturesPick[];
}

/**
 * The full worker job: grayscale auto-detect → flatten → Gram-PCA → seeded
 * k-means++ → per-cluster frame pick. Returns the selected frames tagged with
 * their local (0-based) cluster group.
 *
 * `pcaComponents`/`nClusters` are clamped to what the sample count and feature
 * count support, so short videos never crash the linear algebra: e.g. a
 * single-frame job returns that one frame (group 0), and a 3-frame job with
 * `nClusters=5` yields 3 singleton clusters (all three frames). A single
 * `mulberry32(seed)` stream drives k-means++ then the per-cluster pick.
 */
export function runImageFeaturesJob(job: ImageFeaturesJob): ImageFeaturesResult {
  const { frames, pcaComponents, nClusters, perCluster, seed } = job;
  const n = frames.length;
  if (n === 0) return { picks: [] };

  const rng = mulberry32(seed);

  const grayscale = detectGrayscale(frames);
  const X = frames.map((f) => flattenFrame(f, grayscale));
  const nFeatures = X[0]?.length ?? 0;

  const effComponents = Math.max(1, Math.min(pcaComponents, n, nFeatures));
  const effClusters = Math.max(1, Math.min(nClusters, n));

  const scores = gramPCA(X, effComponents);
  const assignments = kmeansPlusPlus(scores, effClusters, rng);
  const idxs = pickPerCluster(assignments, effClusters, perCluster, rng);

  const picks = idxs.map((i) => ({
    frameIdx: frames[i].frameIdx,
    group: assignments[i],
  }));
  return { picks };
}
