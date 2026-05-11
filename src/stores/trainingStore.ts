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

export type AugmentationPreset = "none" | "light" | "standard" | "heavy" | "custom";

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
  augmentationPreset: AugmentationPreset;
  trainingMode: "reuse_config" | "resume" | "reuse_model";
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
  augmentationPreset: "standard",
  trainingMode: "reuse_config",
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

  // Progress
  models: ModelProgress[];
  currentModelIndex: number;
  wandbUrl: string | null;
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

// ── Augmentation presets ─────────────────────────────────────────

interface AugmentationConfig {
  rotation: number;
  affine_p: number;
  scale_min?: number;
  scale_max?: number;
  uniform_noise_min?: number;
  uniform_noise_max?: number;
  uniform_noise_p?: number;
  gaussian_noise_mean?: number;
  gaussian_noise_std?: number;
  gaussian_noise_p?: number;
  contrast_min?: number;
  contrast_max?: number;
  contrast_p?: number;
  brightness_min?: number;
  brightness_max?: number;
  brightness_p?: number;
}

const AUGMENTATION_PRESETS: Record<AugmentationPreset, AugmentationConfig> = {
  none: { rotation: 0, affine_p: 0 },
  light: { rotation: 15, affine_p: 1.0 },
  standard: {
    rotation: 180,
    affine_p: 1.0,
    gaussian_noise_mean: 0.0,
    gaussian_noise_std: 0.04,
    gaussian_noise_p: 0.5,
  },
  heavy: {
    rotation: 180,
    affine_p: 1.0,
    scale_min: 0.9,
    scale_max: 1.1,
    gaussian_noise_mean: 0.0,
    gaussian_noise_std: 0.04,
    gaussian_noise_p: 0.5,
    contrast_min: 0.75,
    contrast_max: 1.25,
    contrast_p: 0.5,
    brightness_min: 0.0,
    brightness_max: 0.1,
    brightness_p: 0.5,
  },
  custom: { rotation: 180, affine_p: 1.0 },
};

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
  data.scale = hp.scale;

  // Early stopping
  if (!trainer.early_stopping) trainer.early_stopping = {};
  const es = trainer.early_stopping as Record<string, unknown>;
  es.stop_training_on_plateau = true;
  es.patience = hp.earlyStoppingPatience;

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

  // Augmentation preset — skip override for "custom" (user manages augmentation directly)
  if (hp.augmentationPreset !== "custom") {
    const aug = AUGMENTATION_PRESETS[hp.augmentationPreset];
    if (!data.augmentation_config) data.augmentation_config = {};
    const augConfig = data.augmentation_config as Record<string, unknown>;
    augConfig.rotation = aug.rotation;
    augConfig.affine_p = aug.affine_p;
    augConfig.scale_min = aug.scale_min ?? null;
    augConfig.scale_max = aug.scale_max ?? null;
    augConfig.uniform_noise_min = aug.uniform_noise_min ?? 0;
    augConfig.uniform_noise_max = aug.uniform_noise_max ?? 0;
    augConfig.uniform_noise_p = aug.uniform_noise_p ?? 0;
    augConfig.gaussian_noise_mean = aug.gaussian_noise_mean ?? 0;
    augConfig.gaussian_noise_std = aug.gaussian_noise_std ?? 0;
    augConfig.gaussian_noise_p = aug.gaussian_noise_p ?? 0;
    augConfig.contrast_min = aug.contrast_min ?? 0.5;
    augConfig.contrast_max = aug.contrast_max ?? 2.0;
    augConfig.contrast_p = aug.contrast_p ?? 0;
    augConfig.brightness_min = aug.brightness_min ?? 0;
    augConfig.brightness_max = aug.brightness_max ?? 0;
    augConfig.brightness_p = aug.brightness_p ?? 0;
  }

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
  models: [] as ModelProgress[],
  currentModelIndex: 0,
  wandbUrl: null as string | null,
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
        scale: typeof dataConfig.scale === "number" ? dataConfig.scale : 1.0,
        augmentationPreset: "standard",
        trainingMode: "reuse_config" as const,
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
      models,
      currentModelIndex: 0,
      wandbUrl: null,
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

      // For MVP, local training is not yet implemented
      set({ status: "error", error: "Local training coming soon. Use remote training via sleap-connect." });
    }
  },

  stopTraining: async () => {
    // Send CONTROL_COMMAND::{"command":"stop"} — forwarded by the worker
    // to sleap-nn's TrainingControllerZMQ, which does a graceful early
    // stop at the trainer level (saves checkpoint, continues to next
    // model). This matches the PyQt LossViewer's "Stop Early" button.
    //
    // NOT JOB_STOP (which sends SIGINT to the process group and crashes
    // DDP training).
    try {
      const { useConnectStore } = await import("@/stores/connectStore");
      const { sendControlCommand } = useConnectStore.getState();
      sendControlCommand("stop");
      // Keep status running — worker continues to next model or completes
      set((s) => ({
        log: [...s.log, "— Stop Early requested, saving checkpoint..."],
      }));
    } catch (e) {
      console.warn("[training] Failed to stop:", e);
      await cancelCommand();
      set({ status: "stopped" });
    }
  },

  cancelTraining: async () => {
    // Send JOB_CANCEL for hard cancel
    try {
      const { useConnectStore } = await import("@/stores/connectStore");
      const { cancelJob } = useConnectStore.getState();
      cancelJob("current");
      set({ status: "error", error: "Training cancelled" });
    } catch {
      await cancelCommand();
      set({ status: "error", error: "Training cancelled" });
    }
  },
}));
