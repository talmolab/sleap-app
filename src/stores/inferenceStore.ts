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
  | "bottom-up-id"
  | "centroid";

export interface InferenceConfig {
  // Pipeline
  pipeline: PipelineType;
  modelPaths: string[];

  // Data
  videoIndex: number | "all";
  frameRange: "all_videos" | "video" | "suggestions" | "user_labeled" | "predicted" | "random_video" | "random" | "frame" | { start: number; end: number };
  sampleCount: number;
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
  robust: number;

  // Optical flow
  flowImgScale: number;
  flowWindowSize: number;
  flowMaxLevels: number;

  // Preprocessing
  ensureChannels: "auto" | "rgb" | "grayscale";

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

/**
 * Build an InferenceConfig for a standalone centroid-locator `predict` run
 * (active-learning Phase 1). Predicts centroids on the suggestion frames,
 * skipping already-seeded ones. Track-only fields are set inert (the centroid
 * branch in runInference ignores them).
 */
export function centroidInferenceConfig(
  modelPaths: string[],
  overrides: Partial<InferenceConfig> = {},
): InferenceConfig {
  return {
    pipeline: "centroid",
    modelPaths,
    videoIndex: "all",
    frameRange: "suggestions",
    sampleCount: 20,
    excludeUserLabeled: true,
    batchSize: 4,
    device: "auto",
    maxInstances: null,
    peakThreshold: 0.2,
    anchorPart: null,
    integralRefinement: false,
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
    flowImgScale: 1.0,
    flowWindowSize: 21,
    flowMaxLevels: 3,
    ensureChannels: "auto",
    filterOverlapping: false,
    filterMethod: "iou",
    filterThreshold: 0.8,
    ...overrides,
  };
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
    // Centroid-only prediction uses `sleap-nn predict`, which the remote worker
    // (track-only job spec) can't run — keep it desktop-local.
    if (config.pipeline === "centroid" && remoteOpts?.remote) {
      set({ status: "error", error: "Centroid prediction is desktop-only for now." });
      return;
    }

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
      const { submitJob, workers, selectedWorkerId } = useConnectStore.getState();
      const { handleProcessEvent } = useInferenceStore.getState();

      // Collect video paths from the loaded project
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

      // All paths to resolve: data_path + video paths
      const allLocalPaths = [remoteOpts.dataPath, ...videoPaths];

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

      // Use the resolved data path (first entry)
      const resolvedDataPath = confirmedPaths[0]?.worker ?? remoteOpts.dataPath;

      // Build TrackJobSpec from inference target
      // Map UI target keys to TrackJobSpec fields, matching the PyQt GUI's
      // _track_target_to_spec_fields mapper in dialog.py.
      const target = typeof config.frameRange === "string" ? config.frameRange : null;
      const currentVideoIdx = config.videoIndex !== "all" ? config.videoIndex : undefined;

      // Helper: sample N random indices from [0, totalFrames)
      const sampleRandom = (totalFrames: number, count: number): number[] => {
        const n = Math.min(count, totalFrames);
        const indices = Array.from({ length: totalFrames }, (_, i) => i);
        // Fisher-Yates shuffle, take first n
        for (let i = indices.length - 1; i > 0 && i >= indices.length - n; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        return indices.slice(indices.length - n).sort((a, b) => a - b);
      };

      // frame_filter: only for filter-based targets (worker-side filtering)
      const FILTER_MAP: Record<string, string> = {
        suggestions: "suggested",
        user_labeled: "user",
        predicted: "predicted",
      };
      const frameFilter = target && target in FILTER_MAP ? FILTER_MAP[target] : undefined;

      // frames + video_index: depends on target type
      let frames: string | undefined;
      let videoIndex: number | undefined;

      if (typeof config.frameRange === "object") {
        // custom range
        frames = `${config.frameRange.start}-${config.frameRange.end}`;
        videoIndex = currentVideoIdx;
      } else if (target === "frame") {
        const { frameIdx } = useAppStore.getState();
        frames = String(frameIdx);
        videoIndex = currentVideoIdx;
      } else if (target === "video") {
        videoIndex = currentVideoIdx;
      } else if (target === "random_video") {
        // Client-side random sampling: pick N frames from current video
        const { video: activeVideo } = useAppStore.getState();
        const nFrames = activeVideo?.shape?.[0] ?? 0;
        if (nFrames > 0) {
          const sampled = sampleRandom(nFrames, config.sampleCount);
          frames = sampled.join(",");
        }
        videoIndex = currentVideoIdx;
      } else if (target === "random") {
        // Random sample (all videos): submit one spec per video sequentially
        // Each spec samples N frames from that video
        const allVideos = labels?.videos ?? [];
        const specs = allVideos.map((v, i) => {
          const nFrames = v.shape?.[0] ?? 0;
          if (nFrames === 0) return null;
          const sampled = sampleRandom(nFrames, config.sampleCount);
          return {
            type: "track" as const,
            data_path: resolvedDataPath,
            model_paths: config.modelPaths,
            batch_size: config.batchSize,
            peak_threshold: config.peakThreshold,
            video_index: i,
            exclude_user_labeled: config.excludeUserLabeled || undefined,
            frames: sampled.join(","),
            path_mappings: Object.keys(pathMappings).length > 0 ? pathMappings : undefined,
            robust: config.tracking ? config.robust : undefined,
            ensure_channels: config.ensureChannels !== "auto" ? config.ensureChannels : undefined,
            tracker: config.tracking ? config.trackerMethod : undefined,
            similarity: config.tracking ? config.similarityMethod : undefined,
            match: config.tracking ? config.matchingMethod : undefined,
            track_window: config.tracking ? config.trackingWindowSize : undefined,
            max_tracks: config.tracking && config.maxTracks != null ? config.maxTracks : undefined,
            connect_single_breaks: config.tracking && config.connectSingleBreaks ? true : undefined,
          };
        }).filter(Boolean);

        set((state) => ({
          log: [`$ Remote (${specs.length} videos): ${JSON.stringify(specs, null, 2)}`, ...state.log],
        }));

        try {
          for (let i = 0; i < specs.length; i++) {
            const spec = specs[i]!;
            set((state) => ({
              log: [...state.log, `── Video ${i + 1} of ${specs.length} ──`],
            }));
            const result = await submitJob(spec, (line: string) => {
              handleProcessEvent({ event: "stdout", data: { line } });
            });
            if (!result.success) {
              set({ status: "error", error: result.error || `Video ${i + 1} failed` });
              return;
            }
          }
          set({ status: "completed" });
        } catch (e) {
          set({
            status: "error",
            error: `Remote inference error: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        return;
      }
      // all_videos, suggestions, user_labeled, predicted: no frames/videoIndex needed

      const spec = {
        type: "track" as const,
        data_path: resolvedDataPath,
        model_paths: config.modelPaths,
        batch_size: config.batchSize,
        peak_threshold: config.peakThreshold,
        frame_filter: frameFilter,
        video_index: videoIndex,
        exclude_user_labeled: config.excludeUserLabeled || undefined,
        frames,
        path_mappings: Object.keys(pathMappings).length > 0 ? pathMappings : undefined,
        robust: config.tracking ? config.robust : undefined,
        ensure_channels: config.ensureChannels !== "auto" ? config.ensureChannels : undefined,
        tracker: config.tracking ? config.trackerMethod : undefined,
        similarity: config.tracking ? config.similarityMethod : undefined,
        match: config.tracking ? config.matchingMethod : undefined,
        track_window: config.tracking ? config.trackingWindowSize : undefined,
        max_tracks: config.tracking && config.maxTracks != null ? config.maxTracks : undefined,
        connect_single_breaks: config.tracking && config.connectSingleBreaks ? true : undefined,
      };

      // Log the spec
      set((state) => ({
        log: [`$ Remote: ${JSON.stringify(spec, null, 2)}`, ...state.log],
      }));

      try {
        const result = await submitJob(spec, (line: string) => {
          handleProcessEvent({ event: "stdout", data: { line } });
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
      // ── Local inference via subprocess ─────
      const { projectPath, labels } = useAppStore.getState();
      if (!labels) {
        set({ status: "error", error: "No project loaded" });
        return;
      }

      console.log("[inference] Starting with config:", config);
      const { handleProcessEvent } = useInferenceStore.getState();
      try {
        if (config.frameRange === "random") {
          // "random (all videos)": run per-video, merge each result
          const multiVideoHandler = (event: ProcessEvent) => {
            if (event.event === "stdout") {
              const line = event.data.line;
              try {
                const data = JSON.parse(line);
                if ("n_processed" in data && "n_total" in data) {
                  set({ progress: { nProcessed: data.n_processed, nTotal: data.n_total, rate: data.rate ?? 0, eta: data.eta ?? 0 } });
                  return;
                }
              } catch { /* not JSON */ }
              if (line.trim()) set((s) => ({ log: [...s.log, line] }));
            } else if (event.event === "stderr") {
              const line = event.data.line;
              if (line.trim()) set((s) => ({ log: [...s.log, line] }));
            }
          };

          for (let vi = 0; vi < labels.videos.length; vi++) {
            const video = labels.videos[vi];
            const nFrames = video.shape?.[0] ?? 0;
            if (nFrames === 0) continue;
            const perVideoConfig = {
              ...config,
              videoIndex: vi as number | "all",
              frameRange: "random_video" as InferenceConfig["frameRange"],
            };
            set((s) => ({
              progress: null,
              log: [...s.log, `— Video ${vi + 1}/${labels.videos.length}: sampling ${Math.min(config.sampleCount, nFrames)} of ${nFrames} frames...`],
            }));
            const result = await runInference(perVideoConfig, projectPath, multiVideoHandler);
            if (result.outputPath) {
              set({ outputPath: result.outputPath });
              const platform = await getPlatform();
              const bytes = await platform.readFile(result.outputPath);
              const predictions = await loadSlp(bytes, { openVideos: false, h5: { filenameHint: result.outputPath } });
              await commandContext.execute(MergePredictions, { predictions });
            }
            if (!result.success) {
              set({ status: "error", error: `Video ${vi + 1} failed` });
              return;
            }
          }
          set({ status: "completed" });
        } else {
          const result = await runInference(config, projectPath, handleProcessEvent);
          if (result.command) {
            set((state) => ({
              log: [`$ ${result.command}`, ...state.log],
            }));
          }
          if (!result.success) {
            // The process failed (or produced no output). Surface it rather than
            // masking it with a doomed merge attempt — and make sure we never
            // leave the UI stuck on "running" (which greys the Run-locator button
            // with no way to recover). `handleProcessEvent`'s "finished" event
            // usually sets status="error" already; this backstops the case where
            // the run ends without one.
            const cur = useInferenceStore.getState();
            if (cur.status !== "error" && cur.status !== "cancelled") {
              set({
                status: "error",
                error: cur.error ?? "Inference failed to produce output — see log.",
              });
            }
            return;
          }
          if (result.outputPath) {
            set({ outputPath: result.outputPath });
            await useInferenceStore.getState().loadAndMergeResults();
          } else {
            set({ status: "completed" });
          }
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
      console.log("[inference] Read predictions file: %d bytes from %s", bytes.byteLength, outputPath);
      const predictions = await loadSlp(bytes, {
        openVideos: false,
        h5: { filenameHint: outputPath },
      });
      console.log("[inference] Loaded predictions: %d videos, %d labeled frames, %d tracks",
        predictions.videos?.length ?? 0,
        predictions.labeledFrames?.length ?? 0,
        predictions.tracks?.length ?? 0,
      );

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
