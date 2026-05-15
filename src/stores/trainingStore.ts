import { create } from "zustand";
import yaml from "js-yaml";
import { cancelCommand } from "@/platform/backend";
import { isTauri } from "@/platform";

// ── Types ─────────────────────────────────────────────────────────

export type ModelType =
  | "single_animal"
  | "top_down"
  | "bottom_up"
  | "top_down_id"
  | "bottom_up_id";

export type Backbone = "unet" | "convnext" | "swint";

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
  trainingMode: "reuse_config" | "resume" | "reuse_model";
  accelerator: "auto" | "cuda" | "mps" | "cpu";
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
};

export interface ConfigFile {
  filename: string;
  content: string; // raw YAML text
  modelType: string; // parsed from head_configs (e.g., "centroid")
  slot: string; // which slot this fills (e.g., "centroid", "centered_instance", "config")
  hyperparams: ConfigHyperparams; // per-config hyperparameters
  hasTrainedModel: boolean; // true if config has a non-empty run_name (trained model exists)
}

export interface RemoteTrainingOptions {
  remote: true;
  workerId: string;
  labelsPath: string; // path on worker
  valLabelsPath?: string;
  inferenceTarget?: string;
}

export type TrainingStatus = "idle" | "running" | "completed" | "error" | "stopped";

export interface ModelProgress {
  label: string;
  epoch: number;
  maxEpochs: number;
  loss: number | null;
  valLoss: number | null;
  bestValLoss: number | null;
  status: "pending" | "running" | "completed" | "failed";
}

interface TrainingState {
  // Config
  config: TrainingConfig;

  // Status
  status: TrainingStatus;
  error: string | null;
  startedAt: number | null;
  _stopRequested: boolean;
  _isRemote: boolean;

  // Progress
  models: ModelProgress[];
  currentModelIndex: number;
  wandbUrl: string | null;
  modelOutputDirs: string[];
  log: string[]; // single shared log for all models

  // Actions
  setConfig: <K extends keyof TrainingConfig>(key: K, value: TrainingConfig[K]) => void;
  updateConfigHyperparams: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  addConfigFile: (file: ConfigFile) => void;
  removeConfigFile: (slot: string) => void;
  parseYamlConfig: (yamlText: string, filename: string, slot: string) => ConfigFile | null;
  reset: () => void;
  startTraining: (remoteOpts?: RemoteTrainingOptions) => Promise<void>;
  stopTraining: () => Promise<void>;
  cancelTraining: () => Promise<void>;
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

// ── YAML override helper ─────────────────────────────────────────

/** Apply ConfigHyperparams overrides to raw YAML config content. */
export function applyHyperparamsToYaml(yamlText: string, hp: ConfigHyperparams): string {
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
  if (!trainer.train_data_loader) trainer.train_data_loader = {};
  (trainer.train_data_loader as Record<string, unknown>).batch_size = hp.batchSize;
  if (!trainer.optimizer) trainer.optimizer = {};
  (trainer.optimizer as Record<string, unknown>).lr = hp.learningRate;
  if (hp.runName) trainer.run_name = hp.runName;

  // W&B
  trainer.use_wandb = hp.useWandb;
  if (hp.useWandb) {
    if (!trainer.wandb) trainer.wandb = {};
    const wandb = trainer.wandb as Record<string, unknown>;
    if (hp.wandbEntity) wandb.entity = hp.wandbEntity;
    if (hp.wandbProject) wandb.project = hp.wandbProject;
  }

  // Data config
  data.validation_fraction = hp.validationFraction;
  data.use_same_data_for_val = hp.overfitMode;

  // Data — preprocessing
  if (!data.preprocessing) data.preprocessing = {};
  const preprocessing = data.preprocessing as Record<string, unknown>;
  preprocessing.scale = hp.scale;
  preprocessing.crop_size = hp.cropSize;

  // Seed
  trainer.seed = hp.randomSeed;

  // Override accelerator so configs from CUDA machines work on CPU/MPS
  trainer.trainer_accelerator = hp.accelerator;

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
  startedAt: null as number | null,
  _stopRequested: false,
  _isRemote: false,
  models: [] as ModelProgress[],
  currentModelIndex: 0,
  wandbUrl: null as string | null,
  modelOutputDirs: [] as string[],
  log: [] as string[],
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

  parseYamlConfig: (yamlText: string, filename: string, slot: string): ConfigFile | null => {
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
        runName: typeof trainer.run_name === "string" ? trainer.run_name : "",
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
        accelerator: (typeof trainer.trainer_accelerator === "string" ? trainer.trainer_accelerator : "auto") as ConfigHyperparams["accelerator"],
      };

      // Also auto-fill data paths into the global config
      const trainLabels = dataConfig.train_labels_path;
      const valLabels = dataConfig.val_labels_path;
      const configUpdates: Partial<TrainingConfig> = {};
      if (typeof trainLabels === "string") configUpdates.trainingLabelsPath = trainLabels;
      if (Array.isArray(trainLabels) && trainLabels.length > 0) configUpdates.trainingLabelsPath = trainLabels[0];
      if (typeof valLabels === "string") configUpdates.validationLabelsPath = valLabels;
      if (Object.keys(configUpdates).length > 0) {
        set((state) => ({ config: { ...state.config, ...configUpdates } }));
      }

      return {
        filename,
        content: yamlText,
        modelType: detectedModelType,
        slot,
        hyperparams,
        hasTrainedModel,
      };
    } catch (err) {
      console.warn("[training] Failed to parse YAML:", err);
      return null;
    }
  },

  reset: () => set({ ...initialState, config: { ...initialConfig } }),

  startTraining: async (remoteOpts?: RemoteTrainingOptions) => {
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
      };
    });

    set({
      status: "running",
      error: null,
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

      // Build TrainJobSpec with path_mappings — apply hyperparam overrides to YAML
      const spec = {
        type: "train" as const,
        config_contents: config.configs.map((c) => applyHyperparamsToYaml(c.content, c.hyperparams)),
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
                const trainLoss = logs["train/loss"] ?? logs["loss"];
                const valLoss = logs["val/loss"];
                const epoch = data.epoch ?? data.py_dict?.epoch;
                set((s) => ({
                  models: s.models.map((m, i) =>
                    i === idx
                      ? {
                          ...m,
                          epoch: typeof epoch === "number" ? epoch + 1 : m.epoch,
                          loss: trainLoss ?? m.loss,
                          valLoss: valLoss ?? m.valLoss,
                          bestValLoss:
                            valLoss != null &&
                            (m.bestValLoss === null || valLoss < m.bestValLoss)
                              ? valLoss
                              : m.bestValLoss,
                        }
                      : m,
                  ),
                }));
              }

              if (event === "epoch_begin") {
                const epoch = data.epoch ?? data.py_dict?.epoch;
                if (typeof epoch === "number") {
                  set((s) => ({
                    models: s.models.map((m, i) =>
                      i === idx ? { ...m, epoch } : m,
                    ),
                  }));
                }
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
                  i === idx ? { ...m, epoch, loss } : m,
                ),
              }));
            }

            // Strip ANSI escape codes for clean display
            const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
            if (!clean) return;

            // Replace last log line (carriage return behavior)
            set((s) => ({
              log: s.log.length > 0
                ? [...s.log.slice(0, -1), clean]
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
                log: [
                  ...s.log,
                  `[Epoch ${data.epoch}/${s.models[idx]?.maxEpochs}] loss: ${data.loss?.toFixed(4) ?? "?"} | val_loss: ${data.val_loss?.toFixed(4) ?? "?"}${
                    data.val_loss != null &&
                    (s.models[idx]?.bestValLoss === null || data.val_loss < (s.models[idx]?.bestValLoss ?? Infinity))
                      ? " *** best ***"
                      : ""
                  }`,
                ],
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
          set((s) => ({ log: [...s.log, line] }));
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
                log: [...s.log, `— ${s.models[idx]?.label} completed, starting ${s.models[nextIdx]?.label ?? "next model"}...`],
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

      const { runTraining, startTrainingController, stopTrainingController } = await import("@/platform/backend");
      const labelsPath = config.trainingLabelsPath || (await import("@/stores/appStore")).useAppStore.getState().projectPath || "";
      if (!labelsPath) {
        set({ status: "error", error: "No training labels file selected" });
        return;
      }

      // Start ZMQ controller relay before training so sleap-nn can connect
      await startTrainingController();

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
            log: i > 0 ? [...s.log, `— Starting ${s.models[i]?.label}...`] : s.log,
          }));

          const configYaml = applyHyperparamsToYaml(cf.content, cf.hyperparams);
          const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
          const runName = cf.hyperparams.runName || `${cf.modelType}_${ts}`;

          const result = await runTraining(configYaml, labelsPath, runName, (event) => {
            const state = get();
            const idx = state.currentModelIndex;

            if (event.event === "stdout" || event.event === "stderr") {
              const line = event.data.line;

              // Parse tqdm-style progress
              const tqdmMatch = line.match(/Epoch (\d+):\s+(\d+)%\|.*?loss=([\d.]+)/);
              if (tqdmMatch) {
                const epoch = parseInt(tqdmMatch[1]);
                const loss = parseFloat(tqdmMatch[3]);
                set((s) => ({
                  models: s.models.map((m, j) =>
                    j === idx ? { ...m, epoch, loss } : m,
                  ),
                }));
              }

              // Parse JSON progress
              try {
                const data = JSON.parse(line);
                if ("epoch" in data) {
                  set((s) => ({
                    models: s.models.map((m, j) =>
                      j === idx
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
                  }));
                  return;
                }
              } catch {
                // Not JSON
              }

              // W&B URL detection
              if (line.includes("wandb.ai/")) {
                const urlMatch = line.match(/(https:\/\/wandb\.ai\/[^\s"}\]>)]+)/);
                if (urlMatch) set({ wandbUrl: urlMatch[1] });
              }

              // Model output directory detection (best_ckpt path from sleap-nn)
              const ckptMatch = line.match(/best_ckpt['":\s]+([^\s'",}]+\.ckpt)/);
              if (ckptMatch) {
                const dir = ckptMatch[1].replace(/\/[^/]+$/, "");
                set((s) => {
                  const dirs = [...s.modelOutputDirs];
                  if (!dirs.includes(dir)) dirs.push(dir);
                  return { modelOutputDirs: dirs };
                });
              }

              if (line.trim()) {
                set((s) => ({ log: [...s.log, line] }));
              }
            }
          });

          const wasStopped = get()._stopRequested;
          if (result.success || wasStopped) {
            set((s) => ({
              _stopRequested: false,
              models: s.models.map((m, j) =>
                j === i ? { ...m, status: "completed" as const } : m,
              ),
              log: wasStopped
                ? [...s.log, `— ${s.models[i]?.label} stopped early, moving to next model...`]
                : s.log,
            }));
          } else {
            set((s) => ({
              status: "error",
              error: `Training failed for ${cf.modelType}`,
              models: s.models.map((m, j) =>
                j === i ? { ...m, status: "failed" as const } : m,
              ),
            }));
            return;
          }
        }

        set({ status: "completed" });
      } catch (e) {
        set({
          status: "error",
          error: `Local training error: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        await stopTrainingController();
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
        log: [...s.log, "— Stop Early requested, saving checkpoint..."],
      }));
    } else {
      // Local: send SIGINT — Lightning saves checkpoint and exits
      const { sendTrainingStop } = await import("@/platform/backend");
      set((s) => ({
        _stopRequested: true,
        log: [...s.log, "— Stop Early requested, saving checkpoint..."],
      }));
      await sendTrainingStop();
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
}));
