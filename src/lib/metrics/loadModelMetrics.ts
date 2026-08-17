/**
 * Load + normalize sleap-nn evaluation metrics for a trained-model run dir.
 *
 * sleap-nn writes `metrics.{split}.{idx}.npz` during `train`, and (via a
 * companion sleap-nn change) a JSON sibling `metrics.{split}.{idx}.json` that
 * JS can read. This module resolves that JSON with the same precedence as
 * sleap-nn `_find_metrics_file` (try the requested split, then fall back
 * test → val → train; idx 0), parses it, and normalizes it into the app's
 * `ModelMetrics` / `MetricsSummary` / `ModelMetricsRow` shapes. It also parses
 * the sibling `training_config.yaml` for the model-type / architecture / run
 * name / node names / timestamp shown in the table.
 *
 * File access is injectable (`MetricsFsAccess`) so this is unit-testable
 * against a fixture directory without the Tauri runtime. The default reader
 * lazily imports `@tauri-apps/plugin-fs`; in the browser it throws and callers
 * surface a graceful "desktop only" error (training/metrics are desktop-only).
 */

import yaml from "js-yaml";
import type {
  DistanceMetrics,
  MetricsMode,
  MetricsSummary,
  ModelMetrics,
  ModelMetricsRow,
  PckMetrics,
  TrainingConfigInfo,
  VisibilityMetrics,
  VocMetrics,
} from "./types";

// ── File access ──────────────────────────────────────────────────────────────

/** Minimal filesystem surface this loader needs (injectable for tests). */
export interface MetricsFsAccess {
  readTextFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** Default reader backed by the Tauri fs plugin (desktop-only at runtime). */
function defaultFs(): MetricsFsAccess {
  return {
    async readTextFile(path: string): Promise<string> {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      return readTextFile(path);
    },
    async exists(path: string): Promise<boolean> {
      const { exists } = await import("@tauri-apps/plugin-fs");
      return exists(path);
    },
  };
}

/** Join a directory and a filename using the directory's path separator. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${name}`;
}

// ── Scalar coercion ──────────────────────────────────────────────────────────

/** Coerce a JSON value to a finite number, or `null` (covers NaN/Infinity/null). */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce to a plain number for counts (defaults to 0 when absent/NaN). */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ── Metrics normalization ────────────────────────────────────────────────────

const METRIC_SECTIONS = [
  "voc_metrics",
  "mOKS",
  "distance_metrics",
  "pck_metrics",
  "visibility_metrics",
] as const;

/** True when `raw` looks like a sleap-nn metrics dict (has ≥1 known section). */
export function looksLikeMetrics(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  return (
    METRIC_SECTIONS.some((k) => k in obj) ||
    "detection_metrics" in obj ||
    "mask_metrics" in obj ||
    "semantic_metrics" in obj
  );
}

function normalizeDistance(raw: Record<string, unknown> | undefined): DistanceMetrics | undefined {
  if (!raw) return undefined;
  const rawDists = Array.isArray(raw.dists) ? (raw.dists as unknown[]) : [];
  const dists: (number | null)[][] = rawDists.map((row) =>
    Array.isArray(row) ? row.map((v) => num(v)) : [],
  );
  const frameIdxs = Array.isArray(raw.frame_idxs)
    ? (raw.frame_idxs as unknown[]).map((v) => count(v))
    : [];
  const videoPaths = Array.isArray(raw.video_paths)
    ? (raw.video_paths as unknown[]).map((v) => String(v))
    : [];
  return {
    avg: num(raw.avg),
    p50: num(raw.p50),
    p75: num(raw.p75),
    p90: num(raw.p90),
    p95: num(raw.p95),
    p99: num(raw.p99),
    dists,
    frame_idxs: frameIdxs,
    video_paths: videoPaths,
  };
}

function normalizeVisibility(raw: Record<string, unknown> | undefined): VisibilityMetrics | undefined {
  if (!raw) return undefined;
  return {
    tp: count(raw.tp),
    fp: count(raw.fp),
    tn: count(raw.tn),
    fn: count(raw.fn),
    precision: num(raw.precision),
    recall: num(raw.recall),
  };
}

function normalizePck(raw: Record<string, unknown> | undefined): PckMetrics | undefined {
  if (!raw) return undefined;
  return {
    mPCK: num(raw.mPCK),
    "PCK@5": num(raw["PCK@5"]),
    "PCK@10": num(raw["PCK@10"]),
  };
}

function normalizeMOKS(raw: unknown): number | null {
  if (raw && typeof raw === "object" && "mOKS" in (raw as Record<string, unknown>)) {
    return num((raw as Record<string, unknown>).mOKS);
  }
  return num(raw);
}

/**
 * Normalize a parsed metrics JSON object into `ModelMetrics`. Tolerates missing
 * sections and non-keypoint modes; `raw` is preserved for the detailed view.
 */
export function normalizeMetrics(raw: unknown, split = "val"): ModelMetrics {
  const obj: Record<string, unknown> =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const vocRaw = obj.voc_metrics as Record<string, unknown> | undefined;
  const distRaw = obj.distance_metrics as Record<string, unknown> | undefined;

  const mode: MetricsMode = vocRaw
    ? "oks"
    : obj.mask_metrics
      ? "mask"
      : obj.semantic_metrics
        ? "semantic"
        : distRaw
          ? "centroid"
          : "unknown";

  return {
    mode,
    split,
    voc: vocRaw ? (vocRaw as VocMetrics) : undefined,
    mOKS: "mOKS" in obj ? normalizeMOKS(obj.mOKS) : undefined,
    distance: normalizeDistance(distRaw),
    pck: normalizePck(obj.pck_metrics as Record<string, unknown> | undefined),
    visibility: normalizeVisibility(obj.visibility_metrics as Record<string, unknown> | undefined),
    raw: obj,
  };
}

/** Project the headline scalars of `ModelMetrics` into a flat table row. */
export function summarizeMetrics(m: ModelMetrics | null): MetricsSummary | null {
  if (!m) return null;
  const voc = m.voc;
  const dist = m.distance;
  const pck = m.pck;
  const vis = m.visibility;
  return {
    oksMAP: num(voc?.["oks_voc.mAP"]),
    oksMAR: num(voc?.["oks_voc.mAR"]),
    pckMAP: num(voc?.["pck_voc.mAP"]),
    mOKS: m.mOKS ?? null,
    mPCK: num(pck?.mPCK),
    pck5: num(pck?.["PCK@5"]),
    pck10: num(pck?.["PCK@10"]),
    visPrecision: num(vis?.precision),
    visRecall: num(vis?.recall),
    distAvg: num(dist?.avg),
    distP50: num(dist?.p50),
    distP75: num(dist?.p75),
    distP90: num(dist?.p90),
    distP95: num(dist?.p95),
    distP99: num(dist?.p99),
  };
}

// ── Training-config parsing ──────────────────────────────────────────────────

const MODEL_TYPE_LABELS: Record<string, string> = {
  single_instance: "Single Instance",
  centroid: "Centroid",
  centered_instance: "Centered Instance",
  bottomup: "Bottom-Up",
  multi_class_bottomup: "Multi-Class Bottom-Up",
  multi_class_topdown: "Multi-Class Top-Down",
};

const BACKBONE_LABELS: Record<string, string> = {
  unet: "UNet",
  convnext: "ConvNeXt",
  swint: "Swin-T",
};

function titleCase(key: string): string {
  return key
    .split(/[_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Parse a `YYYYMMDD[_-]?HHMMSS?` timestamp out of a run name, if present. */
export function parseTimestampFromRunName(runName: string | null | undefined): string | null {
  if (!runName) return null;
  const m = runName.match(/(\d{4})(\d{2})(\d{2})[_-]?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  const day = `${y}-${mo}-${d}`;
  if (hh && mm) return `${day} ${hh}:${mm}${ss ? `:${ss}` : ""}`;
  return day;
}

/**
 * Parse the sleap-nn `training_config.yaml` for the fields the table shows:
 * run name, model type (active head), backbone architecture, node names, and a
 * best-effort timestamp derived from the run name.
 */
export function parseTrainingConfig(yamlText: string): TrainingConfigInfo {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === "object") doc = parsed as Record<string, unknown>;
  } catch {
    return { runName: null, headKey: null, modelType: null, architecture: null, nodeNames: null, timestamp: null };
  }

  const modelConfig = (doc.model_config ?? {}) as Record<string, unknown>;
  const trainerConfig = (doc.trainer_config ?? doc.trainer ?? {}) as Record<string, unknown>;
  const dataConfig = (doc.data_config ?? {}) as Record<string, unknown>;

  // Model type = the single non-null head in head_configs.
  const headConfigs = (modelConfig.head_configs ?? {}) as Record<string, unknown>;
  const headKey = Object.entries(headConfigs).find(([, v]) => v != null)?.[0] ?? null;
  const modelType = headKey ? (MODEL_TYPE_LABELS[headKey] ?? titleCase(headKey)) : null;

  // Architecture = active backbone + its max_stride / filters.
  const backboneConfig = (modelConfig.backbone_config ?? {}) as Record<string, unknown>;
  const backboneEntry = Object.entries(backboneConfig).find(([, v]) => v != null);
  let architecture: string | null = null;
  if (backboneEntry) {
    const [bbKey, bbVal] = backboneEntry;
    architecture = BACKBONE_LABELS[bbKey] ?? titleCase(bbKey);
    if (bbVal && typeof bbVal === "object") {
      const bb = bbVal as Record<string, unknown>;
      if (typeof bb.max_stride === "number") architecture += `, max stride: ${bb.max_stride}`;
      if (typeof bb.filters === "number") architecture += `, filters: ${bb.filters}`;
    }
  }

  // Node names from the first skeleton.
  let nodeNames: string[] | null = null;
  const skeletons = dataConfig.skeletons;
  if (Array.isArray(skeletons) && skeletons.length > 0) {
    const nodes = (skeletons[0] as Record<string, unknown>)?.nodes;
    if (Array.isArray(nodes)) {
      const names = nodes
        .map((n) => (n && typeof n === "object" ? (n as Record<string, unknown>).name : n))
        .filter((n): n is string => typeof n === "string");
      if (names.length > 0) nodeNames = names;
    }
  }

  const runName = typeof trainerConfig.run_name === "string" ? trainerConfig.run_name : null;

  return {
    runName,
    headKey,
    modelType,
    architecture,
    nodeNames,
    timestamp: parseTimestampFromRunName(runName),
  };
}

// ── Directory-level loading ──────────────────────────────────────────────────

/** Canonical split fallback order (mirrors sleap-nn test → val → train). */
const SPLIT_ORDER = ["test", "val", "train"] as const;

export interface LoadMetricsOptions {
  /** Preferred split to try first (default "test"). */
  split?: string;
  /** Dataset index (default 0). */
  datasetIdx?: number;
  /** Injectable filesystem access (defaults to the Tauri fs plugin). */
  fs?: MetricsFsAccess;
}

export interface LoadedModelMetrics {
  metrics: ModelMetrics | null;
  config: TrainingConfigInfo | null;
  /** Which split file was actually loaded, or null when none found. */
  splitLoaded: string | null;
}

/**
 * Resolve `metrics.{split}.{idx}.json` in `runDir`, trying the preferred split
 * first and then falling back through test → val → train.
 */
export async function resolveMetricsFile(
  runDir: string,
  fs: MetricsFsAccess,
  preferredSplit = "test",
  datasetIdx = 0,
): Promise<{ path: string; split: string } | null> {
  const order: string[] = [preferredSplit, ...SPLIT_ORDER.filter((s) => s !== preferredSplit)];
  for (const split of order) {
    const path = joinPath(runDir, `metrics.${split}.${datasetIdx}.json`);
    if (await fs.exists(path)) return { path, split };
  }
  return null;
}

/**
 * Load + normalize metrics and training-config info for one run directory.
 * Returns nulls for whichever artifact is missing rather than throwing (a
 * missing metrics JSON is expected until sleap-nn emits it).
 */
export async function loadModelMetrics(
  runDir: string,
  opts: LoadMetricsOptions = {},
): Promise<LoadedModelMetrics> {
  const fs = opts.fs ?? defaultFs();
  const preferredSplit = opts.split ?? "test";
  const datasetIdx = opts.datasetIdx ?? 0;

  let metrics: ModelMetrics | null = null;
  let splitLoaded: string | null = null;
  const found = await resolveMetricsFile(runDir, fs, preferredSplit, datasetIdx);
  if (found) {
    const text = await fs.readTextFile(found.path);
    metrics = normalizeMetrics(JSON.parse(text), found.split);
    splitLoaded = found.split;
  }

  let config: TrainingConfigInfo | null = null;
  const cfgPath = joinPath(runDir, "training_config.yaml");
  if (await fs.exists(cfgPath)) {
    config = parseTrainingConfig(await fs.readTextFile(cfgPath));
  }

  return { metrics, config, splitLoaded };
}

/** Basename of a run dir, for the table's Path column. */
export function runDirName(runDir: string): string {
  return runDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? runDir;
}

/**
 * Build a full table row for a run directory: load metrics + config, then merge
 * into a `ModelMetricsRow`. Loading failures (e.g. browser runtime, no fs) are
 * captured as `row.error` instead of thrown, so the table degrades gracefully.
 */
export async function buildModelMetricsRow(
  runDir: string,
  opts: LoadMetricsOptions = {},
): Promise<ModelMetricsRow> {
  try {
    const { metrics, config } = await loadModelMetrics(runDir, opts);
    return {
      path: runDir,
      runName: config?.runName ?? runDirName(runDir),
      timestamp: config?.timestamp ?? null,
      modelType: config?.modelType ?? null,
      architecture: config?.architecture ?? null,
      nodeNames: config?.nodeNames ?? null,
      metrics,
      summary: summarizeMetrics(metrics),
    };
  } catch (err) {
    return {
      path: runDir,
      runName: runDirName(runDir),
      timestamp: null,
      modelType: null,
      architecture: null,
      nodeNames: null,
      metrics: null,
      summary: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
