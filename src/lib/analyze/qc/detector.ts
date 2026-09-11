/**
 * The QC anomaly detector: assembles the 18-dim per-instance geometric feature
 * vector and scores it (Phase 1 = the ZScore anomaly path).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/detector.js`, itself a port of `sleap/qc/detector.py`), a
 * lab JS port of Python `sleap.qc` intended for integration into sleap-app.
 *
 * Phase 1 ports the ZScore anomaly path: {@link ZScoreDetector},
 * {@link cleanFeatureRow}, and {@link LabelQCDetector}'s feature assembly
 * (`fitFeatures`/`extractFeatures`/`scoreInstance`/`attributeCurvature`). The
 * GMM branch, frame-level checks (instance count / negative / duplicates),
 * chirality, chain-ordering, pose-split, and the io-coupled orchestrators
 * (`fitAndScoreLabels`/`buildContext`/units) are Phase 2. The profiling
 * instrumentation in the original `fitFeatures` is omitted (non-behavioral).
 */
import { mean, std, visibilityMask, type Pose } from "./util";
import { makeQCConfig, shouldUseCurvature, type QcConfig } from "./config";
import {
  BaselineFeatureExtractor,
  BASELINE_FEATURE_NAMES,
  type AttributionEntry,
} from "./baseline";
import { computeCurvature, computeConvexHull, worstCurvatureVertex } from "./structural";
import { VisibilityModel } from "./visibility";
import { NearestNeighborScorer } from "./reference";
import { SkeletonAnalyzer } from "./skeleton";

/** The 6 V3 feature names, appended after the 12 baseline features. */
export const V3_FEATURE_NAMES = [
  "max_curvature",
  "curvature_std",
  "visibility_pattern_score",
  "nn_distance",
  "hull_area_zscore",
  "hull_compactness",
] as const;

/** Per-instance anomaly score + raw feature contributions. */
export interface InstanceScore {
  score: number;
  contributions: Record<string, number>;
}

/** Fallback detector: max |z| across features -> sigmoid around a threshold. */
export class ZScoreDetector {
  threshold: number;
  means: number[] | null;
  stds: number[] | null;

  constructor(threshold = 3.0) {
    this.threshold = threshold;
    this.means = null;
    this.stds = null;
  }

  fit(matrix: number[][]): this {
    const valid = matrix.filter((row) => row.every((x) => !Number.isNaN(x)));
    const nf = matrix[0]?.length ?? 0;
    this.means = Array.from({ length: nf }, (_, j) => mean(valid.map((r) => r[j])));
    this.stds = Array.from({ length: nf }, (_, j) =>
      Math.max(std(valid.map((r) => r[j])), 1e-6),
    );
    return this;
  }

  scoreOne(vector: number[]): number {
    if (vector.some((x) => Number.isNaN(x))) return Number.NaN;
    const means = this.means as number[],
      stds = this.stds as number[];
    let maxZ = 0;
    for (let j = 0; j < vector.length; j++) {
      const z = Math.abs((vector[j] - means[j]) / stds[j]);
      if (z > maxZ) maxZ = z;
    }
    return 1 / (1 + Math.exp(-(maxZ - this.threshold))); // sigmoid
  }
}

/**
 * Replace the values a fitted model cannot consume. The detectors were FIT on
 * this exact substitution, so scoring must apply the identical one or a re-score
 * drifts from the fit.
 */
export const cleanFeatureRow = (row: number[]): number[] =>
  row.map((f) =>
    Number.isNaN(f) ? 0 : f === Infinity ? 10 : f === -Infinity ? -10 : f,
  );

export class LabelQCDetector {
  config: QcConfig;
  usedGmm: boolean;
  analyzer!: SkeletonAnalyzer;
  baseline!: BaselineFeatureExtractor;
  visibility!: VisibilityModel;
  nn!: NearestNeighborScorer;
  featureNames!: string[];
  rawMatrix!: number[][];
  cleanMatrix!: number[][];
  fitRows!: number[];
  detector: ZScoreDetector | null;
  private _hullStats!: { mean: number; std: number };
  /** node->neighbors adjacency; reused by the Phase-2 pose_split feature. */
  private _adjacency!: number[][];

  constructor(config: QcConfig = makeQCConfig()) {
    this.config = config;
    this.usedGmm = false;
    this.detector = null;
  }

  /**
   * Phase-1 fit: build the feature matrix, then fit the ZScore detector on the
   * reference (fit) subset. (Phase 2 adds the GMM branch + frame-level count
   * checker that the original `fit()` also wired up.)
   */
  fit({
    instances,
    analyzer,
    fitMask = null,
  }: {
    instances: Pose[];
    analyzer: SkeletonAnalyzer;
    fitMask?: boolean[] | null;
  }): this {
    this.fitFeatures(instances, analyzer, fitMask);
    this.detector = new ZScoreDetector(3.0).fit(this.fitRawMatrix);
    this.usedGmm = false;
    return this;
  }

  /**
   * Fit the feature extractors + build the per-instance feature matrix (raw +
   * cleaned). `fitMask` (per-instance, aligned with `instances`) selects the
   * "normal" REFERENCE subset — the baseline stats / NN reference are fit on it,
   * but the matrix (for scoring) is built over ALL `instances`. `null` => all.
   */
  fitFeatures(
    instances: Pose[],
    analyzer: SkeletonAnalyzer,
    fitMask: boolean[] | null = null,
  ): this {
    this.analyzer = analyzer;
    const fitPoses = fitMask ? instances.filter((_, i) => fitMask[i]) : instances;
    this.baseline = new BaselineFeatureExtractor(
      analyzer.edges,
      analyzer.nNodes,
      analyzer.symmetryPairs,
    ).fit(fitPoses);
    this.visibility = new VisibilityModel().fit(fitPoses.map(visibilityMask));
    this.nn = new NearestNeighborScorer({ normalize: true }).fit(fitPoses);
    const looNN = this.nn.looDistances(); // aligned with fitPoses
    const areas = fitPoses
      .map((p) => computeConvexHull(p).hullArea)
      .filter((a) => a > 0);
    this._hullStats = {
      mean: areas.length ? mean(areas) : 1,
      std: areas.length ? std(areas) : 1,
    };
    // node->neighbors adjacency, reused by the pose_split feature (Phase 2).
    this._adjacency = Array.from({ length: analyzer.nNodes }, () => []);
    for (const [s, d] of analyzer.edges) {
      this._adjacency[s].push(d);
      this._adjacency[d].push(s);
    }
    this.featureNames = [...BASELINE_FEATURE_NAMES, ...V3_FEATURE_NAMES];
    // Matrix over ALL instances; a fit row reuses its LOO NN distance (avoids
    // self-match), a non-fit row gets the full NN to the fit set.
    const fitIdxByAll = new Map<number, number>();
    let fi = 0;
    instances.forEach((_, i) => {
      if (!fitMask || fitMask[i]) fitIdxByAll.set(i, fi++);
    });
    this.rawMatrix = instances.map((p, i) =>
      this.extractFeatures(
        p,
        !fitMask || fitMask[i] ? looNN[fitIdxByAll.get(i) as number] : null,
      ),
    );
    this.cleanMatrix = this.rawMatrix.map((row) => cleanFeatureRow(row));
    this.fitRows = [...fitIdxByAll.keys()];
    return this;
  }

  get fitRawMatrix(): number[][] {
    return this.fitRows.map((r) => this.rawMatrix[r]);
  }

  /** 18-dim geometric feature vector for one pose. */
  extractFeatures(pose: Pose, nnDistance: number | null = null): number[] {
    const baseline = this.baseline.extract(pose);
    const v3: number[] = [];

    if (shouldUseCurvature(this.config, this.analyzer.maxChainLength)) {
      const chains = this.analyzer.getCurvatureChains();
      if (chains.length) {
        const c = computeCurvature(pose, chains[0]);
        v3.push(c.maxCurvature, c.curvatureStd);
      } else v3.push(0, 0);
    } else v3.push(0, 0);

    v3.push(this.visibility.score(visibilityMask(pose)).patternScore);
    v3.push(nnDistance != null ? nnDistance : this.nn.score(pose).nnDistance);

    const hull = computeConvexHull(pose);
    v3.push(
      (hull.hullArea - this._hullStats.mean) / Math.max(this._hullStats.std, 1e-6),
      hull.compactness,
    );

    return [...baseline, ...v3];
  }

  /**
   * Culprit for `max_curvature` — the chain vertex whose bend drives the
   * feature. Lives here rather than on the baseline extractor because curvature
   * is a V3 feature and needs the skeleton's chains, which only the analyzer has.
   */
  attributeCurvature(pose: Pose): AttributionEntry | null {
    if (!shouldUseCurvature(this.config, this.analyzer?.maxChainLength ?? 0))
      return null;
    const chains = this.analyzer?.getCurvatureChains?.() ?? [];
    if (!chains.length) return null;
    const w = worstCurvatureVertex(pose, chains[0]); // extractFeatures scores chains[0] only
    return w
      ? { kind: "angle", nodes: w.nodes, dir: Math.sign(w.curvature) }
      : null;
  }

  /** Anomaly score (0..1) + raw feature contributions for a pose. */
  scoreInstance(pose: Pose): InstanceScore {
    if (!this.detector)
      throw new Error("Must call fit() before scoreInstance()");
    const features = this.extractFeatures(pose);
    const clean = cleanFeatureRow(features);
    const score = this.detector.scoreOne(clean);
    const contributions: Record<string, number> = {};
    this.featureNames.forEach((n, i) => (contributions[n] = features[i] ?? 0));
    return { score: Number.isFinite(score) ? score : 0, contributions };
  }
}
