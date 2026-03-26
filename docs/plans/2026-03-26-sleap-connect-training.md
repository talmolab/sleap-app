# sleap-connect Training Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a TrainingPanel sidebar tab that supports both local and remote (sleap-connect) training, with YAML config upload, auto-fill, per-epoch progress, and multi-model sequential training for top-down pipelines.

**Branch:** `amick/sleap-connect-training` (off latest `main` which includes the sleap-connect inference MVP)

**Working directory:** `/Users/amickl/repos/sleap-app`

**Prototype:** `docs/prototypes/training-panel-prototype.html` — open in browser to see all 7 scenarios

---

## Architecture Overview

**New components:**

1. **TrainingPanel** — new sidebar tab (GraduationCap icon) with 6 collapsible sections: Model Type & Configs, Data, Hyperparameters, Tracking (W&B), Remote, Progress
2. **trainingStore** — Zustand store managing training state, config parsing, job submission, and progress tracking

**Modified components:**

1. **AppShell.tsx** — register TrainingPanel in PANELS array with GraduationCap icon, after Inference
2. **appStore.ts** — add "training" to default panelOrder
3. **sleapConnect.ts** — add training-related protocol constants (MSG_JOB_STOP)

**Reused from inference MVP (no changes needed):**

- **connectStore** — WebSocket/WebRTC connection, worker selection, `submitJob()`
- **RemoteFileBrowser** — browse worker filesystem for .slp data files
- **ConnectPanel** — login, room, worker connection

**Key design decisions:**

- Default mode is **local training** (like inference). Remote is an opt-in toggle.
- Config files are **uploaded from the user's local machine** (not read from worker filesystem), parsed client-side with `js-yaml`, and sent as `config_content` in the `TrainJobSpec`. This matches the sleap-rtc dashboard pattern.
- All auto-filled fields from config are **editable** — changes become Hydra overrides on submission.
- For top-down, user selects model type first, then uploads centroid + centered_instance configs separately. These train sequentially.
- Training controls: "Stop Early" (JOB_STOP, saves checkpoint) and "Cancel" (JOB_CANCEL, hard kill).
- Progress shows per-epoch log lines, progress bar, loss/val_loss, wandb link, per-model for multi-model runs.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, js-yaml (for YAML parsing), Vitest

**Protocol reference:**
- `sleap_rtc/jobs/spec.py` — `TrainJobSpec` dataclass
- `sleap_rtc/jobs/builder.py` — `build_train_command()` / `build_train_commands()`
- `sleap_rtc/protocol.py` — `MSG_JOB_SUBMIT`, `MSG_JOB_STOP`, `MSG_JOB_CANCEL`, `MSG_JOB_PROGRESS`, `MSG_JOB_COMPLETE`, `MSG_JOB_FAILED`
- Dashboard config parsing: `sleap-RTC/dashboard/app.js` lines 2827-2853 (`parseTrainingConfig`)

---

## Task 1: Add js-yaml dependency and training protocol constants

**Files:**
- Modify: `package.json` (add `js-yaml` + `@types/js-yaml`)
- Modify: `src/lib/sleapConnect.ts` (add `MSG_JOB_STOP`)

### Step 1: Install js-yaml

Run: `cd /Users/amickl/repos/sleap-app && npm install js-yaml && npm install -D @types/js-yaml`

### Step 2: Add MSG_JOB_STOP to protocol constants

In `src/lib/sleapConnect.ts`, add after `MSG_JOB_CANCEL`:

```typescript
export const MSG_JOB_STOP = "JOB_STOP";
```

### Step 3: Run build to verify

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 4: Commit

```bash
git add package.json package-lock.json src/lib/sleapConnect.ts
git commit -m "chore: add js-yaml for config parsing and MSG_JOB_STOP protocol constant"
```

---

## Task 2: Create trainingStore

Zustand store managing training configuration, YAML parsing, job submission, and progress tracking.

**Files:**
- Create: `src/stores/trainingStore.ts`
- Test: `tests/unit/trainingStore.test.ts`

### Step 1: Create the store

Create `src/stores/trainingStore.ts`:

```typescript
import { create } from "zustand";
import yaml from "js-yaml";
import type { ProcessEvent } from "@/platform/backend";
import { runPythonCommand, cancelCommand } from "@/platform/backend";
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
          i === 0 ? { ...m, status: "running" } : m,
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
            models: s.models.map((m) => ({ ...m, status: "completed" })),
          }));
        } else {
          set((s) => ({
            status: "error",
            error: result.error || "Training failed",
            models: s.models.map((m, i) =>
              i === s.currentModelIndex && m.status === "running"
                ? { ...m, status: "failed" }
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

      // Build sleap-nn train command args
      const args = ["train"];
      const firstConfig = config.configs[0];
      if (!firstConfig) {
        set({ status: "error", error: "No config file loaded" });
        return;
      }

      // For local, we'd need to write config to a temp file and pass the path
      // For MVP, just show that local training is not yet implemented
      set({ status: "error", error: "Local training coming soon. Use remote training via sleap-connect." });
    }
  },

  stopTraining: async () => {
    // Send JOB_STOP for graceful stop with checkpoint
    try {
      const { useConnectStore } = await import("@/stores/connectStore");
      const { _dc } = useConnectStore.getState();
      if (_dc && _dc.readyState === "open") {
        const { buildMessage } = await import("@/lib/sleapConnect");
        const MSG_JOB_STOP = "JOB_STOP";
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
    } catch (e) {
      await cancelCommand();
      set({ status: "error", error: "Training cancelled" });
    }
  },
}));
```

### Step 2: Write store tests

Create `tests/unit/trainingStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useTrainingStore } from "@/stores/trainingStore";
import { getConfigSlots, getSlotLabel } from "@/stores/trainingStore";

describe("trainingStore", () => {
  beforeEach(() => {
    useTrainingStore.getState().reset();
  });

  describe("initial state", () => {
    it("starts idle with default config", () => {
      const state = useTrainingStore.getState();
      expect(state.status).toBe("idle");
      expect(state.config.modelType).toBe("top_down");
      expect(state.config.maxEpochs).toBe(100);
      expect(state.config.batchSize).toBe(4);
      expect(state.config.configs).toEqual([]);
    });
  });

  describe("setConfig", () => {
    it("updates a single config field", () => {
      useTrainingStore.getState().setConfig("maxEpochs", 200);
      expect(useTrainingStore.getState().config.maxEpochs).toBe(200);
    });

    it("updates model type", () => {
      useTrainingStore.getState().setConfig("modelType", "bottom_up");
      expect(useTrainingStore.getState().config.modelType).toBe("bottom_up");
    });
  });

  describe("addConfigFile / removeConfigFile", () => {
    it("adds a config file to the correct slot", () => {
      const file = {
        filename: "centroid.yaml",
        content: "test: true",
        modelType: "centroid",
        slot: "centroid",
      };
      useTrainingStore.getState().addConfigFile(file);
      expect(useTrainingStore.getState().config.configs).toHaveLength(1);
      expect(useTrainingStore.getState().config.configs[0].slot).toBe("centroid");
    });

    it("replaces existing file in same slot", () => {
      const file1 = { filename: "old.yaml", content: "", modelType: "centroid", slot: "centroid" };
      const file2 = { filename: "new.yaml", content: "", modelType: "centroid", slot: "centroid" };
      useTrainingStore.getState().addConfigFile(file1);
      useTrainingStore.getState().addConfigFile(file2);
      expect(useTrainingStore.getState().config.configs).toHaveLength(1);
      expect(useTrainingStore.getState().config.configs[0].filename).toBe("new.yaml");
    });

    it("removes a config file by slot", () => {
      const file = { filename: "test.yaml", content: "", modelType: "centroid", slot: "centroid" };
      useTrainingStore.getState().addConfigFile(file);
      useTrainingStore.getState().removeConfigFile("centroid");
      expect(useTrainingStore.getState().config.configs).toHaveLength(0);
    });
  });

  describe("parseYamlConfig", () => {
    it("parses valid YAML and extracts model type", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  max_epochs: 200
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "centroid.yaml", "centroid");
      expect(result).not.toBeNull();
      expect(result!.modelType).toBe("centroid");
      expect(result!.filename).toBe("centroid.yaml");
    });

    it("returns null for invalid YAML", () => {
      const result = useTrainingStore.getState().parseYamlConfig("not: [valid: yaml", "bad.yaml", "config");
      expect(result).toBeNull();
    });
  });

  describe("autoFillFromConfig", () => {
    it("extracts hyperparameters from config", () => {
      const configFile = {
        filename: "test.yaml",
        content: `
trainer_config:
  max_epochs: 300
  train_data_loader:
    batch_size: 8
  optimizer:
    lr: 0.001
  run_name: my_run
  wandb:
    entity: my-lab
    project: my-project
data_config:
  train_labels_path: /path/to/labels.slp
`,
        modelType: "centroid",
        slot: "centroid",
      };
      useTrainingStore.getState().autoFillFromConfig(configFile);
      const config = useTrainingStore.getState().config;
      expect(config.maxEpochs).toBe(300);
      expect(config.batchSize).toBe(8);
      expect(config.learningRate).toBe(0.001);
      expect(config.runName).toBe("my_run");
      expect(config.wandbEntity).toBe("my-lab");
      expect(config.wandbProject).toBe("my-project");
      expect(config.trainingLabelsPath).toBe("/path/to/labels.slp");
    });
  });

  describe("reset", () => {
    it("resets to initial state", () => {
      useTrainingStore.getState().setConfig("maxEpochs", 999);
      useTrainingStore.getState().reset();
      expect(useTrainingStore.getState().config.maxEpochs).toBe(100);
      expect(useTrainingStore.getState().status).toBe("idle");
    });
  });

  describe("getConfigSlots", () => {
    it("returns two slots for top_down", () => {
      expect(getConfigSlots("top_down")).toEqual(["centroid", "centered_instance"]);
    });

    it("returns one slot for single_animal", () => {
      expect(getConfigSlots("single_animal")).toEqual(["config"]);
    });

    it("returns one slot for bottom_up", () => {
      expect(getConfigSlots("bottom_up")).toEqual(["config"]);
    });
  });

  describe("getSlotLabel", () => {
    it("returns correct labels", () => {
      expect(getSlotLabel("centroid")).toBe("Centroid Config");
      expect(getSlotLabel("centered_instance")).toBe("Centered Instance Config");
      expect(getSlotLabel("config")).toBe("Config");
    });
  });
});
```

### Step 3: Run tests

Run: `cd /Users/amickl/repos/sleap-app && npm test -- --run tests/unit/trainingStore.test.ts`
Expected: PASS

### Step 4: Commit

```bash
git add src/stores/trainingStore.ts tests/unit/trainingStore.test.ts
git commit -m "feat: add trainingStore with YAML config parsing, auto-fill, and job submission"
```

---

## Task 3: Create TrainingPanel component

The sidebar tab with all 6 collapsible sections matching the prototype.

**Files:**
- Create: `src/components/panels/TrainingPanel.tsx`

### Step 1: Create the component

Create `src/components/panels/TrainingPanel.tsx` with the following structure:

- Import dependencies: React hooks, lucide-react icons (GraduationCap, Upload, Folder, X, Loader2, Square, ChevronDown, ChevronRight, ExternalLink, Check, AlertCircle), shadcn/ui components (Button, Select, Input, Separator), stores (useTrainingStore, useConnectStore), RemoteFileBrowser, js-yaml
- Use the existing `Section` component pattern from InferencePanel (collapsible sections with chevron)
- Implement all 6 sections from the prototype:
  1. **Model Type & Configs**: dropdown for model type, config upload slots (drag-drop zones per slot from `getConfigSlots()`), on file drop: parse YAML via `parseYamlConfig()`, add via `addConfigFile()`, auto-fill via `autoFillFromConfig()`
  2. **Data**: training/validation labels paths with browse buttons (local file dialog by default, RemoteFileBrowser when remote enabled)
  3. **Hyperparameters**: backbone select, max epochs, batch size, learning rate, run name — all using `config` state from store
  4. **Tracking (W&B)**: wandb entity and project text inputs
  5. **Remote**: same toggle + worker selector pattern as InferencePanel's Remote section
  6. **Progress**: shown when status !== "idle" — per-model progress bars, epoch log, wandb link, completion/error states

- Bottom buttons:
  - When idle: "Start Training" (local) or "Start Remote Training" (remote enabled)
  - When running: "Stop Early" (yellow, calls `stopTraining()`) + "Cancel" (red, calls `cancelTraining()`)
  - When completed: "Train Again" (calls `reset()`)
  - When error: "Retry" + "New Training"

- Config upload handler:
  ```typescript
  const handleConfigDrop = (slot: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.yaml') || file.name.endsWith('.yml'))) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const parsed = parseYamlConfig(text, file.name, slot);
        if (parsed) {
          addConfigFile(parsed);
          autoFillFromConfig(parsed);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleConfigBrowse = (slot: string) => () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.yaml,.yml';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result as string;
          const parsed = parseYamlConfig(text, file.name, slot);
          if (parsed) {
            addConfigFile(parsed);
            autoFillFromConfig(parsed);
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };
  ```

- canStart logic:
  ```typescript
  const requiredSlots = getConfigSlots(config.modelType);
  const hasAllConfigs = requiredSlots.every(slot => config.configs.some(c => c.slot === slot));
  const hasData = remoteEnabled ? !!remoteLabelsPath : !!config.trainingLabelsPath;
  const canStart = hasAllConfigs && hasData && status === "idle" &&
    (remoteEnabled ? !!selectedWorkerId : true);
  ```

### Step 2: Run build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 3: Commit

```bash
git add src/components/panels/TrainingPanel.tsx
git commit -m "feat: add TrainingPanel with config upload, auto-fill, remote training, and progress display"
```

---

## Task 4: Register TrainingPanel in AppShell

**Files:**
- Modify: `src/components/layout/AppShell.tsx`
- Modify: `src/stores/appStore.ts`

### Step 1: Add TrainingPanel to AppShell

In `src/components/layout/AppShell.tsx`:

Add import (after InferencePanel import):
```typescript
import { TrainingPanel } from "../panels/TrainingPanel";
```

Add icon import (in the lucide-react import block):
```typescript
GraduationCap,
```

Add panel to PANELS array (after the inference entry):
```typescript
  { id: "training", label: "Training", icon: GraduationCap, component: TrainingPanel },
```

### Step 2: Add "training" to default panelOrder

In `src/stores/appStore.ts`, update the `panelOrder` default:

```typescript
panelOrder: ["videos", "skeleton", "instances", "view", "suggestions", "inference", "training", "environment", "connect", "notifications", "debug"],
```

### Step 3: Run build and tests

Run: `cd /Users/amickl/repos/sleap-app && npm run build && npm test -- --run`
Expected: PASS

### Step 4: Commit

```bash
git add src/components/layout/AppShell.tsx src/stores/appStore.ts
git commit -m "feat: register TrainingPanel in AppShell sidebar with GraduationCap icon"
```

---

## Task 5: Handle JOB_STOP in connectStore

Add `JOB_STOP` support so the "Stop Early" button works for remote training.

**Files:**
- Modify: `src/stores/connectStore.ts`

### Step 1: Import MSG_JOB_STOP

Add `MSG_JOB_STOP` to the imports from `@/lib/sleapConnect`.

### Step 2: Add stopJob action

In the ConnectState interface, add:
```typescript
stopJob: () => void;
```

Implement (similar to `cancelJob`):
```typescript
stopJob: () => {
  const { _dc } = get();
  if (_dc && _dc.readyState === "open") {
    _dc.send(buildMessage(MSG_JOB_STOP));
  }
},
```

### Step 3: Run build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 4: Commit

```bash
git add src/stores/connectStore.ts
git commit -m "feat: add stopJob action to connectStore for graceful training stop"
```

---

## Task 6: Integration verification

Verify the full build compiles, all tests pass, and the panel renders correctly.

### Step 1: Run full build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: No errors

### Step 2: Run all tests

Run: `cd /Users/amickl/repos/sleap-app && npm test -- --run`
Expected: All existing tests + new training tests pass

### Step 3: Verify visually

Run: `cd /Users/amickl/repos/sleap-app && npm run dev`
Expected:
- Training tab appears in sidebar (GraduationCap icon, after Inference)
- Clicking Training tab shows the panel with all 6 sections
- Model Type dropdown works, shows correct config slots
- Config upload (browse button) opens file dialog for YAML
- Hyperparameters section shows editable fields
- Remote section shows toggle (disabled when not connected)
- "Start Training" button disabled until config + data provided

### Step 4: Commit any fixes

```bash
git add -A
git commit -m "fix: resolve integration issues from training panel"
```

---

## Summary

| Task | Component | Files | Steps |
|------|-----------|-------|-------|
| 1 | js-yaml + protocol constants | `package.json`, `sleapConnect.ts` | 4 |
| 2 | Training store | `trainingStore.ts` + test | 4 |
| 3 | TrainingPanel component | `TrainingPanel.tsx` | 3 |
| 4 | AppShell registration | `AppShell.tsx`, `appStore.ts` | 4 |
| 5 | JOB_STOP in connectStore | `connectStore.ts` | 4 |
| 6 | Integration verification | — | 4 |

**Total: 6 tasks, ~23 steps**

---

## Conventions Reference

- **Path alias**: `@/` → `./src/` in imports
- **Stores**: Zustand with `create()`, no persist for training store (ephemeral state)
- **Components**: shadcn/ui from `@/components/ui/`, lucide-react icons, Tailwind CSS
- **Panel pattern**: Collapsible `Section` component (see InferencePanel lines 89-115)
- **Remote pattern**: `useConnectStore` for connection state, `RemoteFileBrowser` for filesystem
- **Testing**: Vitest with jsdom, see `tests/unit/` for patterns
- **Build**: `npm run build` for type checking + production build
- **Prototype**: `docs/prototypes/training-panel-prototype.html` for visual reference
