import { create } from "zustand";
import { loadSlp } from "@talmolab/sleap-io.js";
import type { ProcessEvent } from "@/platform/backend";
import { cancelCommand, runInference } from "@/platform/backend";
import { getPlatform } from "@/platform";
import { commandContext } from "@/commands";
import { MergePredictions } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";

export interface InferenceProgress {
  nProcessed: number;
  nTotal: number;
  rate: number;
  eta: number;
}

export interface InferenceConfig {
  modelPath: string;
  videoIndex: number | "all";
  frameRange: "all" | "labeled" | { start: number; end: number };
  trackingMethod: "simple" | "flow" | "identity";
  maxInstances: number;
}

export type InferenceStatus =
  | "idle"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

interface InferenceState {
  status: InferenceStatus;
  error: string | null;
  progress: InferenceProgress | null;
  log: string[];
  minimized: boolean;
  outputPath: string | null;

  handleProcessEvent: (event: ProcessEvent) => void;
  setMinimized: (minimized: boolean) => void;
  reset: () => void;
  cancelInference: () => Promise<void>;
  startInference: (config: InferenceConfig) => Promise<void>;
  loadAndMergeResults: () => Promise<void>;
}

const initialState = {
  status: "idle" as InferenceStatus,
  error: null as string | null,
  progress: null as InferenceProgress | null,
  log: [] as string[],
  minimized: false,
  outputPath: null as string | null,
};

export const useInferenceStore = create<InferenceState>()((set) => ({
  ...initialState,

  handleProcessEvent: (event: ProcessEvent) => {
    switch (event.event) {
      case "stdout": {
        try {
          const data = JSON.parse(event.data.line);
          if ("n_processed" in data && "n_total" in data) {
            set({
              progress: {
                nProcessed: data.n_processed,
                nTotal: data.n_total,
                rate: data.rate ?? 0,
                eta: data.eta ?? 0,
              },
            });
            return;
          }
        } catch {
          // Not JSON — fall through to log
        }
        set((state) => ({ log: [...state.log, event.data.line] }));
        break;
      }
      case "stderr":
        set((state) => ({ log: [...state.log, event.data.line] }));
        break;
      case "finished":
        if (event.data.success) {
          set({ status: "completed" });
        } else {
          set({
            status: "error",
            error: `Process failed with exit code ${event.data.code}`,
          });
        }
        break;
    }
  },

  setMinimized: (minimized: boolean) => set({ minimized }),

  reset: () => set({ ...initialState }),

  cancelInference: async () => {
    await cancelCommand();
    set({ status: "cancelled" });
  },

  startInference: async (config: InferenceConfig) => {
    set({
      status: "running",
      error: null,
      progress: null,
      log: [],
      minimized: false,
      outputPath: null,
    });

    const labels = useAppStore.getState().labels;
    if (!labels) {
      set({ status: "error", error: "No project loaded" });
      return;
    }

    const { handleProcessEvent } = useInferenceStore.getState();
    const result = await runInference(config, labels, handleProcessEvent);
    if (result.outputPath) {
      set({ outputPath: result.outputPath });
    }
  },

  loadAndMergeResults: async () => {
    const { outputPath } = useInferenceStore.getState();
    if (!outputPath) return;

    try {
      const platform = await getPlatform();
      const bytes = await platform.readFile(outputPath);
      const predictions = await loadSlp(bytes.buffer, {
        openVideos: false,
        h5: { filenameHint: outputPath },
      });

      await commandContext.execute(MergePredictions, { predictions });
      set({ status: "idle" });
    } catch (e) {
      set({
        status: "error",
        error: `Failed to load results: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
}));
