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
import { reportError, track } from "./index";
import type { AnalyticsEvents, ProjectStage, RunOutcome } from "./events";
import { bucket } from "./protocol";

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
): AnalyticsEvents["project_opened"] {
  return {
    stage,
    videos: bucket(counts.videoCount),
    labeled_frames: bucket(counts.userLabeledFrameCount),
    predicted_instances: bucket(counts.predictedInstanceCount),
    tracks: bucket(counts.trackCount),
    skeleton_nodes: bucket(counts.skeletonNodeCount),
  };
}

/** How long after a project loads to measure it, so the count never competes with the load. */
const PROJECT_MEASURE_DELAY_MS = 3_000;

async function measureProject(labels: Labels): Promise<AnalyticsEvents["project_opened"]> {
  const [{ countUserLabeledFrames }, { PredictedInstance }, { inferTutorialStage }] =
    await Promise.all([
      import("@/stores/trainingStore"),
      import("@talmolab/sleap-io.js"),
      import("@/lib/diagnostics/collectDiagnostics"),
    ]);
  let predicted = 0;
  for (const frame of labels.labeledFrames ?? []) {
    for (const instance of frame.instances ?? []) {
      if (instance instanceof PredictedInstance) predicted++;
    }
  }
  const counts: ProjectCounts = {
    videoCount: labels.videos?.length ?? 0,
    skeletonNodeCount: labels.skeletons?.[0]?.nodes?.length ?? 0,
    userLabeledFrameCount: countUserLabeledFrames(labels) ?? 0,
    predictedInstanceCount: predicted,
    trackCount: labels.tracks?.length ?? 0,
  };
  return projectOpenedProps(counts, inferTutorialStage(counts) as ProjectStage);
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
  const [{ useAppStore }, { useTrainingStore }, { useInferenceStore }] = await Promise.all([
    import("@/stores/appStore"),
    import("@/stores/trainingStore"),
    import("@/stores/inferenceStore"),
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
    (state) => track("training_started", { remote: state._isRemote, models: state.models.length }),
    (state, outcome, duration) =>
      track("training_finished", {
        outcome,
        remote: state._isRemote,
        models: state.models.length,
        duration_s: duration,
        epochs: state.models.reduce((sum, model) => sum + (model.epoch ?? 0), 0),
      }),
  );

  const stopInference = watchRun(
    useInferenceStore,
    now,
    () => track("inference_started", {}),
    (_state, outcome, duration) => track("inference_finished", { outcome, duration_s: duration }),
  );

  return () => {
    stopApp();
    stopTraining();
    stopInference();
  };
}
