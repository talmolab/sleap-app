/**
 * Getting-started tutorial: step definitions for the interactive walkthrough.
 *
 * Each step highlights one real UI element (via a `data-tutorial="..."`
 * attribute already present on the target) and auto-advances once
 * `isComplete` observes the corresponding real action happened — no manual
 * "Next" click. `entry` starts as a snapshot taken when the step becomes
 * active (so `isComplete` can detect deltas — "one more video than when we
 * started" — rather than static truths that might already hold from prior
 * work), but the engine (`TutorialOverlay`) also keeps
 * `everEnteredSkeletonBuild` sticky across re-checks within the same step, so
 * a momentary `true` isn't lost by the time the builder closes again.
 *
 * `buildTutorialSteps` picks the sequence based on whether a project is
 * already loaded when the tutorial starts: a fresh app (WelcomeScreen, no
 * `Sidebar`/panels mounted at all — see `AppShell`) must go through New
 * Project first, since the Videos panel doesn't exist yet to add a video to.
 * If a project is already loaded, that's skipped in favor of the Videos
 * panel's own "Add Videos" button. Adding a future step (labeling, training,
 * inference) to either sequence is just appending an entry and a matching
 * `data-tutorial` attribute at its target — the engine is generic over
 * whatever list `buildTutorialSteps` returns.
 */

import type { Labels, Skeleton } from "@/types";
import { frameHasUserLabels, frameHasPredictedInstances } from "@/lib/frameLabeling";
import type { TrainingStatus } from "@/stores/trainingStore";
import type { InferenceStatus } from "@/stores/inferenceStore";

/** The minimal slice of AppState a step's snapshot/isComplete needs. */
export interface TutorialWatchState {
  labels: Labels | null;
  hasChanges: boolean;
  skeleton: Skeleton | null;
  skeletonBuildMode: boolean;
  newProjectDialogOpen: boolean;
  projectLoaded: boolean;
  /** `trainingStore.status` — training lives in its own store, not appState. */
  trainingStatus: TrainingStatus;
  /** The centered_instance config's `anchorPart` (top-down pipeline only), or null. */
  trainingAnchorPart: string | null;
  /** `inferenceStore.status` — inference lives in its own store, not appState. */
  inferenceStatus: InferenceStatus;
}

/** Count of `labels.suggestions` frames a human has labeled. */
function countLabeledSuggestions(labels: Labels | null): number {
  if (!labels) return 0;
  return labels.suggestions.filter((sf) =>
    frameHasUserLabels(labels, sf.video, sf.frameIdx),
  ).length;
}

/** Count of `labels.suggestions` frames still carrying an unaccepted prediction. */
function countSuggestionsWithPredictions(labels: Labels | null): number {
  if (!labels) return 0;
  return labels.suggestions.filter((sf) =>
    frameHasPredictedInstances(labels, sf.video, sf.frameIdx),
  ).length;
}

export interface TutorialSnapshot {
  videoCount: number;
  suggestionCount: number;
  skeletonNodeCount: number;
  skeletonEdgeCount: number;
  /**
   * Sticky flag: has `skeletonBuildMode` been observed `true` at any point
   * since this step became active? The engine ORs this forward on every
   * re-check (see `TutorialOverlay`) rather than freezing it at snapshot
   * time, since the builder is opened well after the step starts.
   */
  everEnteredSkeletonBuild: boolean;
  /** How many suggestion frames already carried predictions when this step started. */
  suggestionFramesWithPredictionsAtEntry: number;
  /**
   * Sticky flag (same idiom as `everEnteredSkeletonBuild`): has training been
   * seen `running` at any point since this step became active? Training is a
   * real async job — completion alone isn't enough to mark the step done,
   * since `status` may already read "completed" from an earlier run before
   * the user has clicked Start Training again for *this* step.
   */
  everTraining: boolean;
  /** Sticky flag, same idiom, for the inference job. */
  everInferenceRunning: boolean;
}

export function snapshotTutorialState(
  state: TutorialWatchState,
): TutorialSnapshot {
  return {
    videoCount: state.labels?.videos.length ?? 0,
    suggestionCount: state.labels?.suggestions.length ?? 0,
    skeletonNodeCount: state.skeleton?.nodes.length ?? 0,
    skeletonEdgeCount: state.skeleton?.edges.length ?? 0,
    everEnteredSkeletonBuild: state.skeletonBuildMode,
    suggestionFramesWithPredictionsAtEntry: countSuggestionsWithPredictions(
      state.labels,
    ),
    everTraining: state.trainingStatus === "running",
    everInferenceRunning: state.inferenceStatus === "running",
  };
}

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** Panel to force-open (via the store's `openPanel`) when this step starts. */
  panelId?: string;
  /** CSS selector for the element to spotlight, e.g. a `data-tutorial` hook. */
  targetSelector: string;
  placement: "top" | "bottom" | "left" | "right";
  isComplete: (entry: TutorialSnapshot, current: TutorialWatchState) => boolean;
}

/** Fresh-app step 1: WelcomeScreen has no project yet — start a new one. */
export const NEW_PROJECT_STEP: TutorialStep = {
  id: "new-project",
  title: "Create a new project",
  body: 'Click "New Project" to get started.',
  targetSelector: '[data-tutorial="new-project-button"]',
  placement: "top",
  isComplete: (_entry, current) => current.newProjectDialogOpen === true,
};

/**
 * Fresh-app step 2: videos picked in the New Project dialog are local
 * component state (no `labels` exists yet), so there's nothing to diff
 * against — completion is just "a project now exists with a video in it".
 */
export const ADD_VIDEO_IN_DIALOG_STEP: TutorialStep = {
  id: "add-video-in-dialog",
  title: "Add a video",
  body: 'This tutorial is built around a short sample video (mice.mp4) — download it via the link below, then click "+ Add video(s)…" to pick it, and click "Create Project".',
  targetSelector: '[data-tutorial="new-project-add-video-button"]',
  placement: "bottom",
  isComplete: (_entry, current) =>
    current.projectLoaded === true && (current.labels?.videos.length ?? 0) > 0,
};

/** Already-has-a-project step 1: add a video via the Videos panel directly. */
export const ADD_VIDEO_STEP: TutorialStep = {
  id: "add-video",
  title: "Add a video",
  body: 'This tutorial is built around a short sample video (mice.mp4) — download it from github.com/talmolab/sleap-tutorial-data if you don\'t have it, then click "Add Videos" to import it.',
  panelId: "videos",
  targetSelector: '[data-tutorial="add-videos-button"]',
  placement: "left",
  isComplete: (entry, current) =>
    (current.labels?.videos.length ?? 0) > entry.videoCount,
};

export const SAVE_PROJECT_STEP: TutorialStep = {
  id: "save-project",
  title: "Save your project",
  body: "Save your work as a .slp file so it isn't lost — open File ▸ Save, or press ⌘S / Ctrl+S.",
  targetSelector: '[data-tutorial="file-menu-trigger"]',
  placement: "bottom",
  isComplete: (_entry, current) => current.hasChanges === false,
};

export const GENERATE_SUGGESTIONS_STEP: TutorialStep = {
  id: "generate-suggestions",
  title: "Generate suggestions",
  body: "Suggestions pick which frames to label next. Method and Per video already default to Stride / 20 — just click Generate.",
  panelId: "suggestions",
  targetSelector: '[data-tutorial="generate-suggestions-button"]',
  placement: "left",
  isComplete: (entry, current) => {
    const grew =
      (current.labels?.suggestions.length ?? 0) > entry.suggestionCount;
    if (!grew) return false;
    const select = document.querySelector(
      '[data-tutorial="suggestions-method-select"]',
    );
    const input = document.querySelector(
      '[data-tutorial="suggestions-per-video-input"]',
    ) as HTMLInputElement | null;
    const methodOk = (select?.textContent ?? "").includes("Stride");
    const perVideoOk = input?.value === "20";
    return methodOk && perVideoOk;
  },
};

export const CREATE_SKELETON_STEP: TutorialStep = {
  id: "create-skeleton",
  title: "Create a skeleton",
  body: 'Click "Draw skeleton on frame", place nodes on the frame, then drag a stroke through them to connect edges. Click Done when finished. Nodes start out named "node_0", "node_1", … — double-click a name in the Skeleton tab to rename it. For this tutorial\'s sample video, create 3 nodes — head, torso, and tailbase — with edges torso → head and torso → tailbase.',
  panelId: "skeleton",
  targetSelector: '[data-tutorial="draw-skeleton-button"]',
  placement: "left",
  isComplete: (entry, current) => {
    const nodesGrew =
      (current.skeleton?.nodes.length ?? 0) > entry.skeletonNodeCount;
    const edgesGrew =
      (current.skeleton?.edges.length ?? 0) > entry.skeletonEdgeCount;
    return (
      entry.everEnteredSkeletonBuild &&
      !current.skeletonBuildMode &&
      nodesGrew &&
      edgesGrew
    );
  },
};

/**
 * Phase 2, step 1: label just ONE suggested frame — not a fraction of all of
 * them — so a first-time user gets to training fast and sees the whole loop
 * work end-to-end before investing in more labels. Completion only requires
 * at least one suggestion frame to be labeled AND `hasChanges` to be false
 * (saved) — NOT that the label happened after this step started. A user who
 * labeled a suggestion frame while finishing `CREATE_SKELETON_STEP` (e.g. via
 * the "Create instance" prompt in `SkeletonBuildBar`'s Done flow, if the
 * current frame happened to be a suggestion) has already done the thing this
 * step asks for — don't make them do it a second time just because it
 * happened one step early.
 */
export const LABEL_ONE_FRAME_STEP: TutorialStep = {
  id: "label-one-frame",
  title: "Label one frame, then save",
  body: "For fast prototyping, just label ONE suggested frame completely — place every animal's skeleton on it — then save (⌘S / Ctrl+S) before moving to the Training tab. More than one animal in the frame? Ctrl+drag an existing instance to clone it, or right-click ▸ Add Instance ▸ Best.",
  panelId: "suggestions",
  targetSelector: '[data-tutorial="suggestions-panel"]',
  placement: "left",
  isComplete: (_entry, current) =>
    countLabeledSuggestions(current.labels) >= 1 && current.hasChanges === false,
};

/**
 * Phase 2, step 2: pick a crop anchor for the top-down pipeline. The body
 * text recommends "torso" (this tutorial's fixed 3-node skeleton), but
 * completion only requires an explicit, non-"Auto" pick — not that exact
 * string — so a typo'd or differently-cased node name still counts, same
 * lesson as `LABEL_ONE_FRAME_STEP`'s fix: don't gate on an exact match the
 * user could reasonably satisfy in a way the check doesn't recognize.
 */
export const SELECT_ANCHOR_PART_STEP: TutorialStep = {
  id: "select-anchor-part",
  title: "Choose an anchor part",
  body: "Top-Down is selected with its default config already loaded. Pick torso as the Anchor Part below — it's the central, reliably-visible node in this tutorial's skeleton, and Top-Down crops around it every frame.",
  panelId: "training",
  targetSelector: '[data-tutorial="anchor-part-select"]',
  placement: "right",
  isComplete: (_entry, current) => current.trainingAnchorPart !== null,
};

export const RUN_TRAINING_STEP: TutorialStep = {
  id: "run-training",
  title: "Run training",
  body: "Epochs is set to 5 for this first pass — just enough to see the workflow work end-to-end; you can raise it for a better model on the next round. Click Start Training. This can take a while — the tutorial will pick back up once it finishes.",
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "top",
  isComplete: (entry, current) =>
    entry.everTraining && current.trainingStatus === "completed",
};

/**
 * Phase 2, step 4: training runs post-training inference on the suggested
 * frames, so some of them now carry predictions. Completion only requires
 * the count of still-predicted suggestion frames to have dropped below what
 * it was at step-entry — i.e. at least one predicted instance was accepted
 * (double-click, or Ctrl/Cmd+Shift+A) — not that every frame was corrected;
 * the body text still encourages doing all of them before retraining.
 */
export const CORRECT_PREDICTIONS_STEP: TutorialStep = {
  id: "correct-predictions",
  title: "Review and correct predictions",
  body: "Open a suggested frame that now shows a prediction. Accept it — double-click the predicted instance, or press ⌘⇧A / Ctrl+Shift+A to accept all predictions on the frame — then drag any points that are off. Do this for at least one frame (ideally all of them, for a better retrain).",
  panelId: "suggestions",
  targetSelector: '[data-tutorial="suggestions-panel"]',
  placement: "left",
  isComplete: (entry, current) =>
    entry.suggestionFramesWithPredictionsAtEntry > 0 &&
    countSuggestionsWithPredictions(current.labels) <
      entry.suggestionFramesWithPredictionsAtEntry,
};

export const RETRAIN_STEP: TutorialStep = {
  id: "retrain",
  title: "Re-train with the corrected labels",
  body: 'Back in the Training tab, click "Train Again", then Start Training to retrain with your corrections included. Epochs is no longer capped at 5 — feel free to raise it now for a better model.',
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "top",
  isComplete: (entry, current) =>
    entry.everTraining && current.trainingStatus === "completed",
};

export const RUN_INFERENCE_STEP: TutorialStep = {
  id: "run-inference-video",
  title: "Run inference on the full video",
  body: 'Open the Inference tab, set Inference Target to "Entire current video", and click Run Inference.',
  panelId: "inference",
  targetSelector: '[data-tutorial="run-inference-button"]',
  placement: "top",
  isComplete: (entry, current) => {
    if (!entry.everInferenceRunning || current.inferenceStatus !== "completed") {
      return false;
    }
    // Inference Target is local component state (InferencePanel), not part of
    // any store — same DOM-text-read idiom GENERATE_SUGGESTIONS_STEP uses to
    // validate a local <Select>'s current value.
    const targetSelect = document.querySelector(
      '[data-tutorial="inference-target-select"]',
    );
    return (targetSelect?.textContent ?? "").includes("Entire current video");
  },
};

/**
 * Resolves the step sequence once, at tutorial start — not re-evaluated
 * mid-run, so a project created partway through the New Project steps
 * doesn't retroactively change the list out from under the engine.
 */
export function buildTutorialSteps(startedWithProjectLoaded: boolean): TutorialStep[] {
  const rest = [
    SAVE_PROJECT_STEP,
    GENERATE_SUGGESTIONS_STEP,
    CREATE_SKELETON_STEP,
    LABEL_ONE_FRAME_STEP,
    SELECT_ANCHOR_PART_STEP,
    RUN_TRAINING_STEP,
    CORRECT_PREDICTIONS_STEP,
    RETRAIN_STEP,
    RUN_INFERENCE_STEP,
  ];
  return startedWithProjectLoaded
    ? [ADD_VIDEO_STEP, ...rest]
    : [NEW_PROJECT_STEP, ADD_VIDEO_IN_DIALOG_STEP, ...rest];
}
