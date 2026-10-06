import { create } from "zustand";
import yaml from "js-yaml";
import { cancelCommand } from "@/platform/backend";
import { ZMQ_CONTROLLER_PORT, ZMQ_PUBLISH_PORT } from "@/platform/trainingArgs";
import { isTauri } from "@/platform";
import { computeRuntimeMetrics } from "@/lib/trainingMetrics";
import { lastErrorLine } from "@/lib/processLog";
import { formatRunTimestamp } from "@/lib/timestamp";
import { computeInstanceSizeStats, recommendMaxStride, detectVideoChannels, resolveInputChannels, formatBytes } from "@/lib/modelStats";
import { confirmDialog } from "@/stores/confirmStore";
import type { Labels } from "@/types";
import type { JobResult, TrainJobSpec } from "@/lib/sleapConnect";
import { buildRemoteTrackSpecs } from "@/lib/remoteTrackSpec";
import {
  LABELS_EMBED_WARN_BYTES,
  LABELS_EMBED_HARD_CAP_BYTES,
} from "@/lib/remoteLabelsPayload";
import type { VideoVisibility } from "@/lib/remoteVisibility";
import type { JobTelemetry } from "@/lib/protocolV1/jobTelemetry";
import type { InferenceConfig, PendingRemoteMerge } from "@/stores/inferenceStore";

const MAX_BATCH_SAMPLES = 20000; // bound batchSamples; drop oldest beyond this
const MAX_LOG_LINES = 1000; // bound the training log so it doesn't grow unbounded during long runs

function appendLog(prev: string[], ...lines: string[]): string[] {
  const next = [...prev, ...lines];
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}

// A tqdm/Lightning progress-bar line contains a "<pct>%|" segment, e.g.
// "Epoch 0:  85%|████▌ | 17/20 [00:03<00:00, 5.4it/s, loss=0.012]". tqdm rewrites
// these in place via carriage return many times/sec.
const PROGRESS_LINE_RE = /\d+%\|/;

/** One buffered log line; `progress` marks an in-place progress-bar redraw. */
export interface LogLine {
  line: string;
  progress: boolean;
}

/**
 * Normalize one raw output line before buffering. A line with embedded `\r`
 * (an old worker forwarding tqdm's raw carriage-return redraws) is treated
 * as its last non-empty `\r` segment — what a terminal would show — and
 * flagged as progress, same as an explicit `progress: true` line.
 */
export function normalizeLogLine(raw: string, progress = false): LogLine {
  if (!raw.includes("\r")) return { line: raw, progress };
  const segments = raw.split("\r").filter((seg) => seg.trim());
  return { line: segments[segments.length - 1] ?? "", progress: true };
}

/**
 * Merge a batch of raw output lines into the bounded training log. Strips
 * ANSI codes, drops blanks, and — to emulate a terminal carriage return —
 * REPLACES the trailing log line (instead of appending) when both it and the
 * incoming line are progress bars, so a tqdm bar shows as ONE in-place-
 * updating line rather than thousands. A line counts as a progress bar when
 * it looks like one (`PROGRESS_LINE_RE`) or was explicitly flagged
 * (`LogLine.progress`); `progressTail` carries the last flagged line across
 * calls, since the log itself is plain strings. Pure + synchronous so it is
 * unit-testable. Bounded to MAX_LOG_LINES.
 */
export function mergeLogLines(
  prev: string[],
  rawLines: Array<string | LogLine>,
  progressTail: string | null = null,
): { log: string[]; progressTail: string | null } {
  const next = prev.slice();
  let tail = progressTail;
  for (const raw of rawLines) {
    const { line, progress } = typeof raw === "string" ? { line: raw, progress: false } : raw;
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) continue;
    const isProgress = progress || PROGRESS_LINE_RE.test(clean);
    const last = next[next.length - 1];
    const lastIsProgress =
      last !== undefined && ((tail !== null && last === tail) || PROGRESS_LINE_RE.test(last));
    if (isProgress && lastIsProgress) {
      next[next.length - 1] = clean; // coalesce in place (carriage-return behavior)
    } else {
      next.push(clean);
    }
    tail = progress ? clean : null;
  }
  return {
    log: next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next,
    progressTail: tail,
  };
}

/** `mergeLogLines` for plain (unflagged) lines — the local stdout path. */
export function mergeStdoutIntoLog(prev: string[], rawLines: string[]): string[] {
  return mergeLogLines(prev, rawLines).log;
}

const TQDM_EPOCH_LOSS_RE = /Epoch (\d+):\s+(\d+)%\|.*?loss=([\d.]+)/;

export interface LogFlusher {
  /** Buffer one raw line; never touches the store. */
  push: (raw: string, progress?: boolean) => void;
  /** Apply everything buffered as ONE store update, attributing tqdm epoch/loss to `modelIndex` (default: current model). */
  flush: (modelIndex?: number) => void;
  /** Stop the timer and drain whatever is left. */
  stop: () => void;
}

type TrainingSet = (fn: (s: TrainingState) => Partial<TrainingState>) => void;
type TrainingGet = () => TrainingState;

/**
 * Buffered, throttled training-log writer shared by local and remote
 * training. Output lines (tqdm repaints many times/sec) must NEVER be
 * applied per line — that was an unthrottled re-render storm that froze the
 * UI (#128 follow-up). Lines are buffered and flushed every `intervalMs`
 * through `mergeLogLines`, and the latest tqdm epoch/loss in the batch drives
 * the live per-model progress — all in a single `set` per flush.
 */
export function createLogFlusher(set: TrainingSet, get: TrainingGet, intervalMs = 250): LogFlusher {
  const buffer: LogLine[] = [];
  let progressTail: string | null = null;
  const flush = (modelIndex?: number) => {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0, buffer.length);
    const idx = modelIndex ?? get().currentModelIndex;
    let tqdmEpoch: number | null = null;
    let tqdmLoss: number | null = null;
    for (const l of lines) {
      const m = l.line.match(TQDM_EPOCH_LOSS_RE);
      if (m) { tqdmEpoch = parseInt(m[1]); tqdmLoss = parseFloat(m[3]); }
    }
    set((s) => {
      const merged = mergeLogLines(s.log, lines, progressTail);
      progressTail = merged.progressTail;
      return {
        log: merged.log,
        models:
          tqdmEpoch !== null
            ? s.models.map((m, j) =>
                j === idx
                  ? {
                      ...m,
                      // tqdm's epoch is 0-based and a flush can land AFTER
                      // recordEpoch's 1-based completed count — Math.max
                      // keeps it from dragging the final "5/5" back to "4/5".
                      epoch: Math.max(m.epoch, tqdmEpoch as number),
                      loss: tqdmLoss ?? m.loss,
                    }
                  : m,
              )
            : s.models,
      };
    });
  };
  const timer = setInterval(() => flush(), intervalMs);
  return {
    push: (raw, progress = false) => {
      const l = normalizeLogLine(raw, progress);
      if (l.line.trim()) buffer.push(l);
    },
    flush,
    stop: () => {
      clearInterval(timer);
      flush();
    },
  };
}

// ── Types ─────────────────────────────────────────────────────────

export type ModelType =
  | "single_animal"
  | "top_down"
  | "bottom_up"
  | "top_down_id"
  | "bottom_up_id"
  | "centroid";

export type Backbone = "unet" | "convnext" | "swint";

/** UI-level data-pipeline choice; maps to sleap-nn's `data_config.data_pipeline_fw`. */
export type DataPipeline = "stream" | "memory" | "disk";

/** UI-level color-conversion choice; maps to sleap-nn's `data_config.preprocessing.{ensure_rgb,ensure_grayscale}`. */
export type ColorMode = "auto" | "rgb" | "grayscale";

/**
 * UI enum → sleap-nn `data_pipeline_fw` value. One-directional only — never
 * read back out of an uploaded config; see the "machine-specific settings"
 * comment in `parseYamlConfig` (dataPipeline is treated the same as
 * accelerator/numDevices/dataloaderWorkers: always a fresh default).
 */
const DATA_PIPELINE_FW: Record<DataPipeline, string> = {
  stream: "torch_dataset",
  memory: "torch_dataset_cache_img_memory",
  disk: "torch_dataset_cache_img_disk",
};

export interface TrainingConfig {
  // Model
  modelType: ModelType;
  configs: ConfigFile[];

  // Data
  trainingLabelsPath: string;
  validationLabelsPath: string;
}

/** Per-config hyperparameters parsed from YAML */
export interface ConfigHyperparams {
  backbone: Backbone | "";
  maxEpochs: number;
  batchSize: number;
  learningRate: number;
  runName: string;
  useWandb: boolean;
  wandbEntity: string;
  wandbProject: string;
  // Layer 1 quick-tune params
  validationFraction: number;
  overfitMode: boolean;
  earlyStoppingPatience: number;
  sigma: number;
  scale: number;
  // Model — backbone
  stemStride: number | null;
  /** `null` = Auto (live-recomputed from the loaded project's instance
   *  sizes, see recommendMaxStride in modelStats.ts); a number is a
   *  manual override. */
  maxStride: number | null;
  filters: number;
  filtersRate: number;
  middleBlock: boolean;
  upInterpolate: boolean;
  // Model — head
  outputStride: number;
  anchorPart: string | null;
  /**
   * Centroid-head only (`model_config.head_configs.centroid.confmaps.centroid_source`,
   * sleap-nn >=0.3.1 / #704): which centroid definition the head trains against.
   * `"user"` = first-class `UserCentroid` annotations (pose-only frames dropped),
   * `"computed"` = derived from keypoints (user centroids ignored), `null` = leave
   * unset and let sleap-nn infer it, which it does with a loud warning.
   */
  centroidSource: "user" | "computed" | null;
  // Loss weights (per sub-head, only used by multi-head model types)
  confmapsLossWeight: number;
  pafsLossWeight: number;
  classLossWeight: number;
  // Augmentation — individual controls (PyQt model)
  rotationPreset: "off" | "15" | "180" | "custom";
  rotationCustomAngle: number;
  scaleEnabled: boolean;
  scaleMin: number;
  scaleMax: number;
  uniformNoiseEnabled: boolean;
  uniformNoiseMin: number;
  uniformNoiseMax: number;
  gaussianNoiseEnabled: boolean;
  gaussianNoiseMean: number;
  gaussianNoiseStd: number;
  contrastEnabled: boolean;
  contrastMin: number;
  contrastMax: number;
  brightnessEnabled: boolean;
  brightnessMin: number;
  brightnessMax: number;
  // Data
  cropSize: number | null;
  randomSeed: number | null;
  // Optimization
  stopOnPlateau: boolean;
  plateauMinDelta: number;
  onlineMining: boolean;
  minHardKeypoints: number;
  maxHardKeypoints: number | null;
  hardToEasyRatio: number;
  lossScale: number;
  // LR scheduler (trainer_config.lr_scheduler — only the selected type's
  // sub-config is ever written; the other three are nulled)
  lrSchedulerType: "reduce_lr_on_plateau" | "step_lr" | "cosine_annealing_warmup" | "linear_warmup_linear_decay" | "none";
  stepLRStepSize: number;
  stepLRGamma: number;
  reduceLRThreshold: number;
  reduceLRThresholdMode: "rel" | "abs";
  reduceLRCooldown: number;
  reduceLRPatience: number;
  reduceLRFactor: number;
  reduceLRMinLR: number;
  cosineWarmupEpochs: number;
  cosineWarmupStartLR: number;
  cosineEtaMin: number;
  linearWarmupEpochs: number;
  linearWarmupStartLR: number;
  linearEndLR: number;
  trainingMode: "reuse_config" | "resume" | "finetune";
  accelerator: "auto" | "cuda" | "mps" | "cpu";
  /** Multi-GPU distribution strategy; only meaningful when numDevices > 1. */
  trainerStrategy: "auto" | "ddp" | "fsdp";
  // Performance
  dataPipeline: DataPipeline;
  dataloaderWorkers: number;
  numDevices: number | "auto";
  // Output — checkpoint saving
  saveBestModel: boolean;
  saveLastModel: boolean;
  saveTopKCount: number;
  checkpointMonitor: string;
  checkpointMode: "min" | "max";
  // Output — visualization
  visualizePredictions: boolean;
  keepVizImages: boolean;
  // Data — color conversion
  colorMode: ColorMode;
  // Epoch-end evaluation (distinct from the regular per-epoch validation loop)
  evalEnabled: boolean;
  evalFrequency: number;
  evalOksStddev: number;
  evalOksScale: number | null;
  evalMatchThreshold: number;
  // W&B extras (entity/project are above, near useWandb)
  wandbUploadViz: boolean;
  wandbPrevRunId: string;
  wandbGroup: string;
  // "offline" logs to local disk only (no network/login); sync later with `wandb sync`.
  wandbMode: "online" | "offline";
  wandbApiKey: string;
}

export const defaultHyperparams: ConfigHyperparams = {
  backbone: "",
  maxEpochs: 100,
  batchSize: 4,
  learningRate: 0.0001,
  runName: "",
  useWandb: false,
  wandbEntity: "",
  wandbProject: "",
  validationFraction: 0.1,
  overfitMode: false,
  earlyStoppingPatience: 10,
  sigma: 5.0,
  scale: 1.0,
  stemStride: null,
  maxStride: null,
  filters: 16,
  filtersRate: 2.0,
  middleBlock: true,
  upInterpolate: true,
  outputStride: 2,
  anchorPart: null,
  centroidSource: null,
  confmapsLossWeight: 1.0,
  pafsLossWeight: 1.0,
  classLossWeight: 1.0,
  rotationPreset: "180",
  rotationCustomAngle: 45,
  scaleEnabled: false,
  scaleMin: 0.9,
  scaleMax: 1.1,
  uniformNoiseEnabled: false,
  uniformNoiseMin: 0.0,
  uniformNoiseMax: 0.1,
  gaussianNoiseEnabled: false,
  gaussianNoiseMean: 0.0,
  gaussianNoiseStd: 0.04,
  contrastEnabled: false,
  contrastMin: 0.5,
  contrastMax: 2.0,
  brightnessEnabled: false,
  brightnessMin: 0.0,
  brightnessMax: 0.2,
  cropSize: null,
  randomSeed: null,
  stopOnPlateau: true,
  plateauMinDelta: 1e-08,
  onlineMining: false,
  minHardKeypoints: 2,
  maxHardKeypoints: null,
  hardToEasyRatio: 2.0,
  lossScale: 5.0,
  // Matches the reduce_lr_on_plateau values already baked into every checked-in
  // baseline YAML preset (see src/assets/training_profiles/*.yaml), so picking
  // a preset and never touching this control keeps today's behavior unchanged.
  lrSchedulerType: "reduce_lr_on_plateau",
  stepLRStepSize: 10,
  stepLRGamma: 0.1,
  reduceLRThreshold: 1e-6,
  reduceLRThresholdMode: "abs",
  reduceLRCooldown: 3,
  reduceLRPatience: 5,
  reduceLRFactor: 0.5,
  reduceLRMinLR: 1e-8,
  cosineWarmupEpochs: 5,
  cosineWarmupStartLR: 0.0,
  cosineEtaMin: 0.0,
  linearWarmupEpochs: 5,
  linearWarmupStartLR: 0.0,
  linearEndLR: 0.0,
  trainingMode: "reuse_config",
  accelerator: "auto",
  trainerStrategy: "auto",
  dataPipeline: "memory",
  dataloaderWorkers: 2,
  numDevices: "auto",
  saveBestModel: true,
  saveLastModel: false,
  saveTopKCount: 1,
  checkpointMonitor: "val/loss",
  checkpointMode: "min",
  // Deliberately true (sleap-nn's own defaults are both false): this is what
  // actually makes the app's own epoch-viz-scrubber feature work out of the
  // box — see the `keep_viz`/`visualize_preds_during_training` comment in
  // applyHyperparamsToYaml below for why they must go together.
  visualizePredictions: true,
  keepVizImages: true,
  colorMode: "auto",
  evalEnabled: false,
  evalFrequency: 1,
  evalOksStddev: 0.025,
  evalOksScale: null,
  evalMatchThreshold: 50.0,
  wandbUploadViz: false,
  wandbPrevRunId: "",
  wandbGroup: "",
  wandbMode: "online",
  wandbApiKey: "",
};

export interface ConfigFile {
  filename: string;
  content: string; // raw YAML text
  modelType: string; // parsed from head_configs (e.g., "centroid")
  slot: string; // which slot this fills (e.g., "centroid", "centered_instance", "config")
  hyperparams: ConfigHyperparams; // per-config hyperparameters
  /**
   * Snapshot of `hyperparams` as the config was loaded/imported. Powers the
   * "modified" indicators (diff against this) and Reset, which restores to these
   * as-loaded values — not the global `defaultHyperparams`.
   */
  originalHyperparams: ConfigHyperparams;
  hasTrainedModel: boolean; // true if config has a non-empty run_name (trained model exists)
  /** Absolute path to this config's source run's checkpoint file, for Resume/Fine-tune. `null` for a baseline profile or a manually-browsed file (no known run directory). */
  checkpointPath: string | null;
}

export interface RemoteTrainingOptions {
  remote: true;
  workerId: string;
  /**
   * "worker-file" points at a path already on the worker's filesystem (the
   * original, pre-PR3 behavior — still TrainingPanel's only option until
   * PR3b adds the "this window" picker). "window" sends this window's own
   * labels — unsaved edits included — built by `buildRemoteLabelsPayload`,
   * selectively embedding a hidden video's labeled frames so training still
   * has pixels to learn from (see remoteVisibility.ts/remoteLabelsPayload.ts).
   */
  labelsSource: "window" | "worker-file";
  /** labelsSource: "worker-file" — the path on the worker. */
  workerLabelsPath?: string;
  /**
   * labelsSource: "window" — precomputed visibility (e.g. already known from
   * PR3b's data-summary UI). Computed on demand via `checkVideoVisibility`
   * when omitted.
   */
  visibility?: VideoVisibility[];
  /** labelsSource: "window" — also embed "frames to predict" pixels (suggestions) so post-training inference can cover a hidden video too. */
  embedFramesToPredict?: boolean;
  valLabelsPath?: string;
  /** Post-training inference target ("nothing"/absent = skip). Run as a separate track job once all models train. */
  inferenceTarget?: string;
  sampleCount?: number;
  skipUserLabeled?: boolean;
  existingPredictions?: "clear_all" | "replace" | "keep";
}

/**
 * Remote post-training inference: the track job the app submits after every
 * model of a remote run trains. Its predictions are NOT merged automatically
 * — `pendingMerge` holds the finished job's result(s) until the user clicks
 * "Fetch & Load" (same rationale as inferenceStore's `pendingRemoteMerge`).
 */
export interface PostTrainingInference {
  status: "running" | "completed" | "error" | "skipped";
  /** Error / skip reason, or the last fetch failure while `pendingMerge` is kept for retry. */
  message: string | null;
  pendingMerge: PendingRemoteMerge | null;
  /** True once the predictions were fetched and merged into the project. */
  merged: boolean;
}

export interface LocalTrainingOptions {
  inferenceTarget?: string;
  sampleCount?: number;
  skipUserLabeled?: boolean;
  existingPredictions?: "clear_all" | "replace" | "keep";
  /** Post-training model export ("none" = don't export). Desktop-only. */
  exportFormat?: "none" | "onnx" | "tensorrt";
  /** Run post-training inference on the exported model (falls back to the checkpoint on failure). */
  useExportedForInference?: boolean;
}

// Session guard: whether we've already confirmed sleap-nn's [export] extra
// this app session, so a format-selected training run doesn't re-probe before
// every run. Backed by a real presence check now (detectExtras ->
// detect_sleap_nn_extras), so a run only pays for a tool reinstall when the
// extras are genuinely absent. Resets on reload.
let exportSupportEnsured = { onnx: false, tensorrt: false };

export type TrainingStatus = "idle" | "running" | "completed" | "error" | "stopped";

export interface EpochSample {
  epoch: number;
  trainLoss: number | null;
  valLoss: number | null;
}

export interface BatchSample {
  globalBatch: number;
  loss: number;
}

export interface BatchInput {
  epoch: number;
  batch: number;
  loss: number;
}

export interface RuntimeMetrics {
  meanEpochTimeSec: number | null;
  etaNext10Min: number | null;
  epochsInPlateau: number;
  inPlateau: boolean;
  bestValEpoch: number | null;
}

export function emptyMetrics(): RuntimeMetrics {
  return { meanEpochTimeSec: null, etaNext10Min: null, epochsInPlateau: 0, inPlateau: false, bestValEpoch: null };
}

export interface ModelProgress {
  label: string;
  epoch: number;
  maxEpochs: number;
  loss: number | null;
  valLoss: number | null;
  bestValLoss: number | null;
  status: "pending" | "running" | "completed" | "failed";
  epochSamples: EpochSample[];
  batchSamples: BatchSample[];
  epochSize: number;        // batches-per-epoch (learned: max seen last_batch+1); PyQt parity
  lastBatchNumber: number;  // most recent batch index seen this epoch
  metrics: RuntimeMetrics;
  epochStartedAt: number | null;
  plateauPatience: number | null;
  plateauMinDelta: number | null;
  /** Local-training-only filesystem run dir (`${modelDir}/${runName}`); null for remote / not-yet-started. */
  runDir: string | null;
}

/**
 * A freshly-started model's progress state, before any epoch/batch has been
 * recorded. Shared by `startTraining` (one per config slot, below) and
 * `jobStream.ts`'s `initialJobStream` (one per watched remote job, for the
 * Connect window's per-job viewer — PR4a §4a.5) so both start from exactly
 * the same shape.
 */
export function emptyModelProgress(label: string, maxEpochs = 100): ModelProgress {
  return {
    label,
    epoch: 0,
    maxEpochs,
    loss: null,
    valLoss: null,
    bestValLoss: null,
    status: "pending",
    epochSamples: [],
    batchSamples: [],
    epochSize: 1,
    lastBatchNumber: 0,
    metrics: emptyMetrics(),
    epochStartedAt: null,
    plateauPatience: null,
    plateauMinDelta: null,
    runDir: null,
  };
}

interface TrainingState {
  // Config
  config: TrainingConfig;

  // Status
  status: TrainingStatus;
  error: string | null;
  /** Recent stderr lines from a failed sleap-nn run, forwarded so the training
   *  window can show the actual error output (mirrors inferenceStore.stderrTail).
   *  Empty while healthy / running. */
  stderrTail: string[];
  startedAt: number | null;
  _stopRequested: boolean;
  _isRemote: boolean;

  // Progress
  models: ModelProgress[];
  currentModelIndex: number;
  wandbUrl: string | null;
  modelOutputDirs: string[];
  log: string[]; // single shared log for all models
  /** Remote runs only; `null` when not requested / not reached. */
  postTrainingInference: PostTrainingInference | null;

  /**
   * Bumped on every `reset()`. `TrainingPanel`'s baseline-autoload effect keys
   * off `config.modelType` alone, so a `reset()` that lands back on the SAME
   * model type (e.g. "Train Again" after a Top-Down run) wouldn't otherwise
   * re-fire and refill `config.configs` — this gives that effect a signal
   * that's independent of whether `modelType` actually changed.
   */
  resetSeq: number;

  /**
   * One-shot instructions from another panel that sent the user here (today:
   * the active-learning Phase-2 → pose-training handoff).
   *
   * The post-training inference fields live in TrainingPanel's local state, not
   * in `config`, so a caller can't preset them directly; the panel drains this
   * on arrival and clears it. `requireModelTypeChoice` blocks Start until the
   * user picks a pipeline explicitly — the AL handoff deliberately ships no
   * default, since top-down vs bottom-up is a real decision about their data
   * and `config.modelType` would otherwise silently stay whatever it last was.
   */
  pendingHandoff: {
    inferenceTarget?: string;
    skipUserLabeled?: boolean;
    requireModelTypeChoice?: boolean;
  } | null;

  // Actions
  setPendingHandoff: (v: TrainingState["pendingHandoff"]) => void;
  setConfig: <K extends keyof TrainingConfig>(key: K, value: TrainingConfig[K]) => void;
  updateConfigHyperparams: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  /** Restore ALL of a config's hyperparameters to its as-loaded baseline. */
  resetConfigHyperparams: (slot: string) => void;
  updateConfigCheckpointPath: (slot: string, path: string | null) => void;
  addConfigFile: (file: ConfigFile) => void;
  removeConfigFile: (slot: string) => void;
  parseYamlConfig: (yamlText: string, filename: string, slot: string, checkpointPath?: string | null) => ConfigFile | null;
  reset: () => void;
  startTraining: (opts?: RemoteTrainingOptions | LocalTrainingOptions) => Promise<void>;
  stopTraining: () => Promise<void>;
  cancelTraining: () => Promise<void>;
  recordEpoch: (modelIndex: number, sample: EpochSample) => void;
  recordBatch: (modelIndex: number, sample: BatchInput) => void;
  recordBatches: (modelIndex: number, samples: BatchInput[]) => void;
  markEpochBegin: (modelIndex: number, epoch: number) => void;
  /** Route one remote job's structured telemetry into model `modelIndex`'s monitor state. */
  applyRemoteTelemetry: (modelIndex: number, telemetry: JobTelemetry) => void;
  /** Fetch & merge the remote post-training inference predictions (explicit user action). */
  fetchAndLoadPostTrainingPredictions: () => Promise<void>;
}

// ── Config slot helpers ───────────────────────────────────────────

/** Get required config slots for a model type */
export function getConfigSlots(modelType: ModelType): string[] {
  switch (modelType) {
    case "top_down":
    case "top_down_id":
      return ["centroid", "centered_instance"];
    case "centroid":
      return ["centroid"];
    default:
      return ["config"];
  }
}

/** Get display label for a config slot */
export function getSlotLabel(slot: string): string {
  switch (slot) {
    case "centroid": return "Centroid Config";
    case "centered_instance": return "Centered Instance Config";
    default: return "Config";
  }
}

/**
 * Whether a frame is training data: a user instance or a negative frame — the
 * JS equivalent of sleap-io's `Labels.user_labeled_frames` (which includes
 * negative/background frames as trainable data, not just positively-labeled
 * ones). With `includeUserCentroids`, a user-placed centroid annotation counts
 * too: that is exactly what the active-learning centroid locator trains on, and
 * a seeded frame holds no instance at all.
 */
function isTrainingFrame(lf: Labels["labeledFrames"][number], includeUserCentroids: boolean): boolean {
  return (
    lf.hasUserInstances ||
    lf.isNegative ||
    (includeUserCentroids && lf.centroids.some((c) => !c.isPredicted))
  );
}

/**
 * Count of training frames (see {@link isTrainingFrame}). Used for the `n=`
 * suffix in a default run name; `null` with no project loaded. Deliberately
 * uncached: callers run once per training start, and `labels` is mutated in
 * place, so a cache keyed by its reference would freeze the first count for the
 * whole session. The per-render gate uses {@link hasTrainingFrames}.
 */
export function countUserLabeledFrames(
  labels: Labels | null,
  opts: { includeUserCentroids?: boolean } = {},
): number | null {
  if (!labels) return null;
  const withCentroids = opts.includeUserCentroids ?? false;
  let n = 0;
  for (const lf of labels.labeledFrames) if (isTrainingFrame(lf, withCentroids)) n++;
  return n;
}

let _hasTrainingFramesCache: {
  labels: Labels;
  editSeq: number;
  includeUserCentroids: boolean;
  result: boolean;
} | null = null;

/**
 * Whether the project has ANY training frame — the Training panel's per-render
 * Start gate. Short-circuits on the first hit and is cached on
 * (`labels`, the app store's `editSeq`), so it re-scans only after an edit.
 */
export function hasTrainingFrames(
  labels: Labels | null,
  editSeq: number,
  opts: { includeUserCentroids?: boolean } = {},
): boolean {
  if (!labels) return false;
  const withCentroids = opts.includeUserCentroids ?? false;
  const c = _hasTrainingFramesCache;
  if (c && c.labels === labels && c.editSeq === editSeq && c.includeUserCentroids === withCentroids) {
    return c.result;
  }
  const result = labels.labeledFrames.some((lf) => isTrainingFrame(lf, withCentroids));
  _hasTrainingFramesCache = { labels, editSeq, includeUserCentroids: withCentroids, result };
  return result;
}

/**
 * Resolves a train job's `run_name` before it's serialized into YAML.
 * `hyperparams.runName` is always blank on a freshly-imported config (see
 * `parseYamlConfig`), and `applyHyperparamsToYaml` only writes `run_name`
 * when it's non-empty — so a remote submission, which has no Hydra
 * CLI-override safety net (the worker runs whatever's baked into
 * `config_contents` verbatim), needs a fresh value resolved BEFORE
 * serializing, or an imported config's stale `run_name` would otherwise
 * ride straight through into the job. Matches legacy SLEAP's
 * `get_timestamp()` + base run name scheme
 * (`sleap/gui/learning/runners.py`). Extracted from `startTraining`'s
 * remote branch (PR5a) so the launcher wizard's worker-file jobs
 * (`launcherSpec.ts`) can resolve the same way against a worker-side
 * `Labels` instead of the open project's.
 */
export function resolveRemoteRunName(
  hp: ConfigHyperparams,
  modelType: string,
  labels: Labels | null,
  opts?: { runTimestamp?: string },
): string {
  if (hp.runName) return hp.runName;
  // A caller building several configs for one submission (a split
  // multi-model pipeline) passes a shared `runTimestamp` so every model's
  // run name carries the exact same timestamp, computed only once for the
  // whole batch — not a fresh one per model (which real time passing
  // between calls could otherwise let drift by a second).
  const runTimestamp = opts?.runTimestamp ?? formatRunTimestamp();
  const userLabeledFrameCount = countUserLabeledFrames(labels, {
    includeUserCentroids: modelType === "centroid",
  });
  return userLabeledFrameCount !== null
    ? `${runTimestamp}.${modelType}.n=${userLabeledFrameCount}`
    : `${runTimestamp}.${modelType}`;
}

/**
 * Resolves `max_stride` when a config leaves it at Auto (`null`) —
 * sleap-nn has no server-side Auto resolution for it (unlike `crop_size`),
 * so it must be resolved client-side from the data's actual instance sizes
 * before the config ever leaves this app. `undefined` when already
 * explicit, or when there's nothing to recommend from (no size stats and
 * not a pretrained backbone, which always uses stride 32 regardless of
 * data). Extracted from `startTraining`'s remote branch (PR5a) — see
 * {@link resolveRemoteRunName}'s doc for why.
 */
export function resolveRemoteMaxStride(
  hp: ConfigHyperparams,
  labels: Labels | null,
): number | undefined {
  if (hp.maxStride != null) return undefined;
  const isPretrainedBackbone = !!hp.backbone && hp.backbone !== "unet";
  const sizeStats = computeInstanceSizeStats(labels);
  if (!sizeStats && !isPretrainedBackbone) return undefined;
  return recommendMaxStride(
    sizeStats?.avgAnimalSize ?? 0,
    sizeStats?.maxBboxDim ?? 0,
    hp.scale,
    hp.backbone,
  );
}

/**
 * The `InferenceConfig` for post-training inference — shared by local runs
 * (run directly) and remote runs (turned into a track job spec). Only the
 * target/model/merge choices come from the training panel; every other
 * inference option is the fixed default post-training inference has always
 * used.
 */
export function buildPostTrainingInferenceConfig(opts: {
  modelType: ModelType;
  modelPaths: string[];
  inferenceTarget: string;
  videoIndex: number | "all";
  sampleCount?: number;
  skipUserLabeled?: boolean;
  existingPredictions?: "clear_all" | "replace" | "keep";
  device?: InferenceConfig["device"];
  runtime?: InferenceConfig["runtime"];
}): InferenceConfig {
  const pipelineMap: Record<string, InferenceConfig["pipeline"]> = {
    single_animal: "single-animal",
    top_down: "top-down",
    bottom_up: "bottom-up",
    top_down_id: "top-down-id",
    bottom_up_id: "bottom-up-id",
  };
  return {
    pipeline: pipelineMap[opts.modelType] || "top-down",
    trackOnly: false,
    modelPaths: opts.modelPaths,
    videoIndex: opts.videoIndex,
    frameRange: opts.inferenceTarget as InferenceConfig["frameRange"],
    sampleCount: opts.sampleCount ?? 20,
    excludeUserLabeled: opts.skipUserLabeled ?? false,
    existingPredictions: opts.existingPredictions ?? "replace",
    batchSize: 4,
    device: opts.device ?? "auto",
    runtime: opts.runtime ?? "auto",
    maxInstances: null,
    peakThreshold: 0.2,
    integralRefinement: true,
    integralPatchSize: 5,
    nPoints: 10,
    maxEdgeLengthRatio: 0.25,
    distPenaltyWeight: 1.0,
    minLineScores: 0.25,
    tracking: false,
    trackerMethod: "simple",
    similarityMethod: "oks",
    matchingMethod: "hungarian",
    trackingWindowSize: 5,
    maxTracks: null,
    connectSingleBreaks: false,
    robust: 0.95,
    minMatchPoints: 0,
    minNewTrackPoints: 0,
    scoringReduction: "mean",
    trackingTargetInstanceCount: null,
    trackingPreCullToTarget: false,
    trackingPreCullIouThreshold: 0,
    trackingCleanInstanceCount: null,
    trackingCleanIouThreshold: 0,
    flowImgScale: 1.0,
    flowWindowSize: 21,
    flowMaxLevels: 3,
    kfTrackFeatures: "centroid",
    kfInitFrameCount: 10,
    kfNodeIndices: [],
    kfResetGapSize: 5,
    ensureChannels: "auto",
    filterOverlapping: false,
    filterMethod: "iou",
    filterThreshold: 0.8,
    filterMinVisibleNodes: null,
    filterMinVisibleNodeFraction: null,
    filterMinMeanNodeScore: null,
    filterMinInstanceScore: null,
    filterMinCentroidDistance: null,
    // Ignored by every pose pipeline above; set for type completeness. (A
    // centroid-only run never reaches here — post-training inference skips
    // `modelType === "centroid"`.)
    centroidOutput: "centroid",
  };
}

// ── YAML override helper ─────────────────────────────────────────

/** Apply ConfigHyperparams overrides to raw YAML config content.
 *
 * `resolvedMaxStride` is used only when `hp.maxStride` is `null` (Auto):
 * unlike `crop_size`, sleap-nn's max_stride has no server-side auto-compute
 * (it's a plain non-Optional int in the model config schema), so Auto mode
 * must be resolved to a concrete integer by the caller — see call sites in
 * `startTraining` — before this function ever runs. Falls back to the
 * historical default of 16 if the caller can't resolve one (e.g. no
 * project loaded), which also keeps pre-existing callers that don't pass
 * this argument (most unit tests) working unchanged.
 *
 * `resolvedInChannels` mirrors that same pattern for the UNet backbone's
 * `in_channels`: sleap-nn has no server-side Auto for it either, so the
 * caller must resolve `hp.colorMode` ("auto"/"rgb"/"grayscale") against the
 * project's actual video channel count — see `resolveInputChannels` in
 * `modelStats.ts` — before this function runs. Falls back to 1 (grayscale,
 * matching every baseline profile's default) if the caller can't resolve
 * one. */
export function applyHyperparamsToYaml(
  yamlText: string,
  hp: ConfigHyperparams,
  checkpointPath: string | null = null,
  resolvedMaxStride?: number,
  resolvedInChannels?: number,
): string {
  const doc = yaml.load(yamlText) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return yamlText;

  // Ensure nested structures exist
  if (!doc.trainer_config) doc.trainer_config = {};
  if (!doc.data_config) doc.data_config = {};
  if (!doc.model_config) doc.model_config = {};
  const trainer = doc.trainer_config as Record<string, unknown>;
  const data = doc.data_config as Record<string, unknown>;
  const model = doc.model_config as Record<string, unknown>;

  // Basic training params
  trainer.max_epochs = hp.maxEpochs;

  // Checkpoint saving. save_top_k is a count (0 = off, -1 = keep all, N =
  // keep best N); saveTopKCount only takes effect while saveBestModel is on.
  if (!trainer.model_ckpt) trainer.model_ckpt = {};
  const modelCkpt = trainer.model_ckpt as Record<string, unknown>;
  modelCkpt.save_top_k = hp.saveBestModel ? hp.saveTopKCount : 0;
  modelCkpt.save_last = hp.saveLastModel;
  modelCkpt.monitor = hp.checkpointMonitor;
  modelCkpt.mode = hp.checkpointMode;

  // Visualization — keep_viz only has any effect when
  // visualize_preds_during_training is also true (per sleap-nn's docstring:
  // "Only applies when visualize_preds_during_training is True"), so it's
  // gated on it here rather than being independently forced true. This is
  // what makes the app's own epoch-viz-scrubber feature (which needs the viz
  // folder to survive training) actually work.
  trainer.visualize_preds_during_training = hp.visualizePredictions;
  trainer.keep_viz = hp.visualizePredictions && hp.keepVizImages;

  if (!trainer.train_data_loader) trainer.train_data_loader = {};
  (trainer.train_data_loader as Record<string, unknown>).batch_size = hp.batchSize;

  // Erase any skeleton baked into an imported/baseline config — it may
  // belong to an entirely different project. sleap-nn always re-derives the
  // real skeleton from the actual training data (`labels[0].skeletons`) and
  // overwrites this field before saving its own `training_config.yaml`
  // (sleap_nn/training/model_trainer.py), so this never carries a stale
  // definition through to training; it just keeps the intermediate config we
  // generate from showing a foreign skeleton before that overwrite happens.
  // (parseYamlConfig already clears both of these at load time too — kept
  // here as well since this is the actual final gate before sleap-nn runs.)
  data.skeletons = [];
  data.cache_img_path = null;

  // Performance — data pipeline + dataloader workers
  const dataPipelineFw = DATA_PIPELINE_FW[hp.dataPipeline] ?? DATA_PIPELINE_FW.stream;
  data.data_pipeline_fw = dataPipelineFw;
  // sleap-nn only supports multiprocessing dataloader workers with a caching
  // pipeline; the streaming `torch_dataset` path requires num_workers == 0.
  const numWorkers = dataPipelineFw === "torch_dataset" ? 0 : hp.dataloaderWorkers;
  (trainer.train_data_loader as Record<string, unknown>).num_workers = numWorkers;
  if (!trainer.val_data_loader) trainer.val_data_loader = {};
  (trainer.val_data_loader as Record<string, unknown>).num_workers = numWorkers;

  if (!trainer.optimizer) trainer.optimizer = {};
  (trainer.optimizer as Record<string, unknown>).lr = hp.learningRate;
  if (hp.runName) trainer.run_name = hp.runName;

  // Resume / fine-tune — mutually exclusive; always write both branches so a
  // stale value baked into an uploaded/auto-loaded trained config (itself the
  // product of a prior resume/fine-tune run) doesn't silently ride through
  // when the mode is switched back to scratch or to the other mode.
  // - "resume": true Lightning resume (Trainer.fit(ckpt_path=...)) — restores
  //   optimizer/scheduler/epoch state and continues the same trajectory.
  // - "finetune": weight-seeded init only (new run, fresh optimizer/epoch
  //   state) — mirrors legacy SLEAP's "Resume training (fine-tune)".
  trainer.resume_ckpt_path =
    hp.trainingMode === "resume" && checkpointPath ? checkpointPath : null;
  model.pretrained_backbone_weights =
    hp.trainingMode === "finetune" && checkpointPath ? checkpointPath : null;
  model.pretrained_head_weights =
    hp.trainingMode === "finetune" && checkpointPath ? checkpointPath : null;

  // W&B
  trainer.use_wandb = hp.useWandb;
  if (hp.useWandb) {
    if (!trainer.wandb) trainer.wandb = {};
    const wandb = trainer.wandb as Record<string, unknown>;
    if (hp.wandbEntity) wandb.entity = hp.wandbEntity;
    if (hp.wandbProject) wandb.project = hp.wandbProject;
    wandb.save_viz_imgs_wandb = hp.wandbUploadViz;
    if (hp.wandbPrevRunId) wandb.prv_runid = hp.wandbPrevRunId;
    if (hp.wandbGroup) wandb.group = hp.wandbGroup;
    // null (not "online") is sleap-nn's default/online sentinel for wandb_mode.
    wandb.wandb_mode = hp.wandbMode === "offline" ? "offline" : null;
    if (hp.wandbApiKey) wandb.api_key = hp.wandbApiKey;
  }
  // wandb.name has no corresponding UI field, so a value baked into an
  // uploaded/hand-edited config would otherwise ride through untouched and
  // silently point W&B at a stale prior run. Always clear it — mirrors
  // legacy SLEAP's belt-and-suspenders clear of trainer_config.wandb.name.
  if (trainer.wandb && typeof trainer.wandb === "object") {
    delete (trainer.wandb as Record<string, unknown>).name;
  }

  // Data config
  data.validation_fraction = hp.validationFraction;
  data.use_same_data_for_val = hp.overfitMode;

  // Data — preprocessing
  if (!data.preprocessing) data.preprocessing = {};
  const preprocessing = data.preprocessing as Record<string, unknown>;
  preprocessing.scale = hp.scale;
  preprocessing.crop_size = hp.cropSize;
  preprocessing.ensure_rgb = hp.colorMode === "rgb";
  preprocessing.ensure_grayscale = hp.colorMode === "grayscale";

  // Epoch-end evaluation — a distinct mechanism from the regular per-epoch
  // validation loop (runs full pose metrics like mOKS/mAP/PCK on a cadence).
  if (!trainer.eval) trainer.eval = {};
  const evalConfig = trainer.eval as Record<string, unknown>;
  evalConfig.enabled = hp.evalEnabled;
  evalConfig.frequency = hp.evalFrequency;
  evalConfig.oks_stddev = hp.evalOksStddev;
  evalConfig.oks_scale = hp.evalOksScale;
  evalConfig.match_threshold = hp.evalMatchThreshold;

  // Seed
  trainer.seed = hp.randomSeed;

  // Override accelerator so configs from CUDA machines work on CPU/MPS
  trainer.trainer_accelerator = hp.accelerator;

  // Number of devices ("auto" or a positive integer)
  trainer.trainer_devices = hp.numDevices;

  // Multi-GPU distribution strategy ("auto"/"ddp"/"fsdp"); Lightning ignores it
  // for single-device runs, so it only matters when trainer_devices > 1.
  trainer.trainer_strategy = hp.trainerStrategy;

  // Early stopping
  if (!trainer.early_stopping) trainer.early_stopping = {};
  const es = trainer.early_stopping as Record<string, unknown>;
  es.stop_training_on_plateau = hp.stopOnPlateau;
  es.patience = hp.earlyStoppingPatience;
  es.min_delta = hp.plateauMinDelta;

  // LR scheduler — only the selected type's sub-config is populated; the
  // other three are explicitly nulled so sleap-nn's per-field `is not None`
  // priority chain (cosine > linear > step_lr > reduce_on_plateau, see
  // lightning_modules.py) picks exactly one scheduler, or none at all when
  // every sub-key is null.
  if (!trainer.lr_scheduler) trainer.lr_scheduler = {};
  const lrs = trainer.lr_scheduler as Record<string, unknown>;
  lrs.step_lr =
    hp.lrSchedulerType === "step_lr"
      ? { step_size: hp.stepLRStepSize, gamma: hp.stepLRGamma }
      : null;
  lrs.reduce_lr_on_plateau =
    hp.lrSchedulerType === "reduce_lr_on_plateau"
      ? {
          threshold: hp.reduceLRThreshold,
          threshold_mode: hp.reduceLRThresholdMode,
          cooldown: hp.reduceLRCooldown,
          patience: hp.reduceLRPatience,
          factor: hp.reduceLRFactor,
          min_lr: hp.reduceLRMinLR,
        }
      : null;
  lrs.cosine_annealing_warmup =
    hp.lrSchedulerType === "cosine_annealing_warmup"
      ? {
          warmup_epochs: hp.cosineWarmupEpochs,
          warmup_start_lr: hp.cosineWarmupStartLR,
          eta_min: hp.cosineEtaMin,
        }
      : null;
  lrs.linear_warmup_linear_decay =
    hp.lrSchedulerType === "linear_warmup_linear_decay"
      ? {
          warmup_epochs: hp.linearWarmupEpochs,
          warmup_start_lr: hp.linearWarmupStartLR,
          end_lr: hp.linearEndLR,
        }
      : null;

  // Online hard keypoint mining
  if (!trainer.online_hard_keypoint_mining) trainer.online_hard_keypoint_mining = {};
  const ohkm = trainer.online_hard_keypoint_mining as Record<string, unknown>;
  ohkm.online_mining = hp.onlineMining;
  ohkm.min_hard_keypoints = hp.minHardKeypoints;
  ohkm.max_hard_keypoints = hp.maxHardKeypoints;
  ohkm.hard_to_easy_ratio = hp.hardToEasyRatio;
  ohkm.loss_scale = hp.lossScale;

  // Sigma — apply to all head configs
  const headConfigs = (model.head_configs ?? {}) as Record<string, unknown>;
  for (const [, headVal] of Object.entries(headConfigs)) {
    if (headVal && typeof headVal === "object") {
      const head = headVal as Record<string, unknown>;
      if ("sigma" in head) head.sigma = hp.sigma;
      // Bottom-up nested confmaps
      if (head.confmaps && typeof head.confmaps === "object") {
        (head.confmaps as Record<string, unknown>).sigma = hp.sigma;
      }
    }
  }

  // part_names — same stale-node-name-list concern as data_config.skeletons
  // above; parseYamlConfig already clears this at load time, cleared here
  // too as the final gate. Only where the key is already present (see
  // parseYamlConfig's comment: centroid's confmaps schema doesn't define it).
  for (const headVal of Object.values(headConfigs)) {
    if (headVal && typeof headVal === "object") {
      const confmaps = (headVal as Record<string, unknown>).confmaps;
      if (confmaps && typeof confmaps === "object" && "part_names" in confmaps) {
        (confmaps as Record<string, unknown>).part_names = null;
      }
    }
  }

  // Backbone model params
  const backboneConfig = (model.backbone_config ?? {}) as Record<string, unknown>;
  if (hp.backbone === "unet" || !hp.backbone) {
    if (!backboneConfig.unet) backboneConfig.unet = {};
    const unet = backboneConfig.unet as Record<string, unknown>;
    unet.max_stride = hp.maxStride ?? resolvedMaxStride ?? 16;
    unet.filters = hp.filters;
    unet.filters_rate = hp.filtersRate;
    unet.middle_block = hp.middleBlock;
    unet.up_interpolate = hp.upInterpolate;
    unet.stem_stride = hp.stemStride;
    unet.in_channels = resolvedInChannels ?? 1;
    model.backbone_config = backboneConfig;
  }

  // Head params — output_stride, anchor_part, and (centroid head) centroid_source
  for (const [headName, headVal] of Object.entries(headConfigs)) {
    if (headVal && typeof headVal === "object") {
      const head = headVal as Record<string, unknown>;
      if (head.confmaps && typeof head.confmaps === "object") {
        (head.confmaps as Record<string, unknown>).output_stride = hp.outputStride;
        if (hp.anchorPart !== null) {
          (head.confmaps as Record<string, unknown>).anchor_part = hp.anchorPart;
        }
        // sleap-nn >=0.3.1 (#704): the centroid head must train against ONE
        // centroid definition for the whole dataset. Left unset it infers one and
        // warns; we always know which we mean, so say it. "user" trains on
        // `UserCentroid` annotations (and DROPS pose-only frames); "computed"
        // derives every centroid from keypoints and IGNORES user centroids.
        if (headName === "centroid" && hp.centroidSource !== null) {
          (head.confmaps as Record<string, unknown>).centroid_source = hp.centroidSource;
        }
      } else {
        head.output_stride = hp.outputStride;
        if (hp.anchorPart !== null) {
          head.anchor_part = hp.anchorPart;
        }
        if (headName === "centroid" && hp.centroidSource !== null) {
          head.centroid_source = hp.centroidSource;
        }
      }
    }
  }

  // Loss weights — per sub-head (skip centroid and single_instance whose
  // confmaps schemas in sleap-nn don't include loss_weight)
  const noLossWeightHeads = new Set(["centroid", "single_instance"]);
  for (const [headName, headVal] of Object.entries(headConfigs)) {
    if (headVal && typeof headVal === "object") {
      const head = headVal as Record<string, unknown>;
      if (head.confmaps && typeof head.confmaps === "object" && !noLossWeightHeads.has(headName)) {
        (head.confmaps as Record<string, unknown>).loss_weight = hp.confmapsLossWeight;
      }
      if (head.pafs && typeof head.pafs === "object") {
        (head.pafs as Record<string, unknown>).loss_weight = hp.pafsLossWeight;
      }
      if (head.class_vectors && typeof head.class_vectors === "object") {
        (head.class_vectors as Record<string, unknown>).loss_weight = hp.classLossWeight;
      }
      if (head.class_maps && typeof head.class_maps === "object") {
        (head.class_maps as Record<string, unknown>).loss_weight = hp.classLossWeight;
      }
    }
  }

  // Augmentation — individual controls
  if (!data.augmentation_config) data.augmentation_config = {};
  const augConfig = data.augmentation_config as Record<string, unknown>;
  if (!augConfig.geometric) augConfig.geometric = {};
  if (!augConfig.intensity) augConfig.intensity = {};
  const geo = augConfig.geometric as Record<string, unknown>;
  const int = augConfig.intensity as Record<string, unknown>;

  // Rotation
  if (hp.rotationPreset === "off") {
    geo.rotation_min = 0;
    geo.rotation_max = 0;
    geo.affine_p = 0;
  } else if (hp.rotationPreset === "15") {
    geo.rotation_min = -15;
    geo.rotation_max = 15;
    geo.affine_p = 1.0;
  } else if (hp.rotationPreset === "180") {
    geo.rotation_min = -180;
    geo.rotation_max = 180;
    geo.affine_p = 1.0;
  } else if (hp.rotationPreset === "custom") {
    geo.rotation_min = -hp.rotationCustomAngle;
    geo.rotation_max = hp.rotationCustomAngle;
    geo.affine_p = 1.0;
  }

  // Scale
  if (hp.scaleEnabled) {
    geo.scale_min = hp.scaleMin;
    geo.scale_max = hp.scaleMax;
  } else {
    geo.scale_min = 1.0;
    geo.scale_max = 1.0;
  }

  // Uniform noise
  int.uniform_noise_min = hp.uniformNoiseMin;
  int.uniform_noise_max = hp.uniformNoiseMax;
  int.uniform_noise_p = hp.uniformNoiseEnabled ? 1.0 : 0;

  // Gaussian noise
  int.gaussian_noise_mean = hp.gaussianNoiseMean;
  int.gaussian_noise_std = hp.gaussianNoiseStd;
  int.gaussian_noise_p = hp.gaussianNoiseEnabled ? 1.0 : 0;

  // Contrast
  int.contrast_min = hp.contrastMin;
  int.contrast_max = hp.contrastMax;
  int.contrast_p = hp.contrastEnabled ? 1.0 : 0;

  // Brightness
  int.brightness_min = hp.brightnessMin;
  int.brightness_max = hp.brightnessMax;
  int.brightness_p = hp.brightnessEnabled ? 1.0 : 0;

  // ZMQ — always on for GUI-launched training, unconditionally.
  //
  // sleap-nn has no boolean for this: `ZMQConfig` is just two Optional ports
  // (+ a polling timeout), each defaulting to None, and a None port means that
  // channel is never attached. So writing the ports IS enabling ZMQ — without
  // them the run has no Stop Early channel and no live loss telemetry, which
  // from the GUI is always a bug, never a choice.
  //
  // Forced here rather than trusted from the profile because this function is
  // the last gate before sleep-nn runs and it also handles USER-IMPORTED
  // configs (TrainingPanel's "load config" → parseYamlConfig), which may carry
  // null ports, or no `zmq:` key at all. The latter is worse than losing
  // telemetry: `buildTrainingArgs` always appends
  // `trainer_config.zmq.controller_port=...` overrides, and Hydra rejects an
  // override for a key missing from a struct config, so an imported config
  // without a `zmq:` block would abort training at parse time. Materializing
  // the block here means the override always has something to land on.
  //
  // Ports come from platform/trainingArgs so the YAML and the CLI overrides
  // (and the Tauri relays that bind them) cannot drift apart.
  const zmq = (trainer.zmq ?? {}) as Record<string, unknown>;
  zmq.controller_port = ZMQ_CONTROLLER_PORT;
  zmq.publish_port = ZMQ_PUBLISH_PORT;
  // Preserve a profile's own polling timeout; supply sleap-nn's default when
  // the key is absent or was left null.
  if (zmq.controller_polling_timeout == null) zmq.controller_polling_timeout = 10;
  trainer.zmq = zmq;

  return yaml.dump(doc, { lineWidth: -1 });
}

// ── Initial state ─────────────────────────────────────────────────

const initialConfig: TrainingConfig = {
  modelType: "top_down",
  configs: [],
  trainingLabelsPath: "",
  validationLabelsPath: "",
};

const initialState = {
  config: { ...initialConfig },
  status: "idle" as TrainingStatus,
  error: null as string | null,
  stderrTail: [] as string[],
  startedAt: null as number | null,
  _stopRequested: false,
  _isRemote: false,
  models: [] as ModelProgress[],
  currentModelIndex: 0,
  wandbUrl: null as string | null,
  modelOutputDirs: [] as string[],
  log: [] as string[],
  pendingHandoff: null as TrainingState["pendingHandoff"],
  postTrainingInference: null as PostTrainingInference | null,
  resetSeq: 0,
};

// ── Store ─────────────────────────────────────────────────────────

export const useTrainingStore = create<TrainingState>()((set, get) => ({
  ...initialState,

  setPendingHandoff: (v) => set({ pendingHandoff: v }),

  setConfig: (key, value) =>
    set((state) => ({
      config: { ...state.config, [key]: value },
    })),

  updateConfigHyperparams: (slot, updates) =>
    set((state) => ({
      config: {
        ...state.config,
        configs: state.config.configs.map((c) =>
          c.slot === slot
            ? { ...c, hyperparams: { ...c.hyperparams, ...updates } }
            : c,
        ),
      },
    })),

  resetConfigHyperparams: (slot) =>
    set((state) => ({
      config: {
        ...state.config,
        configs: state.config.configs.map((c) =>
          c.slot === slot
            ? { ...c, hyperparams: { ...c.originalHyperparams } }
            : c,
        ),
      },
    })),

  updateConfigCheckpointPath: (slot, path) =>
    set((state) => ({
      config: {
        ...state.config,
        configs: state.config.configs.map((c) =>
          c.slot === slot ? { ...c, checkpointPath: path } : c,
        ),
      },
    })),

  addConfigFile: (file) =>
    set((state) => ({
      config: {
        ...state.config,
        configs: [
          ...state.config.configs.filter((c) => c.slot !== file.slot),
          file,
        ],
      },
    })),

  removeConfigFile: (slot) =>
    set((state) => ({
      config: {
        ...state.config,
        configs: state.config.configs.filter((c) => c.slot !== slot),
      },
    })),

  parseYamlConfig: (yamlText: string, filename: string, slot: string, checkpointPath: string | null = null): ConfigFile | null => {
    try {
      const doc = yaml.load(yamlText) as Record<string, unknown>;
      if (!doc || typeof doc !== "object") return null;

      // Strip fields specific to whichever run/machine produced this config,
      // right at load time — unlike accelerator/numDevices/dataPipeline/
      // runName below (which get reset via the *hyperparams* defaults, so
      // applyHyperparamsToYaml naturally overwrites them from hp), skeleton
      // definitions and the disk-image-cache path have no corresponding UI
      // control, so the stored `content` itself must not carry them forward.
      // A stale skeleton belongs to whatever project the config came from
      // (sleap-nn re-derives it from the real training data regardless —
      // see applyHyperparamsToYaml's own belt-and-suspenders clear); a stale
      // cache_img_path could point at another run's (or a nonexistent)
      // directory on this machine. `sanitizedContent` is computed at the end,
      // once head_configs.*.confmaps.part_names (below) has also been cleared.
      if (!doc.data_config || typeof doc.data_config !== "object") {
        doc.data_config = {};
      }
      const rawDataConfig = doc.data_config as Record<string, unknown>;
      rawDataConfig.skeletons = [];
      rawDataConfig.cache_img_path = null;

      // Extract model type from head_configs (same logic as dashboard)
      const trainerConfig = (doc.trainer_config ?? doc.trainer ?? doc) as Record<string, unknown>;
      const modelConfig = (doc.model_config ?? {}) as Record<string, unknown>;
      const headConfigs = (modelConfig.head_configs ?? trainerConfig?.head_configs ?? {}) as Record<string, unknown>;
      const detectedModelType = Object.entries(headConfigs).find(([, v]) => v != null)?.[0] ?? "unknown";

      // part_names (single_instance/centered_instance/bottomup confmaps only —
      // sleap-nn's docstring: "None if nodes from sio.Labels file can be used
      // directly") is an explicit node-name list belonging to whatever
      // project the config came from; only clear it where the key is already
      // present, so heads whose confmaps schema doesn't define it (centroid)
      // don't get an unrecognized field injected.
      for (const headVal of Object.values(headConfigs)) {
        if (headVal && typeof headVal === "object") {
          const confmaps = (headVal as Record<string, unknown>).confmaps;
          if (confmaps && typeof confmaps === "object" && "part_names" in confmaps) {
            (confmaps as Record<string, unknown>).part_names = null;
          }
        }
      }
      const sanitizedContent = yaml.dump(doc, { lineWidth: -1 });

      // Extract per-config hyperparameters
      const trainer = trainerConfig;
      const trainLoader = (trainer.train_data_loader ?? {}) as Record<string, unknown>;
      const optimizer = (trainer.optimizer ?? {}) as Record<string, unknown>;
      const wandb = (trainer.wandb ?? (doc as Record<string, unknown>).wandb ?? {}) as Record<string, unknown>;
      const dataConfig = (doc.data_config ?? {}) as Record<string, unknown>;

      // Detect backbone from backbone_config keys
      const backboneConfig = (modelConfig.backbone_config ?? {}) as Record<string, unknown>;
      const activeBackbone = Object.entries(backboneConfig).find(([, v]) => v != null)?.[0] ?? "";
      const backboneMap: Record<string, Backbone> = {
        "unet": "unet",
        "convnext": "convnext",
        "swint": "swint",
      };

      // Extract early stopping config
      const earlyStopping = (trainer.early_stopping ?? {}) as Record<string, unknown>;

      // Extract preprocessing config
      const preprocessing = (dataConfig.preprocessing ?? {}) as Record<string, unknown>;

      // Extract checkpoint + epoch-end-evaluation config
      const modelCkpt = (trainer.model_ckpt ?? {}) as Record<string, unknown>;
      const evalConfig = (trainer.eval ?? {}) as Record<string, unknown>;

      // Extract LR scheduler config — priority order mirrors sleap-nn's own
      // (lightning_modules.py: cosine > linear > step_lr > reduce_on_plateau).
      const lrSchedulerCfg = (trainer.lr_scheduler ?? {}) as Record<string, unknown>;
      const stepLRCfg = (lrSchedulerCfg.step_lr ?? {}) as Record<string, unknown>;
      const reduceLRCfg = (lrSchedulerCfg.reduce_lr_on_plateau ?? {}) as Record<string, unknown>;
      const cosineLRCfg = (lrSchedulerCfg.cosine_annealing_warmup ?? {}) as Record<string, unknown>;
      const linearLRCfg = (lrSchedulerCfg.linear_warmup_linear_decay ?? {}) as Record<string, unknown>;
      const lrSchedulerType: ConfigHyperparams["lrSchedulerType"] =
        lrSchedulerCfg.cosine_annealing_warmup != null
          ? "cosine_annealing_warmup"
          : lrSchedulerCfg.linear_warmup_linear_decay != null
            ? "linear_warmup_linear_decay"
            : lrSchedulerCfg.step_lr != null
              ? "step_lr"
              : lrSchedulerCfg.reduce_lr_on_plateau != null
                ? "reduce_lr_on_plateau"
                : "none";

      // Extract online hard keypoint mining config
      const ohkmCfg = (trainer.online_hard_keypoint_mining ?? {}) as Record<string, unknown>;

      // Extract sigma from head configs (first head's sigma value)
      let sigma = 5.0;
      for (const headVal of Object.values(headConfigs)) {
        if (headVal && typeof headVal === "object") {
          const head = headVal as Record<string, unknown>;
          if (typeof head.sigma === "number") { sigma = head.sigma; break; }
          // Bottom-up has nested confmaps.sigma
          const confmaps = head.confmaps as Record<string, unknown> | undefined;
          if (confmaps && typeof confmaps.sigma === "number") { sigma = confmaps.sigma; break; }
        }
      }

      const hasTrainedModel = typeof trainer.run_name === "string" && trainer.run_name.length > 0;

      // Detect which mode actually produced this config, so re-auto-loading
      // the just-completed run's own written training_config.yaml (e.g. on
      // "Train Again") reflects what was really used instead of always
      // reverting to "reuse_config" — sleap-nn's own config log for the run
      // still has resume_ckpt_path/pretrained_*_weights populated even though
      // parseYamlConfig doesn't strip those two (unlike skeletons/
      // cache_img_path/part_names above): they're the exact fields
      // applyHyperparamsToYaml re-derives from trainingMode + checkpointPath
      // on every apply, so leaving them in `content` is harmless either way.
      const detectedTrainingMode: ConfigHyperparams["trainingMode"] =
        typeof trainer.resume_ckpt_path === "string" && trainer.resume_ckpt_path.length > 0
          ? "resume"
          : typeof modelConfig.pretrained_backbone_weights === "string" &&
              (modelConfig.pretrained_backbone_weights as string).length > 0
            ? "finetune"
            : "reuse_config";

      // Extract backbone model params
      const unetConfig = (backboneConfig[activeBackbone.toLowerCase()] ?? {}) as Record<string, unknown>;

      // Extract output_stride, anchor_part and centroid_source from head configs
      let outputStride = 2;
      let anchorPart: string | null = null;
      let centroidSource: "user" | "computed" | null = null;
      const readCentroidSource = (v: unknown) => {
        if (v === "user" || v === "computed") centroidSource = v;
      };
      for (const headVal of Object.values(headConfigs)) {
        if (headVal && typeof headVal === "object") {
          const head = headVal as Record<string, unknown>;
          if (typeof head.output_stride === "number") outputStride = head.output_stride;
          if (typeof head.anchor_part === "string") anchorPart = head.anchor_part;
          readCentroidSource(head.centroid_source);
          const confmaps = head.confmaps as Record<string, unknown> | undefined;
          if (confmaps) {
            if (typeof confmaps.output_stride === "number") outputStride = confmaps.output_stride;
            if (typeof confmaps.anchor_part === "string") anchorPart = confmaps.anchor_part;
            readCentroidSource(confmaps.centroid_source);
          }
        }
      }

      // Extract loss weights from head configs
      let confmapsLossWeight = 1.0;
      let pafsLossWeight = 1.0;
      let classLossWeight = 1.0;
      for (const headVal of Object.values(headConfigs)) {
        if (headVal && typeof headVal === "object") {
          const head = headVal as Record<string, unknown>;
          const confmaps = head.confmaps as Record<string, unknown> | undefined;
          const pafs = head.pafs as Record<string, unknown> | undefined;
          const classVectors = head.class_vectors as Record<string, unknown> | undefined;
          const classMaps = head.class_maps as Record<string, unknown> | undefined;
          if (confmaps && typeof confmaps.loss_weight === "number") confmapsLossWeight = confmaps.loss_weight;
          if (pafs && typeof pafs.loss_weight === "number") pafsLossWeight = pafs.loss_weight;
          if (classVectors && typeof classVectors.loss_weight === "number") classLossWeight = classVectors.loss_weight;
          if (classMaps && typeof classMaps.loss_weight === "number") classLossWeight = classMaps.loss_weight;
          // Single-head types: top-level loss_weight
          if (!confmaps && !pafs && !classVectors && !classMaps && typeof head.loss_weight === "number") {
            confmapsLossWeight = head.loss_weight;
          }
        }
      }

      // Augmentation reverse-map
      const augCfg = (dataConfig.augmentation_config ?? {}) as Record<string, unknown>;
      const geoCfg = (augCfg.geometric ?? {}) as Record<string, unknown>;
      const intCfg = (augCfg.intensity ?? {}) as Record<string, unknown>;

      const rotMin = typeof geoCfg.rotation_min === "number" ? geoCfg.rotation_min : -180;
      const rotMax = typeof geoCfg.rotation_max === "number" ? geoCfg.rotation_max : 180;
      const affineP = typeof geoCfg.affine_p === "number" ? geoCfg.affine_p : 1.0;

      let rotationPreset: "off" | "15" | "180" | "custom" = "180";
      if (affineP === 0 || (rotMin === 0 && rotMax === 0)) {
        rotationPreset = "off";
      } else if (Math.abs(rotMin) === 15 && Math.abs(rotMax) === 15) {
        rotationPreset = "15";
      } else if (Math.abs(rotMin) === 180 && Math.abs(rotMax) === 180) {
        rotationPreset = "180";
      } else {
        rotationPreset = "custom";
      }

      const scaleMinVal = typeof geoCfg.scale_min === "number" ? geoCfg.scale_min : 1.0;
      const scaleMaxVal = typeof geoCfg.scale_max === "number" ? geoCfg.scale_max : 1.0;
      const scaleEnabled = scaleMinVal !== 1.0 || scaleMaxVal !== 1.0;

      const gaussP = typeof intCfg.gaussian_noise_p === "number" ? intCfg.gaussian_noise_p : 0;
      const uniformP = typeof intCfg.uniform_noise_p === "number" ? intCfg.uniform_noise_p : 0;
      const contrastP = typeof intCfg.contrast_p === "number" ? intCfg.contrast_p : 0;
      const brightnessP = typeof intCfg.brightness_p === "number" ? intCfg.brightness_p : 0;

      const hyperparams: ConfigHyperparams = {
        backbone: backboneMap[activeBackbone.toLowerCase()] ?? "",
        maxEpochs: typeof trainer.max_epochs === "number" ? trainer.max_epochs : 100,
        batchSize: typeof trainLoader.batch_size === "number" ? trainLoader.batch_size
          : typeof trainer.batch_size === "number" ? trainer.batch_size : 4,
        learningRate: typeof optimizer.lr === "number" ? optimizer.lr
          : typeof trainer.learning_rate === "number" ? trainer.learning_rate : 0.0001,
        // Always blank on import — a run name should be freshly auto-generated
        // for a new run, never leak in from whatever profile was uploaded
        // (mirrors legacy SLEAP's TrainingEditorWidget._load_config, which
        // force-clears trainer_config.run_name for the same reason). Note
        // `hasTrainedModel` below is still derived from the raw parsed value,
        // since detecting "this file is from a completed run" is a distinct
        // concern from "what should the run name FIELD show."
        runName: "",
        useWandb: trainer.use_wandb === true,
        wandbEntity: typeof wandb.entity === "string" ? wandb.entity : "",
        wandbProject: typeof wandb.project === "string" ? wandb.project : "",
        validationFraction: typeof dataConfig.validation_fraction === "number"
          ? dataConfig.validation_fraction : 0.1,
        overfitMode: dataConfig.use_same_data_for_val === true,
        earlyStoppingPatience: typeof earlyStopping.patience === "number"
          ? earlyStopping.patience : 10,
        sigma,
        scale: typeof preprocessing.scale === "number" ? preprocessing.scale : 1.0,
        stemStride: typeof unetConfig.stem_stride === "number" ? unetConfig.stem_stride : null,
        maxStride: typeof unetConfig.max_stride === "number" ? unetConfig.max_stride : 16,
        filters: typeof unetConfig.filters === "number" ? unetConfig.filters : 16,
        filtersRate: typeof unetConfig.filters_rate === "number" ? unetConfig.filters_rate : 2.0,
        middleBlock: typeof unetConfig.middle_block === "boolean" ? unetConfig.middle_block : true,
        upInterpolate: typeof unetConfig.up_interpolate === "boolean" ? unetConfig.up_interpolate : true,
        outputStride,
        anchorPart,
        centroidSource,
        confmapsLossWeight,
        pafsLossWeight,
        classLossWeight,
        rotationPreset,
        rotationCustomAngle: rotationPreset === "custom" ? Math.abs(rotMax) : 45,
        scaleEnabled,
        scaleMin: typeof geoCfg.scale_min === "number" ? geoCfg.scale_min : 0.9,
        scaleMax: typeof geoCfg.scale_max === "number" ? geoCfg.scale_max : 1.1,
        uniformNoiseEnabled: uniformP > 0,
        uniformNoiseMin: typeof intCfg.uniform_noise_min === "number" ? intCfg.uniform_noise_min : 0.0,
        uniformNoiseMax: typeof intCfg.uniform_noise_max === "number" ? intCfg.uniform_noise_max : 0.1,
        gaussianNoiseEnabled: gaussP > 0,
        gaussianNoiseMean: typeof intCfg.gaussian_noise_mean === "number" ? intCfg.gaussian_noise_mean : 0.0,
        gaussianNoiseStd: typeof intCfg.gaussian_noise_std === "number" ? intCfg.gaussian_noise_std : 0.04,
        contrastEnabled: contrastP > 0,
        contrastMin: typeof intCfg.contrast_min === "number" ? intCfg.contrast_min : 0.5,
        contrastMax: typeof intCfg.contrast_max === "number" ? intCfg.contrast_max : 2.0,
        brightnessEnabled: brightnessP > 0,
        brightnessMin: typeof intCfg.brightness_min === "number" ? intCfg.brightness_min : 0.0,
        brightnessMax: typeof intCfg.brightness_max === "number" ? intCfg.brightness_max : 0.2,
        cropSize: typeof preprocessing.crop_size === "number" ? preprocessing.crop_size : null,
        randomSeed: typeof trainer.seed === "number" ? trainer.seed : null,
        stopOnPlateau: earlyStopping.stop_training_on_plateau !== false,
        plateauMinDelta: typeof earlyStopping.min_delta === "number" ? earlyStopping.min_delta : 1e-08,
        onlineMining: ohkmCfg.online_mining === true,
        minHardKeypoints: typeof ohkmCfg.min_hard_keypoints === "number" ? ohkmCfg.min_hard_keypoints : 2,
        maxHardKeypoints: typeof ohkmCfg.max_hard_keypoints === "number" ? ohkmCfg.max_hard_keypoints : null,
        hardToEasyRatio: typeof ohkmCfg.hard_to_easy_ratio === "number" ? ohkmCfg.hard_to_easy_ratio : 2.0,
        lossScale: typeof ohkmCfg.loss_scale === "number" ? ohkmCfg.loss_scale : 5.0,
        lrSchedulerType,
        stepLRStepSize: typeof stepLRCfg.step_size === "number" ? stepLRCfg.step_size : 10,
        stepLRGamma: typeof stepLRCfg.gamma === "number" ? stepLRCfg.gamma : 0.1,
        reduceLRThreshold: typeof reduceLRCfg.threshold === "number" ? reduceLRCfg.threshold : 1e-6,
        reduceLRThresholdMode: reduceLRCfg.threshold_mode === "rel" ? "rel" : "abs",
        reduceLRCooldown: typeof reduceLRCfg.cooldown === "number" ? reduceLRCfg.cooldown : 3,
        reduceLRPatience: typeof reduceLRCfg.patience === "number" ? reduceLRCfg.patience : 5,
        reduceLRFactor: typeof reduceLRCfg.factor === "number" ? reduceLRCfg.factor : 0.5,
        reduceLRMinLR: typeof reduceLRCfg.min_lr === "number" ? reduceLRCfg.min_lr : 1e-8,
        cosineWarmupEpochs: typeof cosineLRCfg.warmup_epochs === "number" ? cosineLRCfg.warmup_epochs : 5,
        cosineWarmupStartLR: typeof cosineLRCfg.warmup_start_lr === "number" ? cosineLRCfg.warmup_start_lr : 0.0,
        cosineEtaMin: typeof cosineLRCfg.eta_min === "number" ? cosineLRCfg.eta_min : 0.0,
        linearWarmupEpochs: typeof linearLRCfg.warmup_epochs === "number" ? linearLRCfg.warmup_epochs : 5,
        linearWarmupStartLR: typeof linearLRCfg.warmup_start_lr === "number" ? linearLRCfg.warmup_start_lr : 0.0,
        linearEndLR: typeof linearLRCfg.end_lr === "number" ? linearLRCfg.end_lr : 0.0,
        trainingMode: detectedTrainingMode,
        // Performance/machine-specific settings — never taken from the
        // uploaded file, always the app's own defaults. A profile trained on
        // someone else's machine (e.g. `trainer_accelerator: mps` from a Mac,
        // or a data_pipeline_fw/num_workers tuned for a different machine's
        // RAM/disk/CPU) shouldn't silently populate these here (same
        // rationale as legacy's `_load_config` stripping accelerator/devices/
        // workers as "system_specific_keys" — dataPipeline gets the same
        // treatment for the same reason, even though legacy doesn't call it
        // out by that name).
        accelerator: defaultHyperparams.accelerator,
        trainerStrategy: defaultHyperparams.trainerStrategy,
        dataPipeline: defaultHyperparams.dataPipeline,
        dataloaderWorkers: defaultHyperparams.dataloaderWorkers,
        numDevices: defaultHyperparams.numDevices,
        // Checkpoint saving — sleap-nn's own default is save_top_k=1 (best
        // model on), save_last=None (off), so an absent key means "on"/"off"
        // respectively, matching those real defaults.
        saveBestModel: typeof modelCkpt.save_top_k === "number" ? modelCkpt.save_top_k !== 0 : true,
        saveLastModel: modelCkpt.save_last === true,
        saveTopKCount:
          typeof modelCkpt.save_top_k === "number" && modelCkpt.save_top_k !== 0
            ? modelCkpt.save_top_k
            : 1,
        checkpointMonitor: typeof modelCkpt.monitor === "string" ? modelCkpt.monitor : "val/loss",
        checkpointMode: modelCkpt.mode === "max" ? "max" : "min",
        // Visualization — absent means "on" here (this app's own default,
        // not sleap-nn's raw False default — see defaultHyperparams above).
        visualizePredictions: trainer.visualize_preds_during_training !== false,
        keepVizImages: trainer.keep_viz !== false,
        colorMode: preprocessing.ensure_rgb === true
          ? "rgb"
          : preprocessing.ensure_grayscale === true
            ? "grayscale"
            : "auto",
        evalEnabled: evalConfig.enabled === true,
        evalFrequency: typeof evalConfig.frequency === "number" ? evalConfig.frequency : 1,
        evalOksStddev: typeof evalConfig.oks_stddev === "number" ? evalConfig.oks_stddev : 0.025,
        evalOksScale: typeof evalConfig.oks_scale === "number" ? evalConfig.oks_scale : null,
        evalMatchThreshold: typeof evalConfig.match_threshold === "number" ? evalConfig.match_threshold : 50.0,
        wandbUploadViz: wandb.save_viz_imgs_wandb === true,
        wandbPrevRunId: typeof wandb.prv_runid === "string" ? wandb.prv_runid : "",
        wandbGroup: typeof wandb.group === "string" ? wandb.group : "",
        wandbMode: wandb.wandb_mode === "offline" ? "offline" : "online",
        wandbApiKey: typeof wandb.api_key === "string" ? wandb.api_key : "",
      };

      // Deliberately NOT auto-filling trainingLabelsPath/validationLabelsPath
      // from the uploaded config's data_config.*_labels_path here — those are
      // specific to whatever machine/project the config came from (same
      // "machine/session-specific, never taken from the file" rationale as
      // runName/accelerator/numDevices above). Training data should always
      // come from the currently loaded project, not a stale path baked into
      // an imported profile.

      return {
        filename,
        content: sanitizedContent,
        modelType: detectedModelType,
        slot,
        hyperparams,
        originalHyperparams: { ...hyperparams },
        hasTrainedModel,
        checkpointPath,
      };
    } catch (err) {
      console.warn("[training] Failed to parse YAML:", err);
      return null;
    }
  },

  reset: () =>
    set((state) => ({
      ...initialState,
      config: { ...initialConfig },
      resetSeq: state.resetSeq + 1,
    })),

  startTraining: async (opts?: RemoteTrainingOptions | LocalTrainingOptions) => {
    const remoteOpts = opts && "remote" in opts ? opts : undefined;
    const localOpts = opts && !("remote" in opts) ? opts as LocalTrainingOptions : undefined;
    const { config } = get();

    // Build model progress entries from per-config hyperparams
    const slots = getConfigSlots(config.modelType);
    const models: ModelProgress[] = slots.map((slot) => {
      const cf = config.configs.find((c) => c.slot === slot);
      return {
        ...emptyModelProgress(getSlotLabel(slot).replace(" Config", ""), cf?.hyperparams.maxEpochs ?? 100),
        plateauPatience: cf?.hyperparams.earlyStoppingPatience ?? null,
        plateauMinDelta: cf?.hyperparams.plateauMinDelta ?? null,
      };
    });

    set({
      status: "running",
      error: null,
      stderrTail: [],
      startedAt: Date.now(),
      _stopRequested: false,
      _isRemote: !!remoteOpts?.remote,
      models,
      currentModelIndex: 0,
      wandbUrl: null,
      modelOutputDirs: [],
      log: [],
      postTrainingInference: null,
    });

    if (remoteOpts?.remote) {
      // ── Remote training via sleap-connect worker ──────────
      const { useConnectStore, pathRulesFor } = await import("@/stores/connectStore");
      const { submitJob, workerMounts: mounts, statWorkerPath } = useConnectStore.getState();
      const { toast } = await import("@/lib/notify");
      const workerLabel = () =>
        (useConnectStore.getState().pairedWorkers ?? []).find((w) => w.nodeId === remoteOpts.workerId)?.label ??
        remoteOpts.workerId;

      const { useAppStore } = await import("@/stores/appStore");
      const { labels, projectPath } = useAppStore.getState();

      const { projectTag } = await import("@/lib/projectTag");
      const project = projectTag(projectPath);

      // Which videos get post-training inference. `undefined` = unrestricted
      // (every video) — the "worker-file" default and most "window" runs;
      // only narrowed below when sending labels content and the worker can't
      // see every video.
      let allowedVideoIndices: number[] | undefined;
      let labelsPathField: string | undefined;
      let labelsContentField: string | null | undefined;

      if (remoteOpts.labelsSource === "worker-file") {
        // Pre-PR3 behavior, unchanged: a path the worker can already read
        // directly — no visibility check, no embedding, nothing to restrict.
        labelsPathField = remoteOpts.workerLabelsPath;
      } else {
        // "window": send THIS window's own labels (unsaved edits included).
        // A video the worker can already see is referenced by its worker
        // path; one it can't is embedded (labeled frames only — never the
        // full video) so training still has pixels to learn from. See
        // remoteVisibility.ts / remoteLabelsPayload.ts for the mechanics.
        if (!labels) {
          set({ status: "error", error: "No project loaded to train from" });
          return;
        }

        const { projectVideoPaths, checkVideoVisibility } = await import("@/lib/remoteVisibility");
        const { buildRemoteLabelsPayload } = await import("@/lib/remoteLabelsPayload");

        let visibility = remoteOpts.visibility;
        if (!visibility) {
          visibility = await checkVideoVisibility(projectVideoPaths(labels), {
            rules: pathRulesFor(remoteOpts.workerId),
            mounts: mounts.map((m) => m.path),
            stat: (p) => statWorkerPath(p).then((r) => r.exists),
          });
        }

        const embedFramesToPredict = !!remoteOpts.embedFramesToPredict;
        let payload: Awaited<ReturnType<typeof buildRemoteLabelsPayload>>;
        try {
          payload = await buildRemoteLabelsPayload(labels, visibility, { embedFramesToPredict });
        } catch (err) {
          // A real decode+encode path (one getFrame+PNG-encode per labeled
          // frame of a hidden video — see collectEncodedFrames) with real
          // failure modes (an unreadable video backend, a corrupt frame).
          // Left uncaught, `status` would stay stuck at "running" forever
          // (set above, before this block) with nothing downstream to reset
          // it — the UI would show an endless in-progress spinner for a
          // failure that never even reached the worker.
          set({
            status: "error",
            error: `Failed to prepare labels for the worker: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        if (payload.bytes > LABELS_EMBED_HARD_CAP_BYTES) {
          set({
            status: "error",
            error:
              `This project's labeled frames are too large to send inline ` +
              `(${formatBytes(payload.bytes)}, over the ${formatBytes(LABELS_EMBED_HARD_CAP_BYTES)} cap) ` +
              `since the worker can't see one or more of the videos directly. Place them on storage the ` +
              `worker can access, or locate them on the worker, then try again.`,
          });
          return;
        }

        if (payload.bytes > LABELS_EMBED_WARN_BYTES) {
          const frameCount = countUserLabeledFrames(labels);
          const proceed = await confirmDialog({
            title: "Large upload",
            message:
              `Sending ${frameCount ?? "all"} labeled frames inline (~${formatBytes(payload.bytes)}), ` +
              `since the worker can't see one or more of the videos directly. This may take a while.\n\n` +
              `If the worker can reach these videos on shared storage instead, cancel and locate them ` +
              `there for a faster, lighter submission.`,
            confirmLabel: "Send anyway",
            cancelLabel: "Cancel",
          });
          if (!proceed) {
            set({ status: "idle" });
            return;
          }
        }

        if (payload.unavailableVideos.length > 0) {
          const n = payload.unavailableVideos.length;
          const proceed = await confirmDialog({
            title: "Some videos can't be read",
            message: `${n} video${n === 1 ? "" : "s"} can't be read here or on the worker; their frames will be skipped. Train anyway?`,
            confirmLabel: "Train anyway",
            cancelLabel: "Cancel",
          });
          if (!proceed) {
            set({ status: "idle" });
            return;
          }
        }

        labelsContentField = payload.labelsContent;

        // Post-training inference coverage: every video visible, or
        // embedding "frames to predict" for a suggestions-only run, means
        // the worker ends up with pixels for every video — nothing to
        // restrict. Otherwise only the videos the worker can actually see
        // (not embedded) get inference.
        const allVisible = visibility.every((v) => v.visible);
        const embedsEverythingForSuggestions =
          embedFramesToPredict && remoteOpts.inferenceTarget === "suggestions";
        if (!allVisible && !embedsEverythingForSuggestions) {
          allowedVideoIndices = visibility.filter((v) => v.visible).map((v) => v.index);
        }
      }

      // Build TrainJobSpec — apply hyperparam overrides to YAML. See
      // resolveRemoteRunName/resolveRemoteMaxStride's own docs for why these
      // must be resolved client-side before serializing. `runTimestamp` is
      // shared across every model below so a split multi-model pipeline's
      // run names all carry the exact same timestamp.
      const runTimestamp = formatRunTimestamp();
      const remoteDetectedChannels = detectVideoChannels(labels);

      // Jobs are submitted (and, for a multi-model pipeline, split) in
      // `config_contents` order, so build it in slot order: job i then
      // trains model i (`models[i]`), and its worker-side model dir lands at
      // position i of the post-training track job's `model_paths` — the
      // pipeline order sleap-nn expects (centroid before centered_instance).
      const orderedConfigs = slots
        .map((slot) => config.configs.find((c) => c.slot === slot))
        .filter((c): c is ConfigFile => !!c);

      const spec: TrainJobSpec = {
        type: "train",
        config_contents: orderedConfigs.map((c) =>
          applyHyperparamsToYaml(
            c.content,
            {
              ...c.hyperparams,
              runName: resolveRemoteRunName(c.hyperparams, c.modelType, labels, { runTimestamp }),
            },
            c.checkpointPath,
            resolveRemoteMaxStride(c.hyperparams, labels),
            resolveInputChannels(c.hyperparams.colorMode, remoteDetectedChannels),
          ),
        ),
        model_types: orderedConfigs.map((c) => c.modelType),
        labels_path: labelsPathField,
        labels_content: labelsContentField,
        val_labels_path: remoteOpts.valLabelsPath || undefined,
        project,
      };

      set((state) => ({
        models: state.models.map((m, i) =>
          i === 0 ? { ...m, status: "running" as const } : m,
        ),
      }));

      // Worker job.log lines take the same buffered, coalesced path as local
      // stdout (one store update per flush, never per line).
      const logFlusher = createLogFlusher(set, get);
      const onLogLine = (line: string, isProgress?: boolean) => {
        if (line.includes("wandb.ai/")) {
          const urlMatch = line.match(/(https:\/\/wandb\.ai\/[^\s"}\]>)]+)/);
          if (urlMatch && get().wandbUrl !== urlMatch[1]) set({ wandbUrl: urlMatch[1] });
        }
        logFlusher.push(line, isProgress);
      };

      try {
        const trainResults: JobResult[] = [];
        const result = await submitJob(spec, onLogLine, {
          onTelemetry: (telemetry, jobIndex) => get().applyRemoteTelemetry(jobIndex, telemetry),
          onModelComplete: (modelResult) => {
            trainResults.push(modelResult);
            // Attribute lines still buffered from the finished model to it,
            // before the current model advances.
            logFlusher.flush(get().currentModelIndex);
            set((s) => {
              const idx = s.currentModelIndex;
              const nextIdx = idx + 1;
              return {
                currentModelIndex: nextIdx,
                models: s.models.map((m, i) =>
                  i === idx && m.status === "running"
                    ? { ...m, status: "completed" as const }
                    : i === nextIdx && m.status === "pending"
                      ? { ...m, status: "running" as const }
                      : m,
                ),
                log: appendLog(s.log, `— ${s.models[idx]?.label} completed, starting ${s.models[nextIdx]?.label ?? "next model"}...`),
              };
            });
          },
        });
        logFlusher.flush();

        if (!result.success) {
          const message = result.error || "Training failed";
          set((s) => ({
            status: "error",
            error: message,
            models: s.models.map((m) =>
              m.status === "running"
                ? { ...m, status: "failed" as const }
                : m,
            ),
          }));
          toast.error(`Training on ${workerLabel()} failed`, { description: message });
          return;
        }
        trainResults.push(result);

        // Only mark models that actually ran as completed; leave pending
        // models as-is (e.g. after stop early).
        set((s) => ({
          models: s.models.map((m) =>
            m.status === "running"
              ? { ...m, status: "completed" as const }
              : m,
          ),
        }));

        // ── Post-training inference (separate track job) ──────
        // The worker never runs inference inside a train job. Once every
        // model has trained, submit one track job against the labels file
        // the worker trained on, with every trained model in pipeline order.
        // A centroid-only (locator) run is skipped, as on the local path: it
        // has no pose pipeline to run, and would mis-route to top-down.
        const inferenceTarget = remoteOpts.inferenceTarget;
        if (inferenceTarget && inferenceTarget !== "nothing" && config.modelType !== "centroid") {
          if (allowedVideoIndices?.length === 0) {
            // "window" mode restricted coverage to visible videos, and none
            // are — no point submitting a track job for nothing.
            const message = "Videos aren't visible on the worker — inference skipped";
            set((s) => ({
              postTrainingInference: { status: "skipped", message, pendingMerge: null, merged: false },
              log: appendLog(s.log, `— ${message}`),
            }));
          } else {
          const modelDirs = trainResults.map((r) => r.modelDir);
          const dataPath = trainResults.find((r) => r.labelsPath)?.labelsPath;
          if (modelDirs.some((d) => !d) || !dataPath) {
            const message =
              "Post-training inference skipped: the worker didn't report the trained model " +
              "location (it may need updating). Run inference from the Inference panel instead.";
            set((s) => ({
              postTrainingInference: { status: "skipped", message, pendingMerge: null, merged: false },
              log: appendLog(s.log, `— ${message}`),
            }));
          } else {
            const { video, frameIdx } = useAppStore.getState();
            const inferenceConfig = buildPostTrainingInferenceConfig({
              modelType: config.modelType,
              modelPaths: modelDirs as string[],
              inferenceTarget,
              videoIndex:
                inferenceTarget === "video" || inferenceTarget === "random_video"
                  ? labels && video ? Math.max(0, labels.videos.indexOf(video)) : 0
                  : "all",
              sampleCount: remoteOpts.sampleCount,
              skipUserLabeled: remoteOpts.skipUserLabeled,
              existingPredictions: remoteOpts.existingPredictions,
            });
            // Worker-file training's actual video list/frame counts live
            // only on the worker — this window may have no project open at
            // all, or a completely unrelated one — so `videoFrameCounts`
            // below must come from the worker-side file itself, not
            // whatever `labels` the open project happens to be. "window"
            // mode is unaffected: there, `labels` IS the data the worker
            // trained on.
            let frameCountLabels = labels;
            if (remoteOpts.labelsSource === "worker-file" && labelsPathField) {
              try {
                const client = await useConnectStore.getState().clientFor(remoteOpts.workerId);
                const { loadWorkerLabels } = await import("@/lib/workerLabels");
                frameCountLabels = await loadWorkerLabels(client, labelsPathField);
              } catch {
                // Keep whatever `labels` already was (if anything) as a
                // fallback — an imperfect frame count beats blocking
                // post-training inference entirely.
              }
            }
            // No path_mappings: the train labels payload already carries
            // fully-resolved video references (worker paths, or embedded
            // pixels) — there's nothing left for the worker to translate.
            const trackSpecs = buildRemoteTrackSpecs(inferenceConfig, {
              dataPath,
              pathMappings: {},
              videoFrameCounts: (frameCountLabels?.videos ?? []).map((v) => v.shape?.[0] ?? 0),
              currentFrameIdx: frameIdx ?? 0,
              activeVideoFrameCount: video?.shape?.[0] ?? 0,
              allowedVideoIndices,
            }).map((trackSpec) => ({ ...trackSpec, project }));
            set((s) => ({
              postTrainingInference: { status: "running", message: null, pendingMerge: null, merged: false },
              log: appendLog(s.log, `— Running inference (${inferenceTarget}) on the worker with models: ${modelDirs.join(", ")}...`),
            }));
            try {
              // Tag this track job with the training run's own id (`result.runId`,
              // set by `connectStore.submitJob` above) so the Connect window's
              // Jobs tab groups it under that training run instead of showing
              // it as an unrelated card — the same grouping the worker's own
              // `post_inference` chaining (sleap-connect PR5w) gets for free.
              const inferRunOpts = result.runId
                ? { run: { id: result.runId, stage: "inference" as const } }
                : undefined;
              const inferResults: JobResult[] = [];
              for (const trackSpec of trackSpecs) {
                const r = await submitJob(trackSpec, onLogLine, inferRunOpts);
                if (!r.success) throw new Error(r.error || "inference job failed");
                inferResults.push(r);
              }
              logFlusher.flush();
              set((s) => ({
                postTrainingInference: {
                  status: "completed",
                  message: null,
                  // Not merged automatically — see PostTrainingInference.
                  pendingMerge: {
                    results: inferResults,
                    mode: inferenceConfig.existingPredictions,
                    trackOnly: false,
                  },
                  merged: false,
                },
                log: appendLog(s.log, "— Inference complete. Use Fetch & Load to merge the predictions into the project."),
              }));
            } catch (e) {
              logFlusher.flush();
              const message = `Post-training inference failed: ${e instanceof Error ? e.message : String(e)}`;
              set((s) => ({
                postTrainingInference: { status: "error", message, pendingMerge: null, merged: false },
                log: appendLog(s.log, `— ${message}`),
              }));
            }
          }
          }
        }

        // A cancel during the inference job already set the terminal status.
        if (get().status === "running") {
          set({ status: "completed" });
          const pti = get().postTrainingInference;
          const pending = pti?.pendingMerge ?? null;
          toast.success(`Training on ${workerLabel()} finished`, {
            description:
              pti?.message ??
              `${trainResults.length} model${trainResults.length === 1 ? "" : "s"} trained.`,
            action: pending
              ? { label: "Fetch & Load", onClick: () => { void get().fetchAndLoadPostTrainingPredictions(); } }
              : undefined,
          });
        }
      } catch (e) {
        const message = `Remote training error: ${e instanceof Error ? e.message : String(e)}`;
        set({ status: "error", error: message });
        toast.error(`Training on ${workerLabel()} failed`, { description: message });
      } finally {
        logFlusher.stop();
      }
    } else {
      // ── Local training via subprocess ─────────────────────
      if (!isTauri) {
        set({ status: "error", error: "Training requires the desktop app" });
        return;
      }

      const { runTraining, startZmqRelay, stopZmqRelay, startProgressRelay, stopProgressRelay, listenTrainingProgress } = await import("@/platform/backend");
      const labelsPath = config.trainingLabelsPath || (await import("@/stores/appStore")).useAppStore.getState().projectPath || "";
      if (!labelsPath) {
        set({ status: "error", error: "No training labels file selected" });
        return;
      }

      // Save models next to the labels file
      const modelDir = labelsPath.replace(/[/\\][^/\\]+$/, "") + "/models";
      const trainedModelPaths: string[] = [];

      // Ensure sleap-nn's [export] support is installed BEFORE training when the
      // user picked an export format, so a long run isn't wasted on a missing
      // exporter. Confirmed once per session; failure is non-fatal (training still
      // runs; the post-training export just logs a failure).
      if (localOpts?.exportFormat && localOpts.exportFormat !== "none") {
        const needTrt = localOpts.exportFormat === "tensorrt";
        const already = exportSupportEnsured.onnx && (!needTrt || exportSupportEnsured.tensorrt);
        if (!already) {
          const { useEnvironmentStore } = await import("@/stores/environmentStore");
          // Ask what's actually installed first. The probe costs a bare
          // interpreter start (no torch import), which is nothing next to the
          // multi-minute tool reinstall it usually lets us skip — previously
          // every session's first format-selected run paid that reinstall even
          // with the extras already present.
          await useEnvironmentStore.getState().detectExtras();
          const have = useEnvironmentStore.getState().extras;
          const satisfied =
            !!have && !have.error && have.onnx && (!needTrt || have.tensorrt);
          if (satisfied) {
            exportSupportEnsured = { onnx: true, tensorrt: exportSupportEnsured.tensorrt || have!.tensorrt };
            set((s) => ({ log: appendLog(s.log, `— sleap-nn ${needTrt ? "ONNX + TensorRT" : "ONNX"} export support already installed.`) }));
          } else {
            set((s) => ({ log: appendLog(s.log, `— Ensuring sleap-nn ${needTrt ? "ONNX + TensorRT" : "ONNX"} export support is installed...`) }));
            await useEnvironmentStore.getState().installExportExtra(needTrt);
            if (useEnvironmentStore.getState().installStatus === "done") {
              exportSupportEnsured = { onnx: true, tensorrt: exportSupportEnsured.tensorrt || needTrt };
              set((s) => ({ log: appendLog(s.log, "— Export support ready.") }));
            } else {
              set((s) => ({ log: appendLog(s.log, "— Export support install failed — training will proceed; export may fail.") }));
            }
          }
        }
      }

      // Holder for the ZMQ progress-relay subscription; cleaned up in finally.
      let unlistenProgress: (() => void) | null = null;
      const batchBuffer: { epoch: number; batch: number; loss: number }[] = [];
      let batchFlushTimer: ReturnType<typeof setInterval> | null = null;

      // sleap-nn's tqdm progress bar repaints via carriage return many times/sec, and
      // Tauri splits stdout on \r, so each repaint arrives as its own line event —
      // buffered and coalesced by the shared log flusher, never set() per line.
      const logFlusher = createLogFlusher(set, get);
      // Recent stderr lines only, to surface the real cause in the error banner.
      const stderrTail: string[] = [];

      // Start ZMQ relay so sleap-nn can receive stop commands
      try {
        await startZmqRelay();
        console.log("[training] ZMQ relay started on port 9000");

        // Live loss telemetry: subscribe to sleap-nn's ZMQ progress (epoch loss)
        // relayed by the Rust SUB relay, and feed it into the per-model time-series.
        await startProgressRelay();
        unlistenProgress = await listenTrainingProgress((msg) => {
          let data: { event?: string; epoch?: number; batch?: number; wandb_url?: string; logs?: Record<string, number> };
          try {
            data = JSON.parse(msg);
          } catch {
            return;
          }
          const i = get().currentModelIndex;
          const ev = data.event;
          if (ev === "epoch_begin") {
            if (typeof data.epoch === "number") get().markEpochBegin(i, data.epoch);
          } else if (ev === "epoch_end") {
            // Flush buffered batches first so epochSize (from lastBatchNumber) is fresh.
            if (batchBuffer.length > 0) {
              get().recordBatches(get().currentModelIndex, batchBuffer.splice(0, batchBuffer.length));
            }
            const logs = data.logs ?? {};
            const trainLoss = logs["train/loss"] ?? logs["loss"] ?? null;
            const valLoss = logs["val/loss"] ?? null;
            if (typeof data.epoch === "number") {
              get().recordEpoch(i, { epoch: data.epoch, trainLoss, valLoss });
            }
          } else if (ev === "train_begin") {
            if (data.wandb_url) set({ wandbUrl: data.wandb_url });
          } else if (ev === "batch_end") {
            const logs = data.logs ?? {};
            // PyQt reads logs["loss"] for batch loss (falls back to train/loss).
            const loss = logs["loss"] ?? logs["train/loss"] ?? logs["train_loss"];
            if (
              typeof data.epoch === "number" &&
              typeof data.batch === "number" &&
              typeof loss === "number"
            ) {
              batchBuffer.push({ epoch: data.epoch, batch: data.batch, loss });
            }
          }
        });

        // Flush buffered per-batch losses ~2x/sec so high-frequency batch_end
        // events don't thrash React (mirrors PyQt's 500ms redraw throttle).
        batchFlushTimer = setInterval(() => {
          if (batchBuffer.length === 0) return;
          const drained = batchBuffer.splice(0, batchBuffer.length);
          get().recordBatches(get().currentModelIndex, drained);
        }, 500);
      } catch (e) {
        console.error("[training] ZMQ relay failed to start:", e);
        set((s) => ({
          log: appendLog(s.log, `[warn] ZMQ relay failed: ${e instanceof Error ? e.message : String(e)} — Stop Early disabled`),
        }));
      }

      set((state) => ({
        models: state.models.map((m, i) =>
          i === 0 ? { ...m, status: "running" as const } : m,
        ),
      }));

      const { useAppStore } = await import("@/stores/appStore");
      const localLabels = useAppStore.getState().labels;
      const localSizeStats = computeInstanceSizeStats(localLabels);

      try {
        for (let i = 0; i < slots.length; i++) {
          const cf = config.configs.find((c) => c.slot === slots[i]);
          if (!cf) continue;

          set((s) => ({
            currentModelIndex: i,
            models: s.models.map((m, j) =>
              j === i ? { ...m, status: "running" as const } : m,
            ),
            log: i > 0 ? appendLog(s.log, `— Starting ${s.models[i]?.label}...`) : s.log,
          }));

          // max_stride has no server-side Auto resolution (unlike crop_size)
          // — resolve it client-side from the project's actual instance
          // sizes before this config is written out for training.
          const isPretrainedBackbone = !!cf.hyperparams.backbone && cf.hyperparams.backbone !== "unet";
          const resolvedMaxStride =
            cf.hyperparams.maxStride == null && (localSizeStats || isPretrainedBackbone)
              ? recommendMaxStride(
                  localSizeStats?.avgAnimalSize ?? 0,
                  localSizeStats?.maxBboxDim ?? 0,
                  cf.hyperparams.scale,
                  cf.hyperparams.backbone,
                )
              : undefined;
          // in_channels has no server-side Auto resolution either — resolve
          // colorMode against the project's actual video channel count
          // before this config is written out for training.
          const resolvedInChannels = resolveInputChannels(
            cf.hyperparams.colorMode,
            detectVideoChannels(localLabels),
          );
          const configYaml = applyHyperparamsToYaml(
            cf.content,
            cf.hyperparams,
            cf.checkpointPath,
            resolvedMaxStride,
            resolvedInChannels,
          );
          // Default run name matches legacy SLEAP's format exactly:
          // `{timestamp}.{head_name}.n={num_user_labeled_frames}`
          // (sleap/gui/learning/runners.py get_timestamp() + base_run_name) —
          // the `n=` count is the project's training-data size at the moment
          // training starts, which is what made the old scheme's "which run
          // used how much data" comparisons useful across a project's history.
          let runName = cf.hyperparams.runName;
          if (!runName) {
            const n = countUserLabeledFrames(localLabels, {
              includeUserCentroids: cf.modelType === "centroid",
            });
            const ts = formatRunTimestamp();
            runName = n !== null ? `${ts}.${cf.modelType}.n=${n}` : `${ts}.${cf.modelType}`;
          }

          set((s) => ({
            models: s.models.map((m, j) =>
              j === i ? { ...m, runDir: `${modelDir}/${runName}` } : m,
            ),
          }));

          const result = await runTraining(configYaml, labelsPath, runName, (event) => {
            const state = get();
            const idx = state.currentModelIndex;

            if (event.event === "stdout" || event.event === "stderr") {
              const line = event.data.line;
              if (event.event === "stderr" && line.trim()) {
                stderrTail.push(line);
                if (stderrTail.length > 25) stderrTail.shift();
              }

              // Structured epoch progress (rare — ~once/epoch): record immediately.
              // epoch SAMPLES come from these JSON lines, not from tqdm.
              try {
                const data = JSON.parse(line);
                if ("epoch" in data) {
                  get().recordEpoch(idx, {
                    epoch: data.epoch ?? 0,
                    trainLoss: data.loss ?? null,
                    valLoss: data.val_loss ?? null,
                  });
                  return;
                }
              } catch {
                // Not JSON
              }

              // W&B URL detection (one-time side effect).
              if (line.includes("wandb.ai/")) {
                const urlMatch = line.match(/(https:\/\/wandb\.ai\/[^\s"}\]>)]+)/);
                if (urlMatch) set({ wandbUrl: urlMatch[1] });
              }

              // Model output directory detection (best_ckpt path from sleap-nn).
              const ckptMatch = line.match(/best_ckpt['":\s]+([^\s'",}]+\.ckpt)/);
              if (ckptMatch) {
                const dir = ckptMatch[1].replace(/\/[^/]+$/, "");
                set((s) => {
                  const dirs = [...s.modelOutputDirs];
                  if (!dirs.includes(dir)) dirs.push(dir);
                  return { modelOutputDirs: dirs };
                });
              }

              // tqdm progress + all other lines: buffer for the throttled, coalesced
              // flush (logFlusher). NEVER set() per line — that is the freeze.
              logFlusher.push(line);
            }
          }, modelDir);

          if (result.modelPath) trainedModelPaths.push(result.modelPath);

          const wasStopped = get()._stopRequested;
          console.log("[training] Model %d finished: success=%s, wasStopped=%s, modelPath=%s", i, result.success, wasStopped, result.modelPath);
          if (result.success || wasStopped) {
            set((s) => ({
              _stopRequested: false,
              models: s.models.map((m, j) =>
                j === i ? { ...m, status: "completed" as const } : m,
              ),
              log: wasStopped
                ? appendLog(s.log, `— ${s.models[i]?.label} stopped early, moving to next model...`)
                : s.log,
            }));
            console.log("[training] Continuing to next model (i=%d, total=%d)", i, slots.length);
          } else {
            console.log("[training] Model failed, aborting training loop");
            const cause = lastErrorLine(stderrTail);
            set((s) => ({
              status: "error",
              error: cause
                ? `Training failed for ${cf.modelType}: ${cause}`
                : `Training failed for ${cf.modelType}`,
              stderrTail: [...stderrTail],
              models: s.models.map((m, j) =>
                j === i ? { ...m, status: "failed" as const } : m,
              ),
            }));
            return;
          }
        }

        set({ modelOutputDirs: trainedModelPaths });

        // ── Post-training model export (ONNX / TensorRT) ──────
        // Auto-export the trained model to a portable runtime when the user picked a
        // format in the Training config Output section. On failure we keep going with
        // the PyTorch checkpoint (exportDir stays null → inference falls back to it).
        const exportFormat = localOpts?.exportFormat;
        let exportDir: string | null = null;
        if (exportFormat && exportFormat !== "none" && trainedModelPaths.length > 0) {
          const { runExport } = await import("@/platform/backend");
          const { defaultExportOutputDir } = await import("@/stores/exportStore");
          const outputDir = defaultExportOutputDir(trainedModelPaths);
          // List the run dirs being bundled so a top-down export reads clearly as
          // both heads (e.g. "centroid.n=1 + centered_instance.n=1"), not centroid-only.
          const exportRunNames = trainedModelPaths
            .map((d) => d.replace(/[/\\]+$/, "").split(/[/\\]/).pop())
            .join(" + ");
          set((s) => ({ log: appendLog(s.log, `— Exporting trained model to ${exportFormat.toUpperCase()} (${exportRunNames}) → ${outputDir}...`) }));
          const exportLogEvent = (event: import("@/platform/backend").ProcessEvent) => {
            if (event.event === "stdout" || event.event === "stderr") {
              const line = event.data.line;
              if (line.trim()) set((s) => ({ log: appendLog(s.log, line) }));
            }
          };
          const exportResult = await runExport(
            { modelPaths: trainedModelPaths, outputDir, format: exportFormat, precision: "fp16" },
            exportLogEvent,
          );
          if (exportResult.success) {
            exportDir = outputDir;
            set((s) => ({ log: appendLog(s.log, `— Export complete: ${outputDir}`) }));
          } else {
            set((s) => ({ log: appendLog(s.log, "— Export failed — continuing with the PyTorch model.") }));
          }
        }
        // Whether post-training inference should target the exported model.
        const useExported = !!exportDir && !!localOpts?.useExportedForInference;
        const exportRuntime: "onnx" | "tensorrt" = exportFormat === "tensorrt" ? "tensorrt" : "onnx";
        // Exported ONNX must NOT run on the CoreML EP — onnxruntime resolves "auto"
        // → mps → CoreML on macOS, which fails on these dynamic-shape models
        // ("CoreML does not support shapes with dimension values of 0"). Use CPU on
        // non-CUDA hosts (proven to run the exported model), CUDA where available.
        let exportDevice: "cuda" | "cpu" = "cpu";
        if (useExported) {
          const { detectGpu } = await import("@/platform/backend");
          exportDevice = (await detectGpu()) === "cuda" ? "cuda" : "cpu";
        }

        // ── Post-training inference ───────────────────────────
        // Centroid-only runs have no `sleap-nn track` pipeline (that needs a
        // paired centered-instance model); standalone centroid prediction uses
        // `sleap-nn predict`, which isn't wired yet. Skip auto-inference so a
        // locator run doesn't mis-route to a broken top-down `track` command.
        const inferenceTarget = localOpts?.inferenceTarget;
        if (
          inferenceTarget &&
          inferenceTarget !== "nothing" &&
          trainedModelPaths.length > 0 &&
          config.modelType !== "centroid"
        ) {
          set((s) => ({
            log: appendLog(s.log, `— Running inference (${inferenceTarget}) with ${useExported ? `exported model: ${exportDir}` : `models: ${trainedModelPaths.join(", ")}`}...`),
          }));

          const { runInference } = await import("@/platform/backend");
          const { useAppStore } = await import("@/stores/appStore");
          const { loadSlp } = await import("@talmolab/sleap-io.js");
          const { commandContext } = await import("@/commands");
          const { MergePredictions } = await import("@/commands/editCommands");
          const getPlatform = (await import("@/platform")).getPlatform;

          const inferenceConfig = buildPostTrainingInferenceConfig({
            modelType: config.modelType,
            modelPaths: useExported ? [exportDir!] : trainedModelPaths,
            inferenceTarget,
            videoIndex: (inferenceTarget === "video" || inferenceTarget === "random_video")
              ? (() => {
                  const { labels, video } = useAppStore.getState();
                  return labels && video ? labels.videos.indexOf(video) : 0;
                })()
              : "all",
            sampleCount: localOpts?.sampleCount,
            skipUserLabeled: localOpts?.skipUserLabeled,
            existingPredictions: localOpts?.existingPredictions,
            device: useExported ? exportDevice : "auto",
            runtime: useExported ? exportRuntime : "auto",
          });

          let mergedAny = false;
          try {
            const { projectPath, labels: currentLabels } = useAppStore.getState();

            const logEvent = (event: import("@/platform/backend").ProcessEvent) => {
              if (event.event === "stdout" || event.event === "stderr") {
                const line = event.data.line;
                if (line.trim()) set((s) => ({ log: appendLog(s.log, line) }));
              }
            };

            const mergeOutputSlp = async (outputPath: string) => {
              const platform = await getPlatform();
              const bytes = await platform.readFile(outputPath);
              console.log("[training] Read predictions file: %d bytes", bytes.byteLength);
              const predictions = await loadSlp(bytes, {
                openVideos: false,
                h5: { filenameHint: outputPath },
              });
              console.log("[training] Loaded predictions: %d videos, %d frames, %d tracks",
                predictions.videos?.length ?? 0,
                predictions.labeledFrames?.length ?? 0,
                predictions.tracks?.length ?? 0,
              );
              await commandContext.execute(MergePredictions, {
                predictions,
                mode: localOpts?.existingPredictions ?? "replace",
              });
              mergedAny = true;
            };

            // Run inference; if it targeted the exported model and failed, retry
            // once with the PyTorch checkpoint (runtime auto) as a fallback.
            const runInferenceWithFallback = async (cfg: typeof inferenceConfig) => {
              let result = await runInference(cfg, projectPath, logEvent);
              if (!result.success && useExported) {
                set((s) => ({ log: appendLog(s.log, "— Exported-model inference failed; retrying with the PyTorch checkpoint...") }));
                result = await runInference({ ...cfg, modelPaths: trainedModelPaths, runtime: "auto", device: "auto" }, projectPath, logEvent);
              }
              return result;
            };

            if (inferenceTarget === "random") {
              // Per-video random sampling
              const videos = currentLabels?.videos ?? [];
              for (let vi = 0; vi < videos.length; vi++) {
                const nFrames = videos[vi].shape?.[0] ?? 0;
                if (nFrames === 0) continue;
                set((s) => ({ log: appendLog(s.log, `— Inference: video ${vi + 1}/${videos.length}...`) }));
                const perVideoConfig = { ...inferenceConfig, videoIndex: vi as number | "all", frameRange: "random_video" as typeof inferenceConfig.frameRange };
                const result = await runInferenceWithFallback(perVideoConfig);
                if (result.success && result.outputPath) {
                  await mergeOutputSlp(result.outputPath);
                }
              }
            } else {
              const result = await runInferenceWithFallback(inferenceConfig);
              if (result.success && result.outputPath) {
                await mergeOutputSlp(result.outputPath);
              } else if (!result.success) {
                set((s) => ({ log: appendLog(s.log, "— Post-training inference failed (non-zero exit).") }));
              }
            }
            if (!mergedAny) {
              // Nothing was merged — a failed run, or a successful one that
              // wrote no output. Say so instead of claiming a merge, and raise
              // no review signal (there is nothing to review).
              set((s) => ({ log: appendLog(s.log, "— No predictions were merged.") }));
            } else {
              set((s) => ({ log: appendLog(s.log, "— Predictions merged into project.") }));

              // Phase-2 → Phase-3 handoff: surface what landed rather than
              // seizing the UI. See AppState.pendingReview.
              const { reviewSignal } = await import("@/lib/activeLearning/reviewQueue");
              const app = useAppStore.getState();
              if (app.labels) {
                const { flagged, total } = reviewSignal(app.labels, app.correctScoreThreshold);
                app.setPendingReview({ flagged, total });
                set((s) => ({
                  log: appendLog(
                    s.log,
                    total === 0
                      ? "— No scored predictions to review."
                      : flagged === 0
                        ? `— ${total} predictions merged; none below the ${app.correctScoreThreshold} flag threshold.`
                        : `— ${flagged} of ${total} predictions need review.`,
                  ),
                }));
              }
            }
          } catch (e) {
            console.error("[training] Post-training inference failed:", e);
            set((s) => ({
              log: appendLog(s.log, `— Post-training inference failed: ${e instanceof Error ? e.message : String(e)}`),
            }));
          }
        }

        set({ status: "completed" });
      } catch (e) {
        set({
          status: "error",
          error: `Local training error: ${e instanceof Error ? e.message : String(e)}`,
          stderrTail: [...stderrTail],
        });
      } finally {
        if (batchFlushTimer) { clearInterval(batchFlushTimer); batchFlushTimer = null; }
        if (batchBuffer.length > 0) {
          get().recordBatches(get().currentModelIndex, batchBuffer.splice(0, batchBuffer.length));
        }
        logFlusher.stop(); // drain any remaining buffered stdout into the log
        if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
        try { await stopProgressRelay(); } catch { /* ignore */ }
        try { await stopZmqRelay(); } catch { /* ignore */ }
      }
    }
  },

  stopTraining: async () => {
    if (get()._isRemote) {
      // Remote: jobs.cancel(mode: "stop") for graceful early stop
      const { useConnectStore } = await import("@/stores/connectStore");
      const { stopJob } = useConnectStore.getState();
      stopJob();
      set((s) => ({
        log: appendLog(s.log, "— Stop Early requested, saving checkpoint..."),
      }));
    } else {
      // Local: send stop via ZMQ (same as PyQt GUI)
      const { sendTrainingStop } = await import("@/platform/backend");
      set((s) => ({
        _stopRequested: true,
        log: appendLog(s.log, "— Stop Early requested, finishing current epoch..."),
      }));
      try {
        await sendTrainingStop();
      } catch (e) {
        console.error("[training] sendTrainingStop() failed:", e);
        set((s) => ({
          log: appendLog(s.log, `[debug] Stop command failed: ${e instanceof Error ? e.message : String(e)}`),
        }));
      }
    }
  },

  cancelTraining: async () => {
    if (get()._isRemote) {
      // Remote: jobs.cancel(mode: "cancel")
      const { useConnectStore } = await import("@/stores/connectStore");
      const { cancelJob } = useConnectStore.getState();
      cancelJob();
    } else {
      // Local: kill subprocess
      await cancelCommand();
    }
    set({ status: "error", error: "Training cancelled" });
  },

  recordEpoch: (modelIndex, sample) =>
    set((state) => {
      if (modelIndex < 0 || modelIndex >= state.models.length) return state;
      const startedAt = state.startedAt ?? Date.now();
      return {
        models: state.models.map((m, i) => {
          if (i !== modelIndex) return m;
          const epochSize = Math.max(m.epochSize, m.lastBatchNumber + 1);
          const epochSamples = [...m.epochSamples, sample];

          const metrics = computeRuntimeMetrics(epochSamples, startedAt, Date.now(), m.plateauMinDelta);

          return {
            ...m,
            epochSize,
            epochSamples,
            epoch: sample.epoch + 1,
            loss: sample.trainLoss ?? m.loss,
            valLoss: sample.valLoss ?? m.valLoss,
            bestValLoss:
              sample.valLoss != null &&
              (m.bestValLoss === null || sample.valLoss < m.bestValLoss)
                ? sample.valLoss
                : m.bestValLoss,
            metrics,
          };
        }),
      };
    }),

  recordBatch: (modelIndex, sample) =>
    set((state) => {
      if (modelIndex < 0 || modelIndex >= state.models.length) return state;
      return {
        models: state.models.map((m, i) => {
          if (i !== modelIndex) return m;
          const globalBatch = sample.epoch * m.epochSize + sample.batch;
          const next = [...m.batchSamples, { globalBatch, loss: sample.loss }];
          return {
            ...m,
            lastBatchNumber: sample.batch,
            batchSamples: next.length > MAX_BATCH_SAMPLES ? next.slice(next.length - MAX_BATCH_SAMPLES) : next,
          };
        }),
      };
    }),

  recordBatches: (modelIndex, samples) =>
    set((state) => {
      if (modelIndex < 0 || modelIndex >= state.models.length || samples.length === 0) return state;
      return {
        models: state.models.map((m, i) => {
          if (i !== modelIndex) return m;
          let lastBatch = m.lastBatchNumber;
          const additions = samples.map((s) => {
            lastBatch = s.batch;
            return { globalBatch: s.epoch * m.epochSize + s.batch, loss: s.loss };
          });
          const next = [...m.batchSamples, ...additions];
          return {
            ...m,
            lastBatchNumber: lastBatch,
            batchSamples: next.length > MAX_BATCH_SAMPLES ? next.slice(next.length - MAX_BATCH_SAMPLES) : next,
          };
        }),
      };
    }),

  markEpochBegin: (modelIndex, epoch) =>
    set((state) => {
      if (modelIndex < 0 || modelIndex >= state.models.length) return state;
      return {
        models: state.models.map((m, i) =>
          i === modelIndex ? { ...m, epoch, epochStartedAt: Date.now() } : m,
        ),
      };
    }),

  applyRemoteTelemetry: (modelIndex, telemetry) => {
    const model = get().models[modelIndex];
    if (!model) return;
    const patch = (fn: (m: ModelProgress) => ModelProgress) =>
      set((s) => ({ models: s.models.map((m, i) => (i === modelIndex ? fn(m) : m)) }));

    if (telemetry.kind === "epoch") {
      // Local learns batches-per-epoch from batch_end's batch index; remote
      // only has the curve, whose x is the global batch step — so infer it
      // from how far the curve has advanced by the end of this epoch.
      // recordEpoch needs it to place epoch points on the batch axis.
      const lastX = model.batchSamples[model.batchSamples.length - 1]?.globalBatch;
      if (lastX !== undefined) {
        const estimate = Math.round((lastX + 1) / (telemetry.epoch + 1));
        if (estimate > model.epochSize) patch((m) => ({ ...m, epochSize: estimate }));
      }
      get().recordEpoch(modelIndex, {
        epoch: telemetry.epoch,
        trainLoss: telemetry.trainLoss,
        valLoss: telemetry.valLoss,
      });
      // No remote epoch_begin event: the epoch is over until the next
      // curve/metric shows training has moved on (see below).
      patch((m) => ({ ...m, epochStartedAt: null }));
      return;
    }

    // Curve/metric are emitted only while training is running, so the
    // first one after a job start or a completed epoch stands in for
    // local's epoch_begin (drives the monitor's "Epoch Runtime").
    if (model.epochStartedAt === null) get().markEpochBegin(modelIndex, model.epoch);

    if (telemetry.kind === "curve") {
      const samples = telemetry.points.map((p) => ({ globalBatch: p.x, loss: p.y }));
      patch((m) => ({
        ...m,
        // The whole curve every time: replace, never append.
        batchSamples:
          samples.length > MAX_BATCH_SAMPLES ? samples.slice(samples.length - MAX_BATCH_SAMPLES) : samples,
      }));
      return;
    }

    // job.metric: only the fields the local monitor has a home for.
    if (telemetry.wandbUrl && telemetry.wandbUrl !== get().wandbUrl) {
      set({ wandbUrl: telemetry.wandbUrl });
    }
    patch((m) => ({
      ...m,
      maxEpochs: telemetry.totalEpochs != null && telemetry.totalEpochs > 0 ? telemetry.totalEpochs : m.maxEpochs,
      loss: telemetry.latestTrainLoss ?? m.loss,
    }));
  },

  fetchAndLoadPostTrainingPredictions: async () => {
    const pending = get().postTrainingInference?.pendingMerge;
    if (!pending) return;
    const { mergeRemoteResults } = await import("@/stores/inferenceStore");
    try {
      await mergeRemoteResults(pending);
      set((s) => ({
        postTrainingInference: s.postTrainingInference && {
          ...s.postTrainingInference,
          pendingMerge: null,
          merged: true,
          message: null,
        },
        log: appendLog(s.log, "— Predictions merged into project."),
      }));
    } catch (e) {
      // Retriable: the job itself succeeded, only the fetch failed — keep
      // pendingMerge so Fetch & Load stays available (mirrors
      // inferenceStore.mergePendingRemoteResults).
      set((s) => ({
        postTrainingInference: s.postTrainingInference && {
          ...s.postTrainingInference,
          message: `Failed to fetch/merge predictions: ${e instanceof Error ? e.message : String(e)}`,
        },
      }));
    }
  },
}));
