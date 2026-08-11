/**
 * Types for the model-evaluation metrics feature (parity with the classic
 * SLEAP "Metrics for Trained Models" table + detailed metrics dialog).
 *
 * sleap-nn writes a per-model, per-split metrics artifact during `train` at
 * `<run_dir>/metrics.{split}.{idx}.npz`. That npz is a Python-pickled object
 * array JS cannot read, so a JSON sibling `metrics.{split}.{idx}.json` is
 * emitted alongside it. These types model that JSON.
 *
 * The JSON mirrors sleap-nn `Evaluator.evaluate()` (see
 * sleap_nn/evaluation.py): a nested dict keyed by metric family. Keypoint
 * ("oks") mode reports voc_metrics / mOKS / distance_metrics / pck_metrics /
 * visibility_metrics. NaN values are serialized as `null` (JSON has no NaN),
 * and the `dists` matrix carries `null` for missing/unmatched nodes.
 */

/** Which sleap-nn match method produced these metrics. */
export type MetricsMode = "oks" | "centroid" | "mask" | "semantic" | "unknown";

/**
 * VOC (PASCAL-VOC-style average precision/recall) metrics. sleap-nn computes
 * these twice — once ranking matches by OKS (`oks_voc.*`) and once by PCK
 * (`pck_voc.*`) — and merges both into one flat dict. All fields optional
 * because a split with zero true positives collapses these to scalars/0.
 */
export interface VocMetrics {
  "oks_voc.mAP"?: number | null;
  "oks_voc.mAR"?: number | null;
  "oks_voc.AP"?: number[];
  "oks_voc.AR"?: number[];
  "oks_voc.precisions"?: number[][];
  "oks_voc.recalls"?: number[];
  "oks_voc.recall_thresholds"?: number[];
  "oks_voc.match_score_thresholds"?: number[];
  "pck_voc.mAP"?: number | null;
  "pck_voc.mAR"?: number | null;
  "pck_voc.AP"?: number[];
  "pck_voc.AR"?: number[];
  "pck_voc.precisions"?: number[][];
  "pck_voc.recalls"?: number[];
  "pck_voc.recall_thresholds"?: number[];
  "pck_voc.match_score_thresholds"?: number[];
}

/**
 * Euclidean localization-error metrics (ground truth vs prediction).
 * `dists` is an `n_pairs × n_nodes` matrix; `null` entries mark a node that was
 * missing in the GT or prediction of that matched pair (serialized NaN).
 */
export interface DistanceMetrics {
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  dists: (number | null)[][];
  frame_idxs: number[];
  video_paths: string[];
}

/** Percentage of Correct Keypoints metrics at common pixel thresholds. */
export interface PckMetrics {
  mPCK: number | null;
  "PCK@5": number | null;
  "PCK@10": number | null;
}

/** Node-visibility confusion matrix + precision/recall. */
export interface VisibilityMetrics {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

/**
 * Normalized, mode-tagged metrics for one trained model + split. Sub-sections
 * are optional so non-keypoint modes (centroid/mask/semantic) or partial
 * artifacts still load. `raw` preserves the parsed JSON so the detailed view
 * can surface keys we don't model explicitly.
 */
export interface ModelMetrics {
  mode: MetricsMode;
  /** Which split file was loaded (`test` | `val` | `train`). */
  split: string;
  voc?: VocMetrics;
  mOKS?: number | null;
  distance?: DistanceMetrics;
  pck?: PckMetrics;
  visibility?: VisibilityMetrics;
  raw: Record<string, unknown>;
}

/**
 * Flat, table-ready projection of the headline scalars. Every field is
 * nullable — a model may lack metrics entirely, or a split may collapse some
 * families to nothing.
 */
export interface MetricsSummary {
  oksMAP: number | null;
  oksMAR: number | null;
  pckMAP: number | null;
  mOKS: number | null;
  mPCK: number | null;
  pck5: number | null;
  pck10: number | null;
  visPrecision: number | null;
  visRecall: number | null;
  distAvg: number | null;
  distP50: number | null;
  distP75: number | null;
  distP90: number | null;
  distP95: number | null;
  distP99: number | null;
}

/**
 * Model description parsed from `training_config.yaml` (sleap-nn schema):
 * model type (active head), backbone architecture string, run name, node
 * names (for the per-node distance boxplot), and a best-effort timestamp.
 */
export interface TrainingConfigInfo {
  runName: string | null;
  modelType: string | null;
  architecture: string | null;
  nodeNames: string[] | null;
  /** ISO-ish timestamp string parsed from the run name, when present. */
  timestamp: string | null;
}

/**
 * One row of the metrics table: a run directory, its parsed config
 * description, and its loaded metrics (null when none were found / readable).
 */
export interface ModelMetricsRow {
  /** Absolute path to the model run directory. */
  path: string;
  runName: string | null;
  timestamp: string | null;
  modelType: string | null;
  architecture: string | null;
  nodeNames: string[] | null;
  metrics: ModelMetrics | null;
  summary: MetricsSummary | null;
  /** Non-null when loading failed (browser runtime, missing files, parse error). */
  error?: string;
}
