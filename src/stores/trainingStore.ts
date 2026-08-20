import { create } from "zustand";
import yaml from "js-yaml";
import { cancelCommand } from "@/platform/backend";
import { isTauri } from "@/platform";
import { computeRuntimeMetrics } from "@/lib/trainingMetrics";
import { lastErrorLine } from "@/lib/processLog";
import { formatRunTimestamp } from "@/lib/timestamp";
import type { Labels } from "@/types";

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

/**
 * Merge a batch of raw stdout/stderr lines into the bounded training log. Strips
 * ANSI codes, drops blanks, and — to emulate a terminal carriage return — REPLACES
 * the trailing log line (instead of appending) when both it and the incoming line
 * are progress bars, so a tqdm bar shows as ONE in-place-updating line rather than
 * thousands. Pure + synchronous so it is unit-testable. Bounded to MAX_LOG_LINES.
 */
export function mergeStdoutIntoLog(prev: string[], rawLines: string[]): string[] {
  const next = prev.slice();
  for (const raw of rawLines) {
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) continue;
    if (
      PROGRESS_LINE_RE.test(clean) &&
      next.length > 0 &&
      PROGRESS_LINE_RE.test(next[next.length - 1])
    ) {
      next[next.length - 1] = clean; // coalesce in place (carriage-return behavior)
    } else {
      next.push(clean);
    }
  }
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}

// ── Types ─────────────────────────────────────────────────────────

export type ModelType =
  | "single_animal"
  | "top_down"
  | "bottom_up"
  | "top_down_id"
  | "bottom_up_id";

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
  maxStride: number;
  filters: number;
  filtersRate: number;
  middleBlock: boolean;
  upInterpolate: boolean;
  // Model — head
  outputStride: number;
  anchorPart: string | null;
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
  trainingMode: "reuse_config" | "resume" | "finetune";
  accelerator: "auto" | "cuda" | "mps" | "cpu";
  // Performance
  dataPipeline: DataPipeline;
  dataloaderWorkers: number;
  numDevices: number | "auto";
  // Output — checkpoint saving
  saveBestModel: boolean;
  saveLastModel: boolean;
  // Output — visualization
  visualizePredictions: boolean;
  keepVizImages: boolean;
  // Data — color conversion
  colorMode: ColorMode;
  // Epoch-end evaluation (distinct from the regular per-epoch validation loop)
  evalEnabled: boolean;
  evalFrequency: number;
  // W&B extras (entity/project are above, near useWandb)
  wandbUploadViz: boolean;
  wandbPrevRunId: string;
  wandbGroup: string;
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
  maxStride: 16,
  filters: 16,
  filtersRate: 2.0,
  middleBlock: true,
  upInterpolate: true,
  outputStride: 2,
  anchorPart: null,
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
  trainingMode: "reuse_config",
  accelerator: "auto",
  dataPipeline: "memory",
  dataloaderWorkers: 2,
  numDevices: "auto",
  saveBestModel: true,
  saveLastModel: false,
  // Deliberately true (sleap-nn's own defaults are both false): this is what
  // actually makes the app's own epoch-viz-scrubber feature work out of the
  // box — see the `keep_viz`/`visualize_preds_during_training` comment in
  // applyHyperparamsToYaml below for why they must go together.
  visualizePredictions: true,
  keepVizImages: true,
  colorMode: "auto",
  evalEnabled: false,
  evalFrequency: 1,
  wandbUploadViz: false,
  wandbPrevRunId: "",
  wandbGroup: "",
};

export interface ConfigFile {
  filename: string;
  content: string; // raw YAML text
  modelType: string; // parsed from head_configs (e.g., "centroid")
  slot: string; // which slot this fills (e.g., "centroid", "centered_instance", "config")
  hyperparams: ConfigHyperparams; // per-config hyperparameters
  hasTrainedModel: boolean; // true if config has a non-empty run_name (trained model exists)
  /** Absolute path to this config's source run's checkpoint file, for Resume/Fine-tune. `null` for a baseline profile or a manually-browsed file (no known run directory). */
  checkpointPath: string | null;
}

export interface RemoteTrainingOptions {
  remote: true;
  workerId: string;
  labelsPath: string; // path on worker
  valLabelsPath?: string;
  inferenceTarget?: string;
}

export interface LocalTrainingOptions {
  inferenceTarget?: string;
  sampleCount?: number;
  skipUserLabeled?: boolean;
  existingPredictions?: "clear_all" | "replace" | "keep";
}

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

  /**
   * Bumped on every `reset()`. `TrainingPanel`'s baseline-autoload effect keys
   * off `config.modelType` alone, so a `reset()` that lands back on the SAME
   * model type (e.g. "Train Again" after a Top-Down run) wouldn't otherwise
   * re-fire and refill `config.configs` — this gives that effect a signal
   * that's independent of whether `modelType` actually changed.
   */
  resetSeq: number;

  // Actions
  setConfig: <K extends keyof TrainingConfig>(key: K, value: TrainingConfig[K]) => void;
  updateConfigHyperparams: (slot: string, updates: Partial<ConfigHyperparams>) => void;
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
}

// ── Config slot helpers ───────────────────────────────────────────

/** Get required config slots for a model type */
export function getConfigSlots(modelType: ModelType): string[] {
  switch (modelType) {
    case "top_down":
    case "top_down_id":
      return ["centroid", "centered_instance"];
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
 * Count of frames with a user instance or marked negative — the JS
 * equivalent of sleap-io's `Labels.user_labeled_frames` (which includes
 * negative/background frames as trainable data, not just positively-labeled
 * ones). Used for the `n=` suffix in a default run name; `null` with no
 * project loaded.
 */
export function countUserLabeledFrames(labels: Labels | null): number | null {
  if (!labels) return null;
  return labels.labeledFrames.filter((lf) => lf.userInstances.length > 0 || lf.isNegative).length;
}

// ── YAML override helper ─────────────────────────────────────────

/** Apply ConfigHyperparams overrides to raw YAML config content. */
export function applyHyperparamsToYaml(
  yamlText: string,
  hp: ConfigHyperparams,
  checkpointPath: string | null = null,
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

  // Checkpoint saving. The UI only exposes a binary choice for "best model"
  // (sleap-nn's save_top_k is a count; 1 = on, 0 = off — there's no control
  // for saving more than the single best).
  if (!trainer.model_ckpt) trainer.model_ckpt = {};
  const modelCkpt = trainer.model_ckpt as Record<string, unknown>;
  modelCkpt.save_top_k = hp.saveBestModel ? 1 : 0;
  modelCkpt.save_last = hp.saveLastModel;

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
  data.skeletons = [];

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

  // Seed
  trainer.seed = hp.randomSeed;

  // Override accelerator so configs from CUDA machines work on CPU/MPS
  trainer.trainer_accelerator = hp.accelerator;

  // Number of devices ("auto" or a positive integer)
  trainer.trainer_devices = hp.numDevices;

  // Early stopping
  if (!trainer.early_stopping) trainer.early_stopping = {};
  const es = trainer.early_stopping as Record<string, unknown>;
  es.stop_training_on_plateau = hp.stopOnPlateau;
  es.patience = hp.earlyStoppingPatience;
  es.min_delta = hp.plateauMinDelta;

  // Online hard keypoint mining
  if (!trainer.online_hard_keypoint_mining) trainer.online_hard_keypoint_mining = {};
  const ohkm = trainer.online_hard_keypoint_mining as Record<string, unknown>;
  ohkm.online_mining = hp.onlineMining;
  ohkm.min_hard_keypoints = hp.minHardKeypoints;
  ohkm.max_hard_keypoints = hp.maxHardKeypoints;

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

  // Backbone model params
  const backboneConfig = (model.backbone_config ?? {}) as Record<string, unknown>;
  if (hp.backbone === "unet" || !hp.backbone) {
    if (!backboneConfig.unet) backboneConfig.unet = {};
    const unet = backboneConfig.unet as Record<string, unknown>;
    unet.max_stride = hp.maxStride;
    unet.filters = hp.filters;
    unet.filters_rate = hp.filtersRate;
    unet.middle_block = hp.middleBlock;
    unet.up_interpolate = hp.upInterpolate;
    unet.stem_stride = hp.stemStride;
    model.backbone_config = backboneConfig;
  }

  // Head params — output_stride and anchor_part
  for (const [, headVal] of Object.entries(headConfigs)) {
    if (headVal && typeof headVal === "object") {
      const head = headVal as Record<string, unknown>;
      if (head.confmaps && typeof head.confmaps === "object") {
        (head.confmaps as Record<string, unknown>).output_stride = hp.outputStride;
        if (hp.anchorPart !== null) {
          (head.confmaps as Record<string, unknown>).anchor_part = hp.anchorPart;
        }
      } else {
        head.output_stride = hp.outputStride;
        if (hp.anchorPart !== null) {
          head.anchor_part = hp.anchorPart;
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
  resetSeq: 0,
};

// ── Store ─────────────────────────────────────────────────────────

export const useTrainingStore = create<TrainingState>()((set, get) => ({
  ...initialState,

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

      // Extract model type from head_configs (same logic as dashboard)
      const trainerConfig = (doc.trainer_config ?? doc.trainer ?? doc) as Record<string, unknown>;
      const modelConfig = (doc.model_config ?? {}) as Record<string, unknown>;
      const headConfigs = (modelConfig.head_configs ?? trainerConfig?.head_configs ?? {}) as Record<string, unknown>;
      const detectedModelType = Object.entries(headConfigs).find(([, v]) => v != null)?.[0] ?? "unknown";

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

      // Extract backbone model params
      const unetConfig = (backboneConfig[activeBackbone.toLowerCase()] ?? {}) as Record<string, unknown>;

      // Extract output_stride and anchor_part from head configs
      let outputStride = 2;
      let anchorPart: string | null = null;
      for (const headVal of Object.values(headConfigs)) {
        if (headVal && typeof headVal === "object") {
          const head = headVal as Record<string, unknown>;
          if (typeof head.output_stride === "number") outputStride = head.output_stride;
          if (typeof head.anchor_part === "string") anchorPart = head.anchor_part;
          const confmaps = head.confmaps as Record<string, unknown> | undefined;
          if (confmaps) {
            if (typeof confmaps.output_stride === "number") outputStride = confmaps.output_stride;
            if (typeof confmaps.anchor_part === "string") anchorPart = confmaps.anchor_part;
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
        trainingMode: "reuse_config" as const,
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
        dataPipeline: defaultHyperparams.dataPipeline,
        dataloaderWorkers: defaultHyperparams.dataloaderWorkers,
        numDevices: defaultHyperparams.numDevices,
        // Checkpoint saving — sleap-nn's own default is save_top_k=1 (best
        // model on), save_last=None (off), so an absent key means "on"/"off"
        // respectively, matching those real defaults.
        saveBestModel: typeof modelCkpt.save_top_k === "number" ? modelCkpt.save_top_k > 0 : true,
        saveLastModel: modelCkpt.save_last === true,
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
        wandbUploadViz: wandb.save_viz_imgs_wandb === true,
        wandbPrevRunId: typeof wandb.prv_runid === "string" ? wandb.prv_runid : "",
        wandbGroup: typeof wandb.group === "string" ? wandb.group : "",
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
        content: yamlText,
        modelType: detectedModelType,
        slot,
        hyperparams,
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
        label: getSlotLabel(slot).replace(" Config", ""),
        epoch: 0,
        maxEpochs: cf?.hyperparams.maxEpochs ?? 100,
        loss: null,
        valLoss: null,
        bestValLoss: null,
        status: "pending" as const,
        epochSamples: [],
        batchSamples: [],
        epochSize: 1,
        lastBatchNumber: 0,
        metrics: emptyMetrics(),
        epochStartedAt: null,
        plateauPatience: cf?.hyperparams.earlyStoppingPatience ?? null,
        plateauMinDelta: cf?.hyperparams.plateauMinDelta ?? null,
        runDir: null,
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
    });

    if (remoteOpts?.remote) {
      // ── Remote training via WebRTC ────────────────────────
      const { useConnectStore } = await import("@/stores/connectStore");
      const { submitJob, workers, selectedWorkerId } = useConnectStore.getState();

      // Collect video paths from the loaded project
      const { useAppStore } = await import("@/stores/appStore");
      const { labels } = useAppStore.getState();
      const videoPaths: string[] = [];
      if (labels) {
        for (const video of labels.videos) {
          if (typeof video.filename === "string") {
            videoPaths.push(video.filename);
          } else if (Array.isArray(video.filename)) {
            videoPaths.push(video.filename[0]);
          }
        }
      }

      // All paths to resolve: labels path + video paths
      const allLocalPaths = [remoteOpts.labelsPath, ...videoPaths];

      // Load saved mappings and get worker mounts
      const { loadSavedMappings, resolveProjectPaths, buildPathMappings } =
        await import("@/lib/pathMappings");
      const savedMappings = await loadSavedMappings();
      const worker = workers.find((w) => w.peerId === selectedWorkerId);
      const workerMounts = worker?.mounts ?? [];

      // Resolve paths using saved prefix mappings
      const resolvedPaths = resolveProjectPaths(allLocalPaths, savedMappings, workerMounts);

      // Show PathResolutionDialog for user confirmation
      const confirmedPaths = await new Promise<
        Array<{ local: string; worker: string }> | null
      >((resolve) => {
        window.dispatchEvent(
          new CustomEvent("sleap:path-resolution", {
            detail: { paths: resolvedPaths, resolve },
          }),
        );
      });

      if (!confirmedPaths) {
        // User cancelled path resolution
        set({ status: "idle" });
        return;
      }

      // Build path_mappings dict from confirmed resolutions
      const pathMappings = buildPathMappings(confirmedPaths);

      // Use the resolved labels path (first entry is always the labels/data path)
      const resolvedLabelsPath = confirmedPaths[0]?.worker ?? remoteOpts.labelsPath;

      // Build TrainJobSpec with path_mappings — apply hyperparam overrides to YAML.
      // Unlike local training, there's no Hydra CLI-override safety net here
      // (the worker runs whatever's baked into config_contents verbatim), so
      // run_name must be resolved to a fresh value BEFORE serializing — it's
      // always blank on `hyperparams` post-import (see parseYamlConfig), and
      // applyHyperparamsToYaml only writes run_name when it's non-empty, so
      // without this an imported config's stale run_name would otherwise ride
      // straight through into the remote job.
      const userLabeledFrameCount = countUserLabeledFrames(labels);
      const runTimestamp = formatRunTimestamp();
      const resolveRunName = (hp: ConfigHyperparams, modelType: string) =>
        hp.runName ||
        (userLabeledFrameCount !== null
          ? `${runTimestamp}.${modelType}.n=${userLabeledFrameCount}`
          : `${runTimestamp}.${modelType}`);

      const spec = {
        type: "train" as const,
        config_contents: config.configs.map((c) =>
          applyHyperparamsToYaml(
            c.content,
            {
              ...c.hyperparams,
              runName: resolveRunName(c.hyperparams, c.modelType),
            },
            c.checkpointPath,
          ),
        ),
        model_types: config.configs.map((c) => c.modelType),
        labels_path: resolvedLabelsPath,
        val_labels_path: remoteOpts.valLabelsPath || undefined,
        path_mappings: Object.keys(pathMappings).length > 0 ? pathMappings : undefined,
        inference_target: remoteOpts.inferenceTarget ?? "suggested",
      };

      set((state) => ({
        models: state.models.map((m, i) =>
          i === 0 ? { ...m, status: "running" as const } : m,
        ),
      }));

      const numModels = slots.length;

      try {
        const result = await submitJob(spec, (line: string, isCarriageReturn?: boolean) => {
          // Parse progress from worker — single shared log
          const state = get();
          const idx = state.currentModelIndex;

          // ── PROGRESS_REPORT (structured ZMQ events) ───────────
          // Silently updates progress state — NOT printed to terminal.
          if (line.startsWith("__PROGRESS_REPORT__")) {
            const payload = line.slice("__PROGRESS_REPORT__".length);
            try {
              const data = JSON.parse(payload);
              const event = data.event ?? data.py_dict?.event;

              if (event === "train_begin" || data.wandb_url) {
                const url = data.wandb_url ?? data.py_dict?.wandb_url;
                if (url) set({ wandbUrl: url });
              }

              if (event === "epoch_end") {
                const logs = data.logs ?? data.py_dict?.logs ?? {};
                const trainLoss = logs["train/loss"] ?? logs["loss"] ?? null;
                const valLoss = logs["val/loss"] ?? null;
                const epoch = data.epoch ?? data.py_dict?.epoch;
                // OQ-5: remote epoch is 0-based — pass through, no normalization.
                if (typeof epoch === "number") {
                  get().recordEpoch(idx, { epoch, trainLoss, valLoss });
                }
              }

              if (event === "epoch_begin") {
                const epoch = data.epoch ?? data.py_dict?.epoch;
                if (typeof epoch === "number") get().markEpochBegin(idx, epoch);
              }
            } catch {
              // Malformed progress report — ignore
            }
            return;
          }

          // ── CR:: lines (tqdm progress bars) ───────────────────
          // Replace the last log line to emulate in-place overwriting.
          if (isCarriageReturn) {
            // Parse epoch/loss from tqdm line for progress bar updates
            const tqdmMatch = line.match(
              /Epoch (\d+):\s+(\d+)%\|.*?loss=([\d.]+)/,
            );
            if (tqdmMatch) {
              const epoch = parseInt(tqdmMatch[1]);
              const loss = parseFloat(tqdmMatch[3]);
              set((s) => ({
                models: s.models.map((m, i) =>
                  // Math.max: never let the 0-based tqdm epoch regress the
                  // 1-based completed count (see the flushStdout path).
                  i === idx ? { ...m, epoch: Math.max(m.epoch, epoch), loss } : m,
                ),
              }));
            }

            // Strip ANSI escape codes for clean display
            const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
            if (!clean) return;

            // Replace last log line (carriage return behavior)
            set((s) => ({
              log: s.log.length > 0
                ? appendLog(s.log.slice(0, -1), clean)
                : [clean],
            }));
            return;
          }

          // ── JSON progress (e.g. from --gui flag) ──────────────
          try {
            const data = JSON.parse(line);
            if ("epoch" in data) {
              set((s) => ({
                models: s.models.map((m, i) =>
                  i === idx
                    ? {
                        ...m,
                        epoch: data.epoch ?? m.epoch,
                        loss: data.loss ?? m.loss,
                        valLoss: data.val_loss ?? m.valLoss,
                        bestValLoss:
                          data.val_loss != null &&
                          (m.bestValLoss === null || data.val_loss < m.bestValLoss)
                            ? data.val_loss
                            : m.bestValLoss,
                      }
                    : m,
                ),
                log: appendLog(
                  s.log,
                  `[Epoch ${data.epoch}/${s.models[idx]?.maxEpochs}] loss: ${data.loss?.toFixed(4) ?? "?"} | val_loss: ${data.val_loss?.toFixed(4) ?? "?"}${
                    data.val_loss != null &&
                    (s.models[idx]?.bestValLoss === null || data.val_loss < (s.models[idx]?.bestValLoss ?? Infinity))
                      ? " *** best ***"
                      : ""
                  }`,
                ),
              }));
              return;
            }
          } catch {
            // Not JSON — continue
          }

          // ── Filter empty lines ────────────────────────────────
          if (!line.trim()) return;

          // ── wandb URL detection (from regular log lines) ──────
          if (line.includes("wandb.ai/")) {
            // Strip trailing punctuation that may be captured from JSON context
            const urlMatch = line.match(/(https:\/\/wandb\.ai\/[^\s"}\]>)]+)/);
            if (urlMatch) set({ wandbUrl: urlMatch[1] });
          }

          // ── Regular log line — append to shared log ───────────
          set((s) => ({ log: appendLog(s.log, line) }));
        }, {
          expectedCompletions: numModels,
          onModelComplete: () => {
            // A model finished — advance to the next one
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

        if (result.success) {
          set((s) => ({
            status: "completed",
            // Only mark models that actually ran as completed;
            // leave pending models as-is (e.g. after stop early)
            models: s.models.map((m) =>
              m.status === "running"
                ? { ...m, status: "completed" as const }
                : m,
            ),
          }));
        } else {
          set((s) => ({
            status: "error",
            error: result.error || "Training failed",
            models: s.models.map((m) =>
              m.status === "running"
                ? { ...m, status: "failed" as const }
                : m,
            ),
          }));
        }
      } catch (e) {
        set({
          status: "error",
          error: `Remote training error: ${e instanceof Error ? e.message : String(e)}`,
        });
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

      // Holder for the ZMQ progress-relay subscription; cleaned up in finally.
      let unlistenProgress: (() => void) | null = null;
      const batchBuffer: { epoch: number; batch: number; loss: number }[] = [];
      let batchFlushTimer: ReturnType<typeof setInterval> | null = null;

      // sleap-nn's tqdm progress bar repaints via carriage return many times/sec, and
      // Tauri splits stdout on \r, so each repaint arrives as its own line event.
      // Applying them per-line previously caused an unthrottled re-render storm that
      // froze the UI (#128 follow-up). Buffer raw lines and flush ~4x/sec, coalescing
      // consecutive tqdm progress lines into a single in-place-updating log line.
      const stdoutBuffer: string[] = [];
      // Recent stderr lines only, to surface the real cause in the error banner.
      const stderrTail: string[] = [];
      let stdoutFlushTimer: ReturnType<typeof setInterval> | null = null;
      const flushStdout = () => {
        if (stdoutBuffer.length === 0) return;
        const lines = stdoutBuffer.splice(0, stdoutBuffer.length);
        const idx = get().currentModelIndex;
        // Latest tqdm epoch/loss in this batch drives the live per-model progress.
        let tqdmEpoch: number | null = null;
        let tqdmLoss: number | null = null;
        for (const l of lines) {
          const m = l.match(/Epoch (\d+):\s+(\d+)%\|.*?loss=([\d.]+)/);
          if (m) { tqdmEpoch = parseInt(m[1]); tqdmLoss = parseFloat(m[3]); }
        }
        set((s) => ({
          log: mergeStdoutIntoLog(s.log, lines),
          models:
            tqdmEpoch !== null
              ? s.models.map((m, j) =>
                  j === idx
                    ? {
                        ...m,
                        // tqdm's epoch is 0-based and its ~250ms flush can land
                        // AFTER recordEpoch's 1-based completed count — Math.max
                        // keeps it from dragging the final "5/5" back to "4/5".
                        epoch: Math.max(m.epoch, tqdmEpoch as number),
                        loss: tqdmLoss ?? m.loss,
                      }
                    : m,
                )
              : s.models,
        }));
      };
      stdoutFlushTimer = setInterval(flushStdout, 250);

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

          const configYaml = applyHyperparamsToYaml(cf.content, cf.hyperparams, cf.checkpointPath);
          // Default run name matches legacy SLEAP's format exactly:
          // `{timestamp}.{head_name}.n={num_user_labeled_frames}`
          // (sleap/gui/learning/runners.py get_timestamp() + base_run_name) —
          // the `n=` count is the project's training-data size at the moment
          // training starts, which is what made the old scheme's "which run
          // used how much data" comparisons useful across a project's history.
          let runName = cf.hyperparams.runName;
          if (!runName) {
            const { useAppStore } = await import("@/stores/appStore");
            const n = countUserLabeledFrames(useAppStore.getState().labels);
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
              // flush (flushStdout). NEVER set() per line — that is the freeze.
              if (line.trim()) stdoutBuffer.push(line);
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

        // ── Post-training inference ───────────────────────────
        const inferenceTarget = localOpts?.inferenceTarget;
        if (inferenceTarget && inferenceTarget !== "nothing" && trainedModelPaths.length > 0) {
          set((s) => ({
            log: appendLog(s.log, `— Training complete. Running inference (${inferenceTarget}) with models: ${trainedModelPaths.join(", ")}...`),
          }));

          const { runInference } = await import("@/platform/backend");
          const { useAppStore } = await import("@/stores/appStore");
          const { loadSlp } = await import("@talmolab/sleap-io.js");
          const { commandContext } = await import("@/commands");
          const { MergePredictions } = await import("@/commands/editCommands");
          const getPlatform = (await import("@/platform")).getPlatform;

          const pipelineMap: Record<string, import("@/stores/inferenceStore").PipelineType> = {
            single_animal: "single-animal",
            top_down: "top-down",
            bottom_up: "bottom-up",
            top_down_id: "top-down-id",
            bottom_up_id: "bottom-up-id",
          };
          const inferenceConfig: import("@/stores/inferenceStore").InferenceConfig = {
            pipeline: pipelineMap[config.modelType] || "top-down",
            modelPaths: trainedModelPaths,
            videoIndex: (inferenceTarget === "video" || inferenceTarget === "random_video")
              ? (() => {
                  const { labels, video } = useAppStore.getState();
                  return labels && video ? labels.videos.indexOf(video) : 0;
                })()
              : "all",
            frameRange: inferenceTarget as import("@/stores/inferenceStore").InferenceConfig["frameRange"],
            sampleCount: localOpts?.sampleCount ?? 20,
            excludeUserLabeled: localOpts?.skipUserLabeled ?? false,
            batchSize: 4,
            device: "auto",
            maxInstances: null,
            peakThreshold: 0.2,
            integralRefinement: true,
            integralPatchSize: 5,
            nPoints: 10,
            maxEdgeLengthRatio: 0.25,
            distPenaltyWeight: 1.0,
            minLineScores: 0.25,
            tracking: true,
            trackerMethod: "simple",
            similarityMethod: "oks",
            matchingMethod: "hungarian",
            trackingWindowSize: 5,
            maxTracks: null,
            connectSingleBreaks: false,
            robust: 0.95,
            flowImgScale: 1.0,
            flowWindowSize: 21,
            flowMaxLevels: 3,
            ensureChannels: "auto",
            filterOverlapping: false,
            filterMethod: "iou",
            filterThreshold: 0.8,
          };

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
              await commandContext.execute(MergePredictions, { predictions });
            };

            if (inferenceTarget === "random") {
              // Per-video random sampling
              const videos = currentLabels?.videos ?? [];
              for (let vi = 0; vi < videos.length; vi++) {
                const nFrames = videos[vi].shape?.[0] ?? 0;
                if (nFrames === 0) continue;
                set((s) => ({ log: appendLog(s.log, `— Inference: video ${vi + 1}/${videos.length}...`) }));
                const perVideoConfig = { ...inferenceConfig, videoIndex: vi as number | "all", frameRange: "random_video" as typeof inferenceConfig.frameRange };
                const result = await runInference(perVideoConfig, projectPath, logEvent);
                if (result.success && result.outputPath) {
                  await mergeOutputSlp(result.outputPath);
                }
              }
            } else {
              const result = await runInference(inferenceConfig, projectPath, logEvent);
              if (result.success && result.outputPath) {
                await mergeOutputSlp(result.outputPath);
              } else if (!result.success) {
                set((s) => ({ log: appendLog(s.log, "— Post-training inference failed (non-zero exit).") }));
              }
            }
            set((s) => ({ log: appendLog(s.log, "— Predictions merged into project.") }));
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
        if (stdoutFlushTimer) { clearInterval(stdoutFlushTimer); stdoutFlushTimer = null; }
        flushStdout(); // drain any remaining buffered stdout into the log
        if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
        try { await stopProgressRelay(); } catch { /* ignore */ }
        try { await stopZmqRelay(); } catch { /* ignore */ }
      }
    }
  },

  stopTraining: async () => {
    if (get()._isRemote) {
      // Remote: send CONTROL_COMMAND for graceful early stop
      const { useConnectStore } = await import("@/stores/connectStore");
      const { sendControlCommand } = useConnectStore.getState();
      sendControlCommand("stop");
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
      // Remote: send JOB_CANCEL
      const { useConnectStore } = await import("@/stores/connectStore");
      const { cancelJob } = useConnectStore.getState();
      cancelJob("current");
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
}));
