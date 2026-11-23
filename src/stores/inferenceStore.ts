import { create } from "zustand";
import { loadSlp, readSlpStreaming } from "@/lib/slpRead";
import type { JobResult } from "@/lib/sleapConnect";
import type { ProcessEvent } from "@/platform/backend";
import { cancelCommand, runInference } from "@/platform/backend";
import { getPlatform } from "@/platform";
import { commandContext } from "@/commands";
import { MergePredictions, MergeTracks, type ExistingPredictionsMode } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { hasMultipleSkeletons } from "@/lib/multiSkeleton";
import type { SkeletonRunSpec } from "@/lib/multiSkeletonInference";
import type { Labels, Skeleton } from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
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
  /** A box detector alone: predicted boxes, no poses (sleap-nn >= 0.3.5). */
  | "bbox"
  /** Box detector + centered-instance model: poses, cropped to each predicted box. */
  | "top-down-bbox";

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

  /**
   * Projects with several skeletons (#99): one run per skeleton, each with
   * the models whose node names match that skeleton (built by the Inference
   * panel from `planMultiSkeletonInference`). Required on such a project and
   * ignored otherwise; `modelPaths`/`pipeline` above are then unused.
   */
  skeletonRuns?: SkeletonRunSpec[];
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
  /**
   * Several skeletons (#99): the project skeleton each result (same order as
   * `results`) was run for, by name + index in `labels.skeletons`, so Fetch &
   * Load merges it under that skeleton only. Absent for single-skeleton runs.
   */
  skeletons?: PendingMergeSkeleton[];
}

/** A skeleton a pending remote result belongs to (see `PendingRemoteMerge`). */
export interface PendingMergeSkeleton {
  name: string;
  index: number;
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
  skeleton?: Skeleton,
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
    await commandContext.execute(MergePredictions, { predictions, mode, skeleton });
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
  /** Multi-skeleton run: the project skeleton these predictions belong to. */
  skeleton?: Skeleton,
): Promise<void> {
  const predictions = await loadSlp(bytes, {
    openVideos: false,
    h5: { filenameHint },
  });
  await mergePredictionsIntoProject(predictions, mode, trackOnly, skeleton);
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
  const { activeTransport, _client } = useConnectStore.getState();

  if (activeTransport === "iroh") {
    const connId = _client?.authenticated ? _client.irohConnectionId : null;
    if (connId === null || connId === undefined) throw new Error("Not connected to a worker");
    const { createTauriIrohBlobRangeSource } = await import("@/lib/protocolV1/tauriIrohBlob");
    const { source, dispose } = createTauriIrohBlobRangeSource(connId, ref.sha256, ref.size);
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
  /** Multi-skeleton run: the project skeleton these predictions belong to. */
  skeleton?: Skeleton,
): Promise<void> {
  const predictions = await loadRemotePredictions(result);
  if (!predictions) return;
  await mergePredictionsIntoProject(predictions, mode, trackOnly, skeleton);
}

/**
 * The live project skeleton a pending result was run for. Throws when the
 * project's skeletons changed since (renamed, removed or reordered) — merging
 * under a guessed skeleton could wipe another skeleton's predictions.
 */
async function pendingMergeSkeleton(ref: PendingMergeSkeleton): Promise<Skeleton> {
  const { skeletonLabel } = await import("@/lib/multiSkeletonInference");
  const skeletons = useAppStore.getState().labels?.skeletons ?? [];
  const skeleton = skeletons[ref.index];
  if (!skeleton || skeletonLabel(skeleton, skeletons) !== ref.name) {
    throw new Error(
      `The project's skeletons changed since the "${ref.name}" job ran — its predictions weren't merged.`,
    );
  }
  return skeleton;
}

/**
 * Fetch and merge every result of a pending remote merge, in order — the
 * body of the "Fetch & Load Results" action, shared by standalone remote
 * inference and remote post-training inference. Throws on the first
 * failure; the caller keeps its pending state so the action stays retriable.
 */
export async function mergeRemoteResults(pending: PendingRemoteMerge): Promise<void> {
  for (let i = 0; i < pending.results.length; i++) {
    const ref = pending.skeletons?.[i];
    const skeleton = ref ? await pendingMergeSkeleton(ref) : undefined;
    await fetchAndMergeRemoteResult(pending.results[i]!, pending.mode, pending.trackOnly, skeleton);
  }
}

type StoreSet = (
  partial: Partial<InferenceState> | ((state: InferenceState) => Partial<InferenceState>),
) => void;

/**
 * Local inference on a project with several skeletons: one sleap-nn run per
 * skeleton, in order. Each run gets a per-skeleton copy of the project as its
 * input (sleap-nn reads one skeleton; ≤ 0.3.5 also crashes on frames mixing
 * skeletons) and its predictions are merged under that skeleton only. Stops
 * at the first failed run; runs already merged stay (each is one undo step).
 */
async function runLocalSkeletonRuns(
  config: InferenceConfig,
  projectPath: string | null,
  labels: Labels,
  set: StoreSet,
): Promise<void> {
  const {
    configForSkeletonRun,
    labelsForSkeleton,
    runNeedsSkeletonCopy,
    skeletonFileTag,
    skeletonLabel,
    SKELETON_PIPELINE_LABELS,
  } = await import("@/lib/multiSkeletonInference");
  const runs = config.skeletonRuns ?? [];
  // Cancel (cancelInference) kills the running sleap-nn and sets "cancelled";
  // check it after every await so no later run starts and nothing reports
  // "completed" or a run failure instead.
  const cancelled = () => useInferenceStore.getState().status === "cancelled";

  // Progress + log only: a run's "finished" event must not end the whole job.
  const handler = (event: ProcessEvent) => {
    if (event.event === "stdout") {
      const line = event.data.line;
      try {
        const data = JSON.parse(line);
        if ("n_processed" in data && "n_total" in data) {
          set({ progress: { nProcessed: data.n_processed, nTotal: data.n_total, rate: data.rate ?? 0, eta: data.eta ?? 0 } });
          return;
        }
      } catch { /* not JSON */ }
      if (line.trim()) set((s) => ({ log: appendLogLine(s.log, line) }));
    } else if (event.event === "stderr") {
      const line = event.data.line;
      set((s) => ({ log: appendLogLine(s.log, line), stderrTail: appendLogLine(s.stderrTail, line, 25) }));
    }
  };

  try {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const skeleton = labels.skeletons[run.skeletonIndex];
      if (!skeleton || skeletonLabel(skeleton, labels.skeletons) !== run.skeletonName) {
        set({ status: "error", error: `The project's skeletons changed since the models were matched — check the Models list and run again.` });
        return;
      }
      const runConfig = configForSkeletonRun(config, run);
      const outputTag = skeletonFileTag(run.skeletonName);
      set((s) => ({
        progress: null,
        stderrTail: [],
        log: [
          ...s.log,
          `── ${run.skeletonName} (${SKELETON_PIPELINE_LABELS[run.pipeline]}, ${run.modelPaths.length} model${run.modelPaths.length === 1 ? "" : "s"}) — run ${i + 1} of ${runs.length} ──`,
        ],
      }));

      // "Random sample (all videos)" is one sleap-nn call per video.
      const perVideo: InferenceConfig[] =
        runConfig.frameRange === "random"
          ? labels.videos.flatMap((v, vi) =>
              (v.shape?.[0] ?? 0) > 0
                ? [{ ...runConfig, videoIndex: vi, frameRange: "random_video" as const }]
                : [],
            )
          : [runConfig];
      for (const cfg of perVideo) {
        if (cancelled()) return;
        // A per-skeleton copy only when sleap-nn would otherwise read frames
        // mixing skeletons (or the target means "labeled with THIS skeleton");
        // writing it re-serializes the project (see runNeedsSkeletonCopy).
        const inputLabels = runNeedsSkeletonCopy(labels, cfg, useAppStore.getState().frameIdx)
          ? labelsForSkeleton(labels, skeleton)
          : undefined;
        const result = await runInference(cfg, projectPath, handler, { inputLabels, outputTag });
        if (result.command) set((s) => ({ log: [...s.log, `$ ${result.command}`] }));
        if (cancelled()) return;
        if (!result.success) {
          set((s) => ({
            status: "error",
            error: `${run.skeletonName}: ${subprocessFailureMessage("Inference", null, s.stderrTail)}`,
          }));
          return;
        }
        if (result.outputPath) {
          set({ outputPath: result.outputPath });
          const platform = await getPlatform();
          const bytes = await platform.readFile(result.outputPath);
          if (cancelled()) return;
          await loadAndMergePredictionBytes(bytes, result.outputPath, config.existingPredictions, false, skeleton);
        }
      }
    }
    if (cancelled()) return;
    set({ status: "completed" });
    const finishedOutput = useInferenceStore.getState().outputPath;
    // Same settle-before-idle beat as loadAndMergeResults.
    setTimeout(() => {
      const st = useInferenceStore.getState();
      if (st.status === "completed" && st.outputPath === finishedOutput) set({ status: "idle" });
    }, 1500);
  } catch (e) {
    if (cancelled()) return;
    set({
      status: "error",
      error: `Failed to run inference: ${e instanceof Error ? e.message : String(e)}`,
    });
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
    // Several skeletons (#99): one run per skeleton (config.skeletonRuns),
    // each merged under its own skeleton. Refuse what can't run that way.
    const multiSkeleton = (() => {
      const { labels, skeleton } = useAppStore.getState();
      return hasMultipleSkeletons(labels, skeleton);
    })();
    if (multiSkeleton) {
      const { multiSkeletonRunProblem } = await import("@/lib/multiSkeletonInference");
      const problem = multiSkeletonRunProblem(config, !!remoteOpts?.remote);
      if (problem) {
        toast.info(problem);
        return;
      }
    }

    // Local inference reads the saved project file (see runInference); a run
    // on it while the window holds unsaved labels would predict the wrong
    // frames and miss newly labeled ones for "exclude user labeled".
    if (!remoteOpts?.remote) {
      const { confirmSaveBeforeRun } = await import("@/lib/unsavedGuard");
      if (!(await confirmSaveBeforeRun(useAppStore.getState().projectPath, "inference"))) return;
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
      // remote post-training inference (see lib/remoteTrackSpec.ts). Several
      // skeletons: one set of specs per skeleton's models; each result is
      // merged under the skeleton its node names match (MergePredictions).
      const { frameIdx, video: activeVideo } = useAppStore.getState();
      const msi = multiSkeleton ? await import("@/lib/multiSkeletonInference") : null;
      const runConfigs: { config: InferenceConfig; skeleton?: PendingMergeSkeleton }[] = msi
        ? config.skeletonRuns!.map((run) => ({
            config: msi.configForSkeletonRun(config, run),
            skeleton: { name: run.skeletonName, index: run.skeletonIndex },
          }))
        : [{ config }];
      const specRuns = runConfigs.flatMap(({ config: runConfig, skeleton }) =>
        buildRemoteTrackSpecs(runConfig, {
          dataPath: resolvedDataPath,
          pathMappings,
          videoFrameCounts: (labels?.videos ?? []).map((v) => v.shape?.[0] ?? 0),
          currentFrameIdx: frameIdx,
          activeVideoFrameCount: activeVideo?.shape?.[0] ?? 0,
        }).map((spec) => ({ spec, skeleton })),
      );
      const specs = specRuns.map((r) => r.spec);
      // Several skeletons: each result is merged under its own skeleton.
      const specSkeletons = msi ? specRuns.map((r) => r.skeleton!) : undefined;
      // The worker reads its own copy of the project file; sleap-nn (≤ 0.3.5)
      // crashes on frames mixing skeletons, so refuse a job that would read one.
      if (msi && labels) {
        for (const { spec, skeleton } of specRuns) {
          const problem = msi.remoteMixedFramesProblem(labels, msi.remoteSpecScope(spec));
          if (problem) {
            set({ status: "error", error: `${skeleton?.name ?? "Inference"}: ${problem}` });
            return;
          }
        }
      }

      if (config.frameRange === "random" || specs.length > 1) {
        // Random sample (all videos): one spec per video, submitted sequentially.
        set((state) => ({
          log: [`$ Remote (${specs.length} jobs): ${JSON.stringify(specs, null, 2)}`, ...state.log],
        }));

        try {
          const collectedResults: JobResult[] = [];
          for (let i = 0; i < specs.length; i++) {
            const spec = specs[i]!;
            set((state) => ({
              log: [...state.log, `── Job ${i + 1} of ${specs.length} ──`],
            }));
            const result = await submitJob(spec, (line: string) => {
              handleProcessEvent({ event: "stdout", data: { line } });
            });
            if (!result.success) {
              set({ status: "error", error: result.error || `Job ${i + 1} of ${specs.length} failed` });
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
              skeletons: specSkeletons,
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
              skeletons: specSkeletons,
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
      if (multiSkeleton) {
        await runLocalSkeletonRuns(config, projectPath, labels, set);
        return;
      }
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
                config.existingPredictions,
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
