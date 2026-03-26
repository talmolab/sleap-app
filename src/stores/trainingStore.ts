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

export type Backbone = "UNet" | "LEAP CNN" | "Stacked Hourglass";

export interface TrainingConfig {
  // Model
  modelType: ModelType;
  configs: ConfigFile[];

  // Data
  trainingLabelsPath: string;
  validationLabelsPath: string;

  // Hyperparameters
  backbone: Backbone | "";
  maxEpochs: number;
  batchSize: number;
  learningRate: number;
  runName: string;

  // Tracking
  wandbEntity: string;
  wandbProject: string;
}

export interface ConfigFile {
  filename: string;
  content: string; // raw YAML text
  modelType: string; // parsed from head_configs (e.g., "centroid")
  slot: string; // which slot this fills (e.g., "centroid", "centered_instance", "config")
}

export interface RemoteTrainingOptions {
  remote: true;
  workerId: string;
  labelsPath: string; // path on worker
  valLabelsPath?: string;
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
  log: string[];
}

interface TrainingState {
  // Config
  config: TrainingConfig;

  // Status
  status: TrainingStatus;
  error: string | null;
  startedAt: number | null;

  // Progress (multi-model)
  models: ModelProgress[];
  currentModelIndex: number;
  wandbUrl: string | null;

  // Actions
  setConfig: <K extends keyof TrainingConfig>(key: K, value: TrainingConfig[K]) => void;
  addConfigFile: (file: ConfigFile) => void;
  removeConfigFile: (slot: string) => void;
  parseYamlConfig: (yamlText: string, filename: string, slot: string) => ConfigFile | null;
  autoFillFromConfig: (configFile: ConfigFile) => void;
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

// ── Initial state ─────────────────────────────────────────────────

const initialConfig: TrainingConfig = {
  modelType: "top_down",
  configs: [],
  trainingLabelsPath: "",
  validationLabelsPath: "",
  backbone: "",
  maxEpochs: 100,
  batchSize: 4,
  learningRate: 0.0001,
  runName: "",
  wandbEntity: "",
  wandbProject: "",
};

const initialState = {
  config: { ...initialConfig },
  status: "idle" as TrainingStatus,
  error: null as string | null,
  startedAt: null as number | null,
  models: [] as ModelProgress[],
  currentModelIndex: 0,
  wandbUrl: null as string | null,
};

// ── Store ─────────────────────────────────────────────────────────

export const useTrainingStore = create<TrainingState>()((set, get) => ({
  ...initialState,

  setConfig: (key, value) =>
    set((state) => ({
      config: { ...state.config, [key]: value },
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

      return {
        filename,
        content: yamlText,
        modelType: detectedModelType,
        slot,
      };
    } catch (err) {
      console.warn("[training] Failed to parse YAML:", err);
      return null;
    }
  },

  autoFillFromConfig: (configFile: ConfigFile) => {
    try {
      const doc = yaml.load(configFile.content) as Record<string, unknown>;
      if (!doc || typeof doc !== "object") return;

      const trainer = (doc.trainer_config ?? doc.trainer ?? doc) as Record<string, unknown>;
      const wandb = (trainer.wandb ?? (doc as Record<string, unknown>).wandb ?? {}) as Record<string, unknown>;
      const dataConfig = (doc.data_config ?? {}) as Record<string, unknown>;
      const modelConfig = (doc.model_config ?? {}) as Record<string, unknown>;

      // Extract backbone from model config
      const backbone = (modelConfig.backbone ?? "") as string;
      const backboneMap: Record<string, Backbone> = {
        "unet": "UNet",
        "leap": "LEAP CNN",
        "leap_cnn": "LEAP CNN",
        "hourglass": "Stacked Hourglass",
        "stacked_hourglass": "Stacked Hourglass",
      };

      const updates: Partial<TrainingConfig> = {};

      const trainLoader = (trainer.train_data_loader ?? {}) as Record<string, unknown>;
      const optimizer = (trainer.optimizer ?? {}) as Record<string, unknown>;

      const batchSize = trainLoader.batch_size ?? trainer.batch_size;
      if (typeof batchSize === "number") updates.batchSize = batchSize;

      const lr = optimizer.lr ?? trainer.learning_rate;
      if (typeof lr === "number") updates.learningRate = lr;

      const maxEpochs = trainer.max_epochs;
      if (typeof maxEpochs === "number") updates.maxEpochs = maxEpochs;

      const runName = trainer.run_name ?? wandb.name ?? wandb.run_name;
      if (typeof runName === "string") updates.runName = runName;

      const wandbProject = wandb.project;
      if (typeof wandbProject === "string") updates.wandbProject = wandbProject;

      const wandbEntity = wandb.entity;
      if (typeof wandbEntity === "string") updates.wandbEntity = wandbEntity;

      const trainLabels = dataConfig.train_labels_path;
      if (typeof trainLabels === "string") updates.trainingLabelsPath = trainLabels;
      if (Array.isArray(trainLabels) && trainLabels.length > 0) updates.trainingLabelsPath = trainLabels[0];

      const valLabels = dataConfig.val_labels_path;
      if (typeof valLabels === "string") updates.validationLabelsPath = valLabels;

      if (backbone && backboneMap[backbone.toLowerCase()]) {
        updates.backbone = backboneMap[backbone.toLowerCase()];
      }

      set((state) => ({
        config: { ...state.config, ...updates },
      }));
    } catch (err) {
      console.warn("[training] Failed to auto-fill from config:", err);
    }
  },

  reset: () => set({ ...initialState, config: { ...initialConfig } }),

  startTraining: async (remoteOpts?: RemoteTrainingOptions) => {
    const { config } = get();

    // Build model progress entries
    const slots = getConfigSlots(config.modelType);
    const models: ModelProgress[] = slots.map((slot) => ({
      label: getSlotLabel(slot).replace(" Config", ""),
      epoch: 0,
      maxEpochs: config.maxEpochs,
      loss: null,
      valLoss: null,
      bestValLoss: null,
      status: "pending",
      log: [],
    }));

    set({
      status: "running",
      error: null,
      startedAt: Date.now(),
      models,
      currentModelIndex: 0,
      wandbUrl: null,
    });

    if (remoteOpts?.remote) {
      // ── Remote training via WebRTC ────────────────────────
      const { useConnectStore } = await import("@/stores/connectStore");
      const { submitJob } = useConnectStore.getState();

      // Build TrainJobSpec
      const spec = {
        type: "train" as const,
        config_contents: config.configs.map((c) => c.content),
        model_types: config.configs.map((c) => c.modelType),
        labels_path: remoteOpts.labelsPath,
        val_labels_path: remoteOpts.valLabelsPath || undefined,
        max_epochs: config.maxEpochs,
        batch_size: config.batchSize,
        learning_rate: config.learningRate,
        run_name: config.runName || undefined,
      };

      set((state) => ({
        models: state.models.map((m, i) =>
          i === 0 ? { ...m, status: "running" as const } : m,
        ),
      }));

      try {
        const result = await submitJob(spec, (line: string) => {
          // Parse progress from worker
          const state = get();
          const idx = state.currentModelIndex;
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
                        log: [
                          ...m.log,
                          `[Epoch ${data.epoch}/${m.maxEpochs}] loss: ${data.loss?.toFixed(4) ?? "?"} | val_loss: ${data.val_loss?.toFixed(4) ?? "?"}${
                            data.val_loss != null &&
                            (m.bestValLoss === null || data.val_loss < m.bestValLoss)
                              ? " *** best ***"
                              : ""
                          }`,
                        ],
                      }
                    : m,
                ),
              }));
            }
          } catch {
            // Plain text log line — check for wandb URL
            if (line.includes("wandb.ai/")) {
              const urlMatch = line.match(/(https:\/\/wandb\.ai\/\S+)/);
              if (urlMatch) set({ wandbUrl: urlMatch[1] });
            }
            // Append to current model log
            set((s) => ({
              models: s.models.map((m, i) =>
                i === idx ? { ...m, log: [...m.log, line] } : m,
              ),
            }));
          }
        });

        if (result.success) {
          set((s) => ({
            status: "completed",
            models: s.models.map((m) => ({ ...m, status: "completed" as const })),
          }));
        } else {
          set((s) => ({
            status: "error",
            error: result.error || "Training failed",
            models: s.models.map((m, i) =>
              i === s.currentModelIndex && m.status === "running"
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
    // Send JOB_STOP for graceful stop with checkpoint
    try {
      const { useConnectStore } = await import("@/stores/connectStore");
      const { _dc } = useConnectStore.getState();
      if (_dc && _dc.readyState === "open") {
        const { buildMessage, MSG_JOB_STOP } = await import("@/lib/sleapConnect");
        _dc.send(buildMessage(MSG_JOB_STOP));
      } else {
        await cancelCommand();
      }
      set({ status: "stopped" });
    } catch (e) {
      console.warn("[training] Failed to stop:", e);
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
