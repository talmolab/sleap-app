import { create } from "zustand";
import { loadSlp } from "@talmolab/sleap-io.js";
import type { ProcessEvent } from "@/platform/backend";
import { cancelCommand, runInference } from "@/platform/backend";
import { getPlatform } from "@/platform";
import { commandContext } from "@/commands";
import { MergePredictions, MergeTracks, type ExistingPredictionsMode } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { appendLogLine, subprocessFailureMessage } from "@/lib/processLog";

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
  /**
   * Track-only mode: skip pose estimation entirely and just (re)track the
   * instances already present in the input .slp (user-labeled or predicted).
   * When true, modelPaths is ignored/empty — sleap-nn's `predict` CLI detects
   * "--tracking with no --model_paths" and takes its dedicated retrack-only
   * path (no model forward pass), so no other argv changes are needed. The
   * merge-back also differs: track-only never adds/removes instances, so it
   * goes through MergeTracks (sleap-io.js's "update_tracks" strategy: spatial
   * match + copy .track/.trackingScore only) instead of MergePredictions.
   */
  trackOnly: boolean;

  // Data
  videoIndex: number | "all";
  frameRange: "all_videos" | "video" | "suggestions" | "user_labeled" | "predicted" | "random_video" | "random" | "frame" | { start: number; end: number };
  sampleCount: number;
  excludeUserLabeled: boolean;
  /** How new predictions combine with existing ones (see ExistingPredictionsMode). */
  existingPredictions: ExistingPredictionsMode;

  // Inference
  batchSize: number;
  device: "auto" | "cuda" | "cpu" | "mps";
  maxInstances: number | null;
  peakThreshold: number;

  // Bottom-up advanced
  integralRefinement: boolean;
  integralPatchSize: number;
  nPoints: number;
  maxEdgeLengthRatio: number;
  distPenaltyWeight: number;
  minLineScores: number;

  // Tracking
  tracking: boolean;
  trackerMethod: "simple" | "flow" | "kalman";
  similarityMethod: "oks" | "iou" | "centroids" | "euclidean_dist";
  matchingMethod: "hungarian" | "greedy";
  trackingWindowSize: number;
  maxTracks: number | null;
  connectSingleBreaks: boolean;
  robust: number;
  minMatchPoints: number;
  minNewTrackPoints: number;
  scoringReduction: "mean" | "max" | "robust_quantile";
  trackingTargetInstanceCount: number | null;
  trackingPreCullToTarget: boolean;
  trackingPreCullIouThreshold: number;
  trackingCleanInstanceCount: number | null;
  trackingCleanIouThreshold: number;

  // Optical flow
  flowImgScale: number;
  flowWindowSize: number;
  flowMaxLevels: number;

  // Kalman filter tracker
  kfTrackFeatures: "centroid" | "keypoints";
  kfInitFrameCount: number;
  kfNodeIndices: number[];
  kfResetGapSize: number;

  // Preprocessing
  ensureChannels: "auto" | "rgb" | "grayscale";

  // Post-processing
  filterOverlapping: boolean;
  filterMethod: "iou" | "oks";
  filterThreshold: number;
  filterMinVisibleNodes: number | null;
  filterMinVisibleNodeFraction: number | null;
  filterMinMeanNodeScore: number | null;
  filterMinInstanceScore: number | null;
  filterMinCentroidDistance: number | null;
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
  /** Recent stderr lines, used to surface the real cause in the error banner. */
  stderrTail: string[];
  minimized: boolean;
  outputPath: string | null;
  startedAt: number | null;

  handleProcessEvent: (event: ProcessEvent) => void;
  setMinimized: (minimized: boolean) => void;
  reset: () => void;
  cancelInference: () => Promise<void>;
  startInference: (config: InferenceConfig, remoteOpts?: RemoteInferenceOptions) => Promise<void>;
  loadAndMergeResults: (mode?: ExistingPredictionsMode, trackOnly?: boolean) => Promise<void>;
}

const initialState = {
  status: "idle" as InferenceStatus,
  error: null as string | null,
  progress: null as InferenceProgress | null,
  log: [] as string[],
  stderrTail: [] as string[],
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
        set((state) => ({ log: appendLogLine(state.log, line) }));
        break;
      }
      case "stderr": {
        const line = event.data.line;
        console.warn("[inference:stderr]", line);
        set((state) => ({
          log: appendLogLine(state.log, line),
          stderrTail: appendLogLine(state.stderrTail, line, 25),
        }));
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
          set((state) => ({
            status: "error",
            error: subprocessFailureMessage(
              "Inference",
              event.data.code,
              state.stderrTail,
            ),
          }));
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
      stderrTail: [],
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
            min_match_points: config.tracking ? config.minMatchPoints : undefined,
            min_new_track_points: config.tracking ? config.minNewTrackPoints : undefined,
            scoring_reduction: config.tracking ? config.scoringReduction : undefined,
            tracking_target_instance_count:
              config.tracking && config.trackingTargetInstanceCount != null
                ? config.trackingTargetInstanceCount
                : undefined,
            tracking_pre_cull_to_target:
              config.tracking && config.trackingPreCullToTarget ? true : undefined,
            tracking_pre_cull_iou_threshold:
              config.tracking && config.trackingPreCullToTarget
                ? config.trackingPreCullIouThreshold
                : undefined,
            tracking_clean_instance_count:
              config.tracking && config.trackingCleanInstanceCount != null
                ? config.trackingCleanInstanceCount
                : undefined,
            tracking_clean_iou_threshold:
              config.tracking && config.trackingCleanInstanceCount != null
                ? config.trackingCleanIouThreshold
                : undefined,
            of_img_scale:
              config.tracking && config.trackerMethod === "flow" ? config.flowImgScale : undefined,
            of_window_size:
              config.tracking && config.trackerMethod === "flow" ? config.flowWindowSize : undefined,
            of_max_levels:
              config.tracking && config.trackerMethod === "flow" ? config.flowMaxLevels : undefined,
            use_kalman: config.tracking && config.trackerMethod === "kalman" ? true : undefined,
            kf_track_features:
              config.tracking && config.trackerMethod === "kalman"
                ? config.kfTrackFeatures
                : undefined,
            kf_init_frame_count:
              config.tracking && config.trackerMethod === "kalman"
                ? config.kfInitFrameCount
                : undefined,
            kf_node_indices:
              config.tracking && config.trackerMethod === "kalman" && config.kfNodeIndices.length > 0
                ? config.kfNodeIndices.join(",")
                : undefined,
            kf_reset_gap_size:
              config.tracking && config.trackerMethod === "kalman"
                ? config.kfResetGapSize
                : undefined,
            filter_overlapping: config.filterOverlapping || undefined,
            filter_overlapping_method: config.filterOverlapping ? config.filterMethod : undefined,
            filter_overlapping_threshold: config.filterOverlapping ? config.filterThreshold : undefined,
            filter_min_visible_nodes: config.filterMinVisibleNodes ?? undefined,
            filter_min_visible_node_fraction: config.filterMinVisibleNodeFraction ?? undefined,
            filter_min_mean_node_score: config.filterMinMeanNodeScore ?? undefined,
            filter_min_instance_score: config.filterMinInstanceScore ?? undefined,
            filter_min_centroid_distance: config.filterMinCentroidDistance ?? undefined,
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
        min_match_points: config.tracking ? config.minMatchPoints : undefined,
        min_new_track_points: config.tracking ? config.minNewTrackPoints : undefined,
        scoring_reduction: config.tracking ? config.scoringReduction : undefined,
        tracking_target_instance_count:
          config.tracking && config.trackingTargetInstanceCount != null
            ? config.trackingTargetInstanceCount
            : undefined,
        tracking_pre_cull_to_target:
          config.tracking && config.trackingPreCullToTarget ? true : undefined,
        tracking_pre_cull_iou_threshold:
          config.tracking && config.trackingPreCullToTarget
            ? config.trackingPreCullIouThreshold
            : undefined,
        tracking_clean_instance_count:
          config.tracking && config.trackingCleanInstanceCount != null
            ? config.trackingCleanInstanceCount
            : undefined,
        tracking_clean_iou_threshold:
          config.tracking && config.trackingCleanInstanceCount != null
            ? config.trackingCleanIouThreshold
            : undefined,
        of_img_scale: config.tracking && config.trackerMethod === "flow" ? config.flowImgScale : undefined,
        of_window_size:
          config.tracking && config.trackerMethod === "flow" ? config.flowWindowSize : undefined,
        of_max_levels:
          config.tracking && config.trackerMethod === "flow" ? config.flowMaxLevels : undefined,
        use_kalman: config.tracking && config.trackerMethod === "kalman" ? true : undefined,
        kf_track_features:
          config.tracking && config.trackerMethod === "kalman" ? config.kfTrackFeatures : undefined,
        kf_init_frame_count:
          config.tracking && config.trackerMethod === "kalman" ? config.kfInitFrameCount : undefined,
        kf_node_indices:
          config.tracking && config.trackerMethod === "kalman" && config.kfNodeIndices.length > 0
            ? config.kfNodeIndices.join(",")
            : undefined,
        kf_reset_gap_size:
          config.tracking && config.trackerMethod === "kalman" ? config.kfResetGapSize : undefined,
        filter_overlapping: config.filterOverlapping || undefined,
        filter_overlapping_method: config.filterOverlapping ? config.filterMethod : undefined,
        filter_overlapping_threshold: config.filterOverlapping ? config.filterThreshold : undefined,
        filter_min_visible_nodes: config.filterMinVisibleNodes ?? undefined,
        filter_min_visible_node_fraction: config.filterMinVisibleNodeFraction ?? undefined,
        filter_min_mean_node_score: config.filterMinMeanNodeScore ?? undefined,
        filter_min_instance_score: config.filterMinInstanceScore ?? undefined,
        filter_min_centroid_distance: config.filterMinCentroidDistance ?? undefined,
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
              if (config.trackOnly) {
                await commandContext.execute(MergeTracks, { retracked: predictions });
              } else {
                await commandContext.execute(MergePredictions, { predictions, mode: config.existingPredictions });
              }
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
          if (result.outputPath) {
            set({ outputPath: result.outputPath });
            await useInferenceStore.getState().loadAndMergeResults(config.existingPredictions, config.trackOnly);
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

  loadAndMergeResults: async (mode: ExistingPredictionsMode = "replace", trackOnly = false) => {
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

      if (trackOnly) {
        await commandContext.execute(MergeTracks, { retracked: predictions });
      } else {
        await commandContext.execute(MergePredictions, { predictions, mode });
      }

      set({ status: "completed" });
      // Keep the "Complete" banner (checkmark, progress bar, log) on screen
      // for a beat before resetting to idle, rather than clearing it the
      // instant the merge finishes. A track-only run in particular can
      // complete this entire cycle -- spawn, track, save, merge -- in well
      // under a second, too fast to ever perceive without this pause
      // (confirmed via a live run: nothing appeared to flash by at all).
      // Deliberately NOT awaited: this is a purely cosmetic delay before the
      // NEXT state transition, not part of what "the merge finished" means —
      // callers (including tests) that await loadAndMergeResults() only care
      // about the merge itself, not this visual timing.
      setTimeout(() => {
        // Only reset if nothing else has started a new run in the meantime —
        // a fresh startInference() call resets outputPath to null immediately,
        // so this comparison fails and we correctly leave its state alone.
        if (useInferenceStore.getState().outputPath === outputPath) {
          set({ status: "idle" });
        }
      }, 1500);
    } catch (e) {
      set({
        status: "error",
        error: `Failed to load results: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
}));
