/**
 * Where events come from. Each `watch*` function observes something the app
 * already does — a store transition, a browser error event — and turns it into
 * a catalog event. Nothing in the stores knows analytics exists; they are only
 * subscribed to from here.
 *
 * (Menu and command usage are the exception: those are counted at their one
 * dispatch point each — `buildAppMenu` and `CommandContext.execute` — through
 * `countMenu` / `countCommand` in ./index.ts.)
 *
 * Store subscribers below run on EVERY store update, including each frame of
 * playback, so they compare references and return; any real work is deferred.
 */

import type { Labels } from "@talmolab/sleap-io.js";
import { countPanel, reportError, track } from "./index";
import type {
  AnalyticsEvents,
  ProjectStage,
  RunOutcome,
  VideoBackendKind,
} from "./events";
import { bucket, classifyRunError } from "./protocol";

type Unsubscribe = () => void;

// ── Runs (training, inference) ───────────────────────────────────────────────

/** The outcome a store's terminal status stands for. */
export function runOutcome(status: string): RunOutcome {
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  // Training's "Stop Early" keeps the model trained so far: a deliberate,
  // successful end, distinct from cancelling.
  if (status === "stopped") return "stopped";
  // "cancelled", and "idle" straight from "running" (the user backed out of a
  // confirmation shown after the run was marked as started).
  return "cancelled";
}

interface RunStore<S extends { status: string }> {
  getState: () => S;
  subscribe: (listener: (state: S, previous: S) => void) => Unsubscribe;
}

/**
 * Call `onStart` when a store's status becomes "running" and `onFinish` when
 * it leaves it. Pure wiring over the store interface, so it is unit-tested
 * with a plain fake store.
 */
export function watchRun<S extends { status: string }>(
  store: RunStore<S>,
  now: () => number,
  onStart: (state: S) => void,
  onFinish: (state: S, outcome: RunOutcome, durationSeconds: number) => void,
): Unsubscribe {
  let startedAt: number | null = store.getState().status === "running" ? now() : null;
  return store.subscribe((state, previous) => {
    if (state.status === previous.status) return;
    if (state.status === "running") {
      startedAt = now();
      onStart(state);
    } else if (previous.status === "running") {
      const duration = startedAt == null ? 0 : Math.max(0, Math.round((now() - startedAt) / 1000));
      startedAt = null;
      onFinish(state, runOutcome(state.status), duration);
    }
  });
}

// ── Projects ─────────────────────────────────────────────────────────────────

export interface ProjectCounts {
  videoCount: number;
  skeletonNodeCount: number;
  userLabeledFrameCount: number;
  predictedInstanceCount: number;
  trackCount: number;
}

/** The `project_opened` event for a project of this shape. Pure. */
export function projectOpenedProps(
  counts: ProjectCounts,
  stage: ProjectStage,
  videoBackend?: VideoBackendKind,
): AnalyticsEvents["project_opened"] {
  const props: AnalyticsEvents["project_opened"] = {
    stage,
    videos: bucket(counts.videoCount),
    labeled_frames: bucket(counts.userLabeledFrameCount),
    predicted_instances: bucket(counts.predictedInstanceCount),
    tracks: bucket(counts.trackCount),
    skeleton_nodes: bucket(counts.skeletonNodeCount),
  };
  if (videoBackend !== undefined) props.video_backend = videoBackend;
  return props;
}

/** Constructor shape accepted for `instanceof` checks, including classes with private constructors. */
type ClassLike = { readonly prototype: object };

/** Known backend constructors passed from dynamic imports so `instanceof` survives minification. */
export interface KnownVideoBackendClasses {
  avi?: readonly ClassLike[];
  hdf5?: readonly ClassLike[];
  image?: readonly ClassLike[];
  seq?: readonly ClassLike[];
  media?: readonly ClassLike[];
}

export interface VideoLike {
  backend?: unknown;
  backendMetadata?: { type?: unknown; dataset?: unknown; sourceFilename?: unknown };
  filename?: string | readonly string[];
}

function classifyBackendName(raw: unknown): VideoBackendKind | null {
  if (typeof raw !== "string") return null;
  const name = raw.toLowerCase();
  if (!name || name === "object") return null;
  if (name.includes("avi")) return "avi";
  if (name.includes("hdf5") || name.includes("h5")) return "hdf5";
  if (name.includes("image")) return "image";
  if (name.includes("seq")) return "seq";
  if (
    name.includes("mp4") ||
    name.includes("mediabunny") ||
    name.includes("media") ||
    name.includes("libav") ||
    name.includes("webcodecs")
  ) {
    return "media";
  }
  return null;
}

function classifyFilenameExtension(filename: unknown): VideoBackendKind | null {
  if (Array.isArray(filename)) return filename.length > 0 ? "image" : null;
  if (typeof filename !== "string" || !filename) return null;
  const clean = filename.split(/[?#]/, 1)[0].toLowerCase();
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot + 1);
  if (ext === "avi") return "avi";
  if (ext === "h5" || ext === "hdf5" || ext === "slp") return "hdf5";
  if (ext === "seq") return "seq";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "tif" || ext === "tiff" || ext === "bmp" || ext === "webp") {
    return "image";
  }
  if (ext === "mp4" || ext === "m4v" || ext === "mov" || ext === "mkv" || ext === "webm") {
    return "media";
  }
  return null;
}

function matchesAny(obj: unknown, ctors?: readonly ClassLike[]): boolean {
  if (!obj || typeof obj !== "object" || !ctors) return false;
  for (const Ctor of ctors) {
    if (typeof Ctor === "function" && obj instanceof (Ctor as new (...args: never[]) => unknown)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a project's video backends into a single coarse family. Pure.
 *
 * Production Vite builds minify class names (`constructor.name` becomes e.g. `"gt"`),
 * so classification prefers `instanceof` (via `knownClasses`), serialized
 * `backendMetadata.type` / `dataset`, and local filename extension (never transmitted)
 * before falling back to `constructor.name`.
 */
export function classifyVideoBackend(
  videos: readonly VideoLike[] | undefined | null,
  knownClasses?: KnownVideoBackendClasses,
): VideoBackendKind {
  if (!videos || videos.length === 0) return "none";
  const kinds = new Set<VideoBackendKind>();
  for (const video of videos) {
    let backend = video?.backend as
      | { constructor?: { name?: string }; inner?: unknown; backend?: unknown }
      | undefined
      | null;
    // Unwrap wrapper backends (CropVideoBackend, GrayscaleVideoBackend) structurally so
    // unwrapping still works when Vite minifies class names.
    for (let depth = 0; depth < 4 && backend && typeof backend === "object"; depth++) {
      const next =
        backend.inner && typeof backend.inner === "object"
          ? backend.inner
          : backend.backend && typeof backend.backend === "object"
            ? backend.backend
            : null;
      if (next && next !== backend) {
        backend = next as typeof backend;
      } else {
        break;
      }
    }

    let kind: VideoBackendKind | null = null;
    if (knownClasses && backend) {
      if (matchesAny(backend, knownClasses.avi)) kind = "avi";
      else if (matchesAny(backend, knownClasses.hdf5)) kind = "hdf5";
      else if (matchesAny(backend, knownClasses.image)) kind = "image";
      else if (matchesAny(backend, knownClasses.seq)) kind = "seq";
      else if (matchesAny(backend, knownClasses.media)) kind = "media";
    }
    if (!kind) kind = classifyBackendName(video?.backendMetadata?.type);
    if (!kind && typeof video?.backendMetadata?.dataset === "string" && video.backendMetadata.dataset) {
      kind = "hdf5";
    }
    if (!kind) kind = classifyBackendName(backend?.constructor?.name);
    if (!kind) {
      kind =
        classifyFilenameExtension(video?.backendMetadata?.sourceFilename) ??
        classifyFilenameExtension(video?.filename);
    }
    kinds.add(kind ?? "other");
  }
  if (kinds.size === 0) return "none";
  if (kinds.size === 1) return [...kinds][0];
  return "mixed";
}

interface ConnectWatchState {
  connectionStatus: string;
  activeTransport: string | null;
}

/** Watch Connect worker link status transitions. Pure over a store interface. */
export function watchConnect(
  store: {
    subscribe: (listener: (state: ConnectWatchState, previous: ConnectWatchState) => void) => Unsubscribe;
  },
  onEvent: (event: AnalyticsEvents["connect_worker"]) => void,
): Unsubscribe {
  return store.subscribe((state, previous) => {
    if (state.connectionStatus === previous.connectionStatus) return;
    if (state.connectionStatus === "connected") {
      onEvent({ transport: state.activeTransport ?? "ws", outcome: "connected" });
    } else if (state.connectionStatus === "error") {
      onEvent({ transport: state.activeTransport ?? "ws", outcome: "error" });
    }
  });
}

/** How long after a project loads to measure it, so the count never competes with the load. */
const PROJECT_MEASURE_DELAY_MS = 3_000;

async function measureProject(labels: Labels): Promise<AnalyticsEvents["project_opened"]> {
  const [{ countUserLabeledFrames }, io, { inferTutorialStage }, rawHdf5] =
    await Promise.all([
      import("@/stores/trainingStore"),
      import("@talmolab/sleap-io.js"),
      import("@/lib/diagnostics/collectDiagnostics"),
      import("@/lib/rawHdf5Video"),
    ]);
  let predicted = 0;
  for (const frame of labels.labeledFrames ?? []) {
    for (const instance of frame.instances ?? []) {
      if (instance instanceof io.PredictedInstance) predicted++;
    }
  }
  const counts: ProjectCounts = {
    videoCount: labels.videos?.length ?? 0,
    skeletonNodeCount: labels.skeletons?.[0]?.nodes?.length ?? 0,
    userLabeledFrameCount: countUserLabeledFrames(labels) ?? 0,
    predictedInstanceCount: predicted,
    trackCount: labels.tracks?.length ?? 0,
  };
  const knownClasses: KnownVideoBackendClasses = {
    avi: [io.AviVideoBackend],
    hdf5: [io.StreamingHdf5VideoBackend, rawHdf5.RawHdf5VideoBackend],
    image: [io.ImageVideoBackend],
    seq: [io.SeqVideoBackend],
    media: [io.Mp4BoxVideoBackend, io.WorkerMp4BoxBackend, io.MediaBunnyVideoBackend],
  };
  return projectOpenedProps(
    counts,
    inferTutorialStage(counts) as ProjectStage,
    classifyVideoBackend(labels.videos as readonly VideoLike[] | undefined, knownClasses),
  );
}

// ── Wiring ───────────────────────────────────────────────────────────────────

/** Errors that are noise in every browser and say nothing about the app. */
const IGNORED_ERRORS = /^(?:ResizeObserver loop|Script error\.?$)/;

/** Report uncaught errors and unhandled promise rejections. */
export function watchErrors(target: Window = window): Unsubscribe {
  const onError = (event: ErrorEvent) => {
    if (IGNORED_ERRORS.test(event.message ?? "")) return;
    reportError("uncaught", event.message, event.error?.stack);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: unknown; stack?: unknown } | undefined;
    reportError("unhandledrejection", reason?.message ?? String(event.reason), reason?.stack);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Subscribe to the app's stores. Returns a function that undoes all of it. */
export async function watchStores(now: () => number = Date.now): Promise<Unsubscribe> {
  const [{ useAppStore }, { useTrainingStore }, { useInferenceStore }, { useConnectStore }] =
    await Promise.all([
      import("@/stores/appStore"),
      import("@/stores/trainingStore"),
      import("@/stores/inferenceStore"),
      import("@/stores/connectStore"),
    ]);

  const onProject = (labels: Labels) => {
    setTimeout(() => {
      // Only if it is still the open project: a quick open-then-open-another
      // should report the one the user stayed on.
      if (useAppStore.getState().labels !== labels) return;
      measureProject(labels)
        .then((props) => track("project_opened", props))
        .catch(() => {});
    }, PROJECT_MEASURE_DELAY_MS);
  };
  const openAtStart = useAppStore.getState().labels;
  if (openAtStart) onProject(openAtStart);

  const stopApp = useAppStore.subscribe((state, previous) => {
    // `labels` is assigned in exactly one place (setLabels), so a new
    // reference means a project was opened, created or imported.
    if (state.labels !== previous.labels && state.labels) onProject(state.labels);

    // Count newly opened sidebar panels (e.g. Label QC, Model Metrics, Bboxes).
    if (state.sidebarOpenPanels !== previous.sidebarOpenPanels) {
      const prevSet = new Set(previous.sidebarOpenPanels);
      for (const panelId of state.sidebarOpenPanels) {
        if (!prevSet.has(panelId)) countPanel(panelId);
      }
    }

    if (state.tutorialActive !== previous.tutorialActive) {
      const action = state.tutorialActive
        ? "started"
        : state.tutorialCompleted
          ? "completed"
          : "exited";
      track("tutorial", {
        action,
        step: state.tutorialHighestStepIndex,
        steps: state.tutorialSteps.length,
      });
    }
  });

  const stopTraining = watchRun(
    useTrainingStore,
    now,
    (state) =>
      track("training_started", {
        remote: state._isRemote,
        models: state.models.length,
        model_type: state.config.modelType,
      }),
    (state, outcome, duration) =>
      track("training_finished", {
        outcome,
        remote: state._isRemote,
        models: state.models.length,
        duration_s: duration,
        epochs: state.models.reduce((sum, model) => sum + (model.epoch ?? 0), 0),
        model_type: state.config.modelType,
        error_category: outcome === "error" ? classifyRunError(state.error) : null,
      }),
  );

  const stopInference = watchRun(
    useInferenceStore,
    now,
    (state) => track("inference_started", { remote: state._isRemote }),
    (state, outcome, duration) =>
      track("inference_finished", {
        outcome,
        duration_s: duration,
        remote: state._isRemote,
        error_category: outcome === "error" ? classifyRunError(state.error) : null,
      }),
  );

  const stopConnect = watchConnect(useConnectStore, (event) => track("connect_worker", event));

  return () => {
    stopApp();
    stopTraining();
    stopInference();
    stopConnect();
  };
}
