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

export type PipelineType =
  | "top-down"
  | "bottom-up"
  | "single-animal"
  | "top-down-id"
  | "bottom-up-id";

export interface InferenceConfig {
  // Pipeline
  pipeline: PipelineType;
  modelPaths: string[];

  // Data
  videoIndex: number | "all";
  frameRange: "all" | "labeled" | "suggested" | { start: number; end: number };
  excludeUserLabeled: boolean;

  // Inference
  batchSize: number;
  device: "auto" | "cuda" | "cpu" | "mps";
  maxInstances: number | null;
  peakThreshold: number;
  anchorPart: string | null;

  // Bottom-up advanced
  integralRefinement: boolean;
  integralPatchSize: number;
  nPoints: number;
  maxEdgeLengthRatio: number;
  distPenaltyWeight: number;
  minLineScores: number;

  // Tracking
  tracking: boolean;
  trackerMethod: "simple" | "flow";
  similarityMethod: "oks" | "iou" | "centroids" | "euclidean_dist";
  matchingMethod: "hungarian" | "greedy";
  trackingWindowSize: number;
  maxTracks: number | null;
  connectSingleBreaks: boolean;

  // Optical flow
  flowImgScale: number;
  flowWindowSize: number;
  flowMaxLevels: number;

  // Post-processing
  filterOverlapping: boolean;
  filterMethod: "iou" | "oks";
  filterThreshold: number;
}

export interface RemoteInferenceOptions {
  remote: true;
  dataPath: string;
  workerId: string;
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
  startedAt: number | null;

  handleProcessEvent: (event: ProcessEvent) => void;
  setMinimized: (minimized: boolean) => void;
  reset: () => void;
  cancelInference: () => Promise<void>;
  startInference: (config: InferenceConfig, remoteOpts?: RemoteInferenceOptions) => Promise<void>;
  loadAndMergeResults: () => Promise<void>;
}

const initialState = {
  status: "idle" as InferenceStatus,
  error: null as string | null,
  progress: null as InferenceProgress | null,
  log: [] as string[],
  minimized: false,
  outputPath: null as string | null,
  startedAt: null as number | null,
};

export const useInferenceStore = create<InferenceState>()((set) => ({
  ...initialState,

  handleProcessEvent: (event: ProcessEvent) => {
    switch (event.event) {
      case "stdout": {
        const line = event.data.line;
        console.log("[inference:stdout]", line);
        try {
          const data = JSON.parse(line);
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
        set((state) => ({ log: [...state.log, line] }));
        break;
      }
      case "stderr": {
        const line = event.data.line;
        console.warn("[inference:stderr]", line);
        set((state) => ({ log: [...state.log, line] }));
        break;
      }
      case "finished": {
        console.log(
          "[inference] Process finished: code=%s success=%s",
          event.data.code,
          event.data.success
        );
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
    }
  },

  setMinimized: (minimized: boolean) => set({ minimized }),

  reset: () => set({ ...initialState }),

  cancelInference: async () => {
    await cancelCommand();
    set({ status: "cancelled" });
  },

  startInference: async (config: InferenceConfig, remoteOpts?: RemoteInferenceOptions) => {
    set({
      status: "running",
      error: null,
      progress: null,
      log: [],
      minimized: false,
      outputPath: null,
      startedAt: Date.now(),
    });

    if (remoteOpts?.remote) {
      // ── Remote inference via WebRTC ────────────────────────
      const { useConnectStore } = await import("@/stores/connectStore");
      const { submitJob } = useConnectStore.getState();
      const { handleProcessEvent } = useInferenceStore.getState();

      // Build TrackJobSpec from InferenceConfig
      const spec = {
        type: "track" as const,
        data_path: remoteOpts.dataPath,
        model_paths: config.modelPaths,
        batch_size: config.batchSize,
        peak_threshold: config.peakThreshold,
        only_suggested_frames: config.frameRange === "suggested",
        frames: typeof config.frameRange === "object"
          ? `${config.frameRange.start}-${config.frameRange.end}`
          : undefined,
      };

      // Log the spec
      set((state) => ({
        log: [`$ Remote: ${JSON.stringify(spec, null, 2)}`, ...state.log],
      }));

      try {
        const result = await submitJob(spec, (line: string) => {
          // Parse progress lines the same way as local stdout
          handleProcessEvent({
            event: "stdout",
            data: { line },
          });
        });

        if (result.success) {
          set({
            status: "completed",
            outputPath: result.outputPath || null,
          });
        } else {
          set({
            status: "error",
            error: result.error || "Remote inference failed",
          });
        }
      } catch (e) {
        set({
          status: "error",
          error: `Remote inference error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } else {
      // ── Local inference via subprocess (existing code) ─────
      const { projectPath, labels } = useAppStore.getState();
      if (!labels) {
        set({ status: "error", error: "No project loaded" });
        return;
      }

      console.log("[inference] Starting with config:", config);
      const { handleProcessEvent } = useInferenceStore.getState();
      try {
        const result = await runInference(config, projectPath, handleProcessEvent);
        if (result.command) {
          set((state) => ({
            log: [`$ ${result.command}`, ...state.log],
          }));
        }
        if (result.outputPath) {
          set({ outputPath: result.outputPath });
        }
      } catch (e) {
        set({
          status: "error",
          error: `Failed to start inference: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
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
