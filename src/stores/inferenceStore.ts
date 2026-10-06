import { create } from "zustand";
import { loadSlp, readSlpStreaming } from "@talmolab/sleap-io.js";
import type { JobResult } from "@/lib/sleapConnect";
import type { ProcessEvent } from "@/platform/backend";
import { cancelCommand, runInference } from "@/platform/backend";
import { getPlatform } from "@/platform";
import { commandContext } from "@/commands";
import { MergePredictions, MergeTracks, type ExistingPredictionsMode } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { appendLogLine, subprocessFailureMessage } from "@/lib/processLog";
import { buildRemoteTrackSpecs } from "@/lib/remoteTrackSpec";

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
  /**
   * Inference runtime for an exported model directory (one containing
   * model.onnx / model.trt). "auto" lets sleap-nn choose (and is ignored for
   * plain checkpoints); "onnx"/"tensorrt" force that runtime.
   */
  runtime: "auto" | "onnx" | "tensorrt";
  maxInstances: number | null;
  peakThreshold: number;
  /**
   * For the centroid pipeline, what sleap-nn emits: `"instance"` → single-node
   * PredictedInstances (legacy), `"centroid"` → first-class PredictedCentroids
   * on `frame.centroids` (the annotation model). Ignored for other pipelines.
   */
  centroidOutput: "instance" | "centroid";

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
    trackOnly: false,
    modelPaths,
    videoIndex: "all",
    frameRange: "suggestions",
    sampleCount: 20,
    excludeUserLabeled: true,
    // Refresh the locator's predicted centroids on re-run (see
    // existingPredictionsForPipeline).
    existingPredictions: "replace",
    batchSize: 4,
    device: "auto",
    runtime: "auto",
    maxInstances: null,
    peakThreshold: 0.2,
    // Defaults suit the separate-annotation mode: first-class PredictedCentroids
    // on `frame.centroids`, feeding the Phase-2 work list via
    // `buildWorkListSeparate`. In anchor-node mode the caller MUST override this
    // to "instance", because that mode's `buildWorkList` walks `frame.instances`
    // and never reads `frame.centroids` — otherwise the detections render on the
    // canvas but the sweep never visits them.
    centroidOutput: "centroid",
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
    ...overrides,
  };
}

/**
 * The "Existing predictions" mode a pipeline's results should actually merge
 * back with.
 *
 * The centroid/locator pipeline must REPLACE predictions on matched frames so
 * re-running the locator refreshes its predicted centroids rather than
 * accumulating stale ones — appending (`keep`) would leave the old predicted
 * centroid next to the new one whenever an animal moved between runs (two
 * predicted centroids per animal → duplicate Phase-2 work items). So `keep` is
 * promoted to `replace` for that pipeline; `replace`/`clear_all` already drop
 * the old predictions. Every other pipeline honors the requested mode as-is.
 */
export function existingPredictionsForPipeline(
  pipeline: PipelineType,
  mode: ExistingPredictionsMode,
): ExistingPredictionsMode {
  return pipeline === "centroid" && mode === "keep" ? "replace" : mode;
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
  /**
   * A completed remote job's result(s), fetched but deliberately NOT yet
   * merged — the app only ever learns of remote completion while it's
   * live and connected (there's no reattach-time discovery of a job that
   * finished while disconnected, a known, accepted gap — item 2.4), so
   * merging automatically at that moment used to be safe-looking but
   * wasn't: closing the app between "job finished" and "merge ran" simply
   * dropped the merge with no trace, since nothing was persisted. Requiring
   * an explicit click (mirrors the local job's own "Load Results" button)
   * means a merge either happens because the user asked for it, or is
   * visibly still pending — never silently skipped.
   */
  pendingRemoteMerge: PendingRemoteMerge | null;

  handleProcessEvent: (event: ProcessEvent) => void;
  setMinimized: (minimized: boolean) => void;
  reset: () => void;
  cancelInference: () => Promise<void>;
  startInference: (config: InferenceConfig, remoteOpts?: RemoteInferenceOptions) => Promise<void>;
  loadAndMergeResults: (mode?: ExistingPredictionsMode, trackOnly?: boolean) => Promise<void>;
  /** Explicit trigger for `pendingRemoteMerge` — see its own doc comment. */
  mergePendingRemoteResults: () => Promise<void>;
}

export interface PendingRemoteMerge {
  results: JobResult[];
  mode: ExistingPredictionsMode;
  trackOnly: boolean;
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
  pendingRemoteMerge: null as PendingRemoteMerge | null,
};

/** Shared merge dispatch — a `Labels` already loaded by whichever path
 * (bytes in memory, or read directly off a remote range-read source) gets
 * merged into the current project identically either way. */
async function mergePredictionsIntoProject(
  predictions: Awaited<ReturnType<typeof loadSlp>>,
  mode: ExistingPredictionsMode,
  trackOnly: boolean,
): Promise<void> {
  console.log(
    "[inference] Loaded predictions: %d videos, %d labeled frames, %d tracks",
    predictions.videos?.length ?? 0,
    predictions.labeledFrames?.length ?? 0,
    predictions.tracks?.length ?? 0,
  );
  if (trackOnly) {
    await commandContext.execute(MergeTracks, { retracked: predictions });
  } else {
    await commandContext.execute(MergePredictions, { predictions, mode });
  }
}

/**
 * Load a predictions .slp's bytes into a Labels object and merge it into
 * the current project — shared by the local (read from disk) and remote
 * WebSocket (fetched over HTTP as a result blob) paths. `filenameHint` only
 * needs to look like a real filename; sleap-io.js uses it as a parsing
 * hint, not to actually read anything from disk. A remote connection over
 * iroh does NOT go through this function — see `fetchAndMergeRemoteResult`.
 */
export async function loadAndMergePredictionBytes(
  bytes: Uint8Array,
  filenameHint: string,
  mode: ExistingPredictionsMode,
  trackOnly: boolean,
): Promise<void> {
  const predictions = await loadSlp(bytes, {
    openVideos: false,
    h5: { filenameHint },
  });
  await mergePredictionsIntoProject(predictions, mode, trackOnly);
}

/**
 * Loads a remote job's predictions .slp into a `Labels` WITHOUT merging it
 * into anything — extracted from `fetchAndMergeRemoteResult` (PR5a) so the
 * launcher's Fetch & Load compatibility check (`mergeCompat.ts`'s
 * `checkMergeCompat`, PR5b's `MergePredictionsDialog`) can inspect the
 * predictions before deciding how, or whether, to merge them. Returns
 * `null` if the job carries no fetchable predictions blob — a worker not
 * yet running the blob HTTP server is a known interim gap, not an error.
 *
 * Two transports, two loading strategies — deliberately not unified into
 * one, because they have genuinely different memory characteristics (item
 * 2.4): a WebSocket connection has no range-read source yet (tracked
 * separately, task "HTTP blob fetch: switch to RangeSource"), so it still
 * downloads the whole blob into memory via `fetchResultBlob`/`loadSlp`. An
 * iroh connection reads only the byte ranges sleap-io.js's SLP/HDF5 parser
 * actually needs, straight off a dedicated blob stream on the existing
 * connection, via `readSlpStreaming`/`RangeSource` — never buffering the
 * whole file anywhere.
 */
export async function loadRemotePredictions(
  result: JobResult,
): Promise<Awaited<ReturnType<typeof loadSlp>> | null> {
  const ref = result.resultBlobs?.predictions;
  if (!ref) return null;
  const { useConnectStore } = await import("@/stores/connectStore");
  const { activeTransport } = useConnectStore.getState();

  if (activeTransport === "iroh") {
    const { createTauriIrohBlobRangeSource } = await import("@/lib/protocolV1/tauriIrohBlob");
    const { source, dispose } = createTauriIrohBlobRangeSource(ref.sha256, ref.size);
    try {
      return await readSlpStreaming(source, {
        openVideos: false,
        lazy: false,
        filenameHint: `${result.jobId}.predictions.slp`,
      });
    } finally {
      await dispose();
    }
  }

  const bytes = await useConnectStore.getState().fetchResultBlob(ref);
  return loadSlp(bytes, {
    openVideos: false,
    h5: { filenameHint: `${result.jobId}.predictions.slp` },
  });
}

/**
 * If a remote job's result carries a fetchable predictions blob, load it
 * (`loadRemotePredictions`) and merge it into the current project. A no-op
 * if there's nothing to fetch — see `loadRemotePredictions`'s own doc.
 */
export async function fetchAndMergeRemoteResult(
  result: JobResult,
  mode: ExistingPredictionsMode,
  trackOnly: boolean,
): Promise<void> {
  const predictions = await loadRemotePredictions(result);
  if (!predictions) return;
  await mergePredictionsIntoProject(predictions, mode, trackOnly);
}

/**
 * Fetch and merge every result of a pending remote merge, in order — the
 * body of the "Fetch & Load Results" action, shared by standalone remote
 * inference and remote post-training inference. Throws on the first
 * failure; the caller keeps its pending state so the action stays retriable.
 */
export async function mergeRemoteResults(pending: PendingRemoteMerge): Promise<void> {
  for (const result of pending.results) {
    await fetchAndMergeRemoteResult(result, pending.mode, pending.trackOnly);
  }
}

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
      stderrTail: [],
      minimized: false,
      outputPath: null,
      startedAt: Date.now(),
    });

    if (remoteOpts?.remote) {
      // ── Remote inference via sleap-connect worker ─────────
      const { useConnectStore } = await import("@/stores/connectStore");
      const { submitJob, workerMounts: mounts } = useConnectStore.getState();
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
      const workerMounts = mounts.map((m) => m.path);

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

      // Build the TrackJobSpec(s) from the inference target — shared with
      // remote post-training inference (see lib/remoteTrackSpec.ts).
      const { frameIdx, video: activeVideo } = useAppStore.getState();
      const specs = buildRemoteTrackSpecs(config, {
        dataPath: resolvedDataPath,
        pathMappings,
        videoFrameCounts: (labels?.videos ?? []).map((v) => v.shape?.[0] ?? 0),
        currentFrameIdx: frameIdx,
        activeVideoFrameCount: activeVideo?.shape?.[0] ?? 0,
      });

      if (config.frameRange === "random") {
        // Random sample (all videos): one spec per video, submitted sequentially.
        set((state) => ({
          log: [`$ Remote (${specs.length} videos): ${JSON.stringify(specs, null, 2)}`, ...state.log],
        }));

        try {
          const collectedResults: JobResult[] = [];
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
            collectedResults.push(result);
          }
          set({
            status: "completed",
            pendingRemoteMerge: {
              results: collectedResults,
              mode: config.existingPredictions,
              trackOnly: config.trackOnly,
            },
          });
        } catch (e) {
          set({
            status: "error",
            error: `Remote inference error: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        return;
      }

      const spec = specs[0];

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
            pendingRemoteMerge: {
              results: [result],
              mode: config.existingPredictions,
              trackOnly: config.trackOnly,
            },
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
              await loadAndMergePredictionBytes(
                bytes,
                result.outputPath,
                existingPredictionsForPipeline(config.pipeline, config.existingPredictions),
                config.trackOnly,
              );
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
            await useInferenceStore.getState().loadAndMergeResults(
              existingPredictionsForPipeline(config.pipeline, config.existingPredictions),
              config.trackOnly,
            );
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

  loadAndMergeResults: async (mode: ExistingPredictionsMode = "replace", trackOnly = false) => {
    const { outputPath } = useInferenceStore.getState();
    if (!outputPath) return;

    try {
      const platform = await getPlatform();
      const bytes = await platform.readFile(outputPath);
      console.log("[inference] Read predictions file: %d bytes from %s", bytes.byteLength, outputPath);
      await loadAndMergePredictionBytes(bytes, outputPath, mode, trackOnly);

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

  mergePendingRemoteResults: async () => {
    const { pendingRemoteMerge } = useInferenceStore.getState();
    if (!pendingRemoteMerge) return;
    try {
      await mergeRemoteResults(pendingRemoteMerge);
      set({ pendingRemoteMerge: null, status: "completed" });
      // Same cosmetic settle-before-idle delay as loadAndMergeResults above —
      // only reset if nothing else started a new run in the meantime.
      setTimeout(() => {
        if (useInferenceStore.getState().pendingRemoteMerge === null) {
          set({ status: "idle" });
        }
      }, 1500);
    } catch (e) {
      // A failed fetch/merge is transient and retriable — the underlying job
      // already completed successfully on the worker, only pulling its
      // result blob(s) failed (e.g. a dropped connection). Keep `status:
      // "completed"` and `pendingRemoteMerge` as-is so the "Fetch & Load
      // Results" button (gated on both) stays usable; clearing either here
      // used to force a full job resubmit to recover from what's often just
      // a flaky fetch.
      set({
        error: `Failed to fetch/merge remote result: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
}));
