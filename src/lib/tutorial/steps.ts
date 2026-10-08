/**
 * Getting-started tutorial: step definitions for the interactive walkthrough.
 *
 * Each step highlights one real UI element (via a `data-tutorial="..."`
 * attribute already present on the target) and auto-advances once
 * `isComplete` observes the corresponding real action happened — the coachmark's
 * manual Next button is a guarded alternative (disabled-looking + a warning
 * toast) for the same condition, not a way to skip it. `entry` starts as a
 * snapshot taken when the step becomes active (so `isComplete` can detect
 * deltas — "one more video than when we started" — rather than static truths
 * that might already hold from prior work), but the engine (`TutorialOverlay`)
 * also keeps `everEnteredSkeletonBuild` sticky across re-checks within the
 * same step, so a momentary `true` isn't lost by the time the builder closes
 * again. Stepping back past an already-cleared step (`tutorialHighestStepIndex`
 * in appStore.ts) suspends this entry/recheck machinery for that revisit — see
 * `TutorialOverlay`'s `isRevisited` — so re-reading a finished step never
 * demands redoing the real action just to move forward again.
 *
 * The tutorial always runs from a fresh app (WelcomeScreen) and goes through
 * New Project first, so it never adds sample data to a project the user
 * already has open — `requestStartTutorial` (startTutorial.ts) offers a new
 * window instead when one is. Adding a step is just appending an entry and a
 * matching `data-tutorial` attribute at its target — the engine is generic over
 * whatever list `buildTutorialSteps` returns.
 *
 * Both builds open with the unnumbered `WELCOME_STEP` (what the tutorial
 * covers and how the card works), then a "Step 0" (see `tutorialStepNumber`),
 * so every later step has the same number in both builds. On desktop Step 0 is
 * `CHECK_ENVIRONMENT_STEP`: training needs uv + sleap-nn, and a first-time
 * user would otherwise only find that out at the training step. The browser
 * build can't train models at all, so its Step 0 is `BROWSER_NOTICE_STEP`
 * instead, and its sequence ends at `LABEL_ONE_FRAME_STEP`, before training.
 */

import type { Labels, Skeleton } from "@/types";
import { frameHasUserLabels, frameHasPredictedInstances } from "@/lib/frameLabeling";
import type { TrainingStatus } from "@/stores/trainingStore";
import type { InferenceStatus } from "@/stores/inferenceStore";
import { formatShortcut } from "@/lib/formatShortcut";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";

// Shortcut labels for the step bodies, in the running platform's form only
// (⌘S on macOS, Ctrl+S elsewhere) rather than both spelled out side by side.
const SAVE_KEY = formatShortcut(DEFAULT_SHORTCUTS.save);
const ADD_INSTANCE_KEY = formatShortcut(DEFAULT_SHORTCUTS["add instance"]);
const ACCEPT_ALL_KEY = formatShortcut(DEFAULT_SHORTCUTS["accept all predictions"]);

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
  /** The centered_instance config's `maxEpochs` (top-down pipeline only), or null. */
  trainingMaxEpochs: number | null;
  /** `inferenceStore.status` — inference lives in its own store, not appState. */
  inferenceStatus: InferenceStatus;
  /**
   * The local training environment, from environmentStore. `uvAvailable` and
   * `sleapNnInstalled` are only meaningful once `envDetected` is true;
   * `accelerator` is null until sleap-nn's own torch has been probed
   * (`acceleratorDetected`), and also when that probe failed.
   */
  envDetected: boolean;
  uvAvailable: boolean;
  sleapNnInstalled: boolean;
  acceleratorDetected: boolean;
  accelerator: "cuda" | "mps" | "cpu" | null;
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
  /**
   * Coachmark text. Lines starting with "• " become a list. Inline marks:
   * `**text**` highlights a control to click or a value to use, and
   * `` `text` `` shows a keyboard shortcut as a key cap — see `renderInline`
   * in TutorialOverlay. Use them sparingly, for what the user must act on.
   */
  body: string;
  /**
   * Optional supplementary reference (e.g. "Label tips"), rendered by
   * `TutorialOverlay` behind a collapsed-by-default toggle so it doesn't
   * lengthen the coachmark for users who don't need it, while staying one
   * click away for anyone who does.
   */
  tips?: { label: string; text: string }; // `text` takes the same inline marks as `body`
  /** Panel to force-open (via the store's `openPanel`) when this step starts. */
  panelId?: string;
  /**
   * CSS selector for the element to spotlight, e.g. a `data-tutorial` hook.
   * `null` for a step that isn't about any one control — its card is centered.
   */
  targetSelector: string | null;
  placement: "top" | "bottom" | "left" | "right";
  isComplete: (entry: TutorialSnapshot, current: TutorialWatchState) => boolean;
  /**
   * When this returns true for a complete step, the engine enables Next but
   * doesn't auto-advance — for a step whose coachmark carries something the
   * user should read first (e.g. the CPU-only warning).
   */
  holdBeforeAdvance?: (current: TutorialWatchState) => boolean;
  /**
   * Extra warning shown when sleap-nn can only train on the CPU. Given the
   * displayed number of `RUN_TRAINING_STEP` in this run's sequence, since that
   * differs between the fresh-app and project-loaded sequences.
   */
  cpuNote?: (trainingStepNumber: number) => string;
  /**
   * For a step that also checks a particular setting: a message naming the
   * setting when the user did the action but with it set differently, so the
   * step doesn't just silently refuse to advance. Null when there's nothing
   * to point out. Shown on the coachmark and in the Next button's warning toast.
   */
  incompleteHint?: (entry: TutorialSnapshot, current: TutorialWatchState) => string | null;
}

/**
 * Starter card for both builds, before Step 0: what the tutorial covers and
 * how to work the card. Unnumbered (see `tutorialStepNumber`); the overlay
 * shows "Welcome" in place of "Step N of M" and labels its button Start.
 */
export const WELCOME_STEP: TutorialStep = {
  id: "welcome",
  title: "Welcome to SLEAP",
  body: "This hands-on tutorial walks through the whole SLEAP workflow on a short sample video: label a few frames, train a model on them, correct its predictions, retrain, then run the model on the whole video. It builds its own project, so nothing of yours is touched.\n\nThis card shows what to do at each step and moves on once you've done it. Drag it by its handle, collapse it with the chevron, or close it with ✕ at any time.\n\nClick **Start** when you're ready.",
  targetSelector: null,
  placement: "bottom",
  isComplete: () => true,
  holdBeforeAdvance: () => true,
};

/**
 * Desktop "Step 0": make sure uv and sleap-nn are installed before the user
 * invests in labeling, and find out early whether training will run on the
 * CPU. Completes once sleap-nn is installed and its accelerator has been
 * probed, which enables Next — but never auto-advances, even when everything
 * was already installed, so the user always sees what was found (and the
 * `cpuNote` warning on a CPU-only machine) before moving on.
 */
export const CHECK_ENVIRONMENT_STEP: TutorialStep = {
  id: "check-environment",
  title: "Check your environment",
  body: "Training needs two tools: uv and sleap-nn (SLEAP's training engine). If uv shows \"Not installed\", click **Install** next to it, then do the same for sleap-nn. When both show as installed, click **Next**.",
  tips: {
    label: "App updates",
    text: "The SLEAP App section at the top shows your version. Stable is the recommended channel. If an update is available, it appears in orange next to an **Update** button. Updating restarts the app, so you'd need to start the tutorial again afterwards.",
  },
  panelId: "environment",
  targetSelector: '[data-tutorial="environment-panel"]',
  placement: "left",
  isComplete: (_entry, current) =>
    current.envDetected &&
    current.uvAvailable &&
    current.sleapNnInstalled &&
    current.acceleratorDetected,
  holdBeforeAdvance: () => true,
  cpuNote: (n) =>
    `No GPU is available to sleap-nn, so training (step ${n}) will run on the CPU and be much slower. You can stop the tutorial after step ${n - 1}, since every step from ${n} on needs a trained model. Or keep going and expect training to take a while.`,
};

/**
 * Browser "Step 0": models can't be trained in the browser, so say up front
 * that this tutorial ends after labeling, rather than letting the user find
 * out at the training step. Nothing to do here — just read it and click Next.
 */
export const BROWSER_NOTICE_STEP: TutorialStep = {
  id: "browser-notice",
  title: "Training needs the desktop app",
  body: "You're using SLEAP in the browser, where models can't be trained. This tutorial covers everything up to training and ends there: creating a project, adding a video, generating suggestions, building a skeleton, and labeling a frame.\n\nTo train a model and run it on your videos, use the **SLEAP desktop app**.",
  targetSelector: null,
  placement: "bottom",
  isComplete: () => true,
  holdBeforeAdvance: () => true,
};

/** Fresh-app step 1: WelcomeScreen has no project yet — start a new one. */
export const NEW_PROJECT_STEP: TutorialStep = {
  id: "new-project",
  title: "Create a new project",
  body: "Click **New Project** to get started.",
  targetSelector: '[data-tutorial="new-project-button"]',
  placement: "top",
  isComplete: (_entry, current) => current.newProjectDialogOpen === true,
};

/**
 * Fresh-app step 2: videos picked in the New Project dialog are local
 * component state (no `labels` exists yet, since the project isn't created
 * until "Create Project" is clicked in the next step) — so completion reads
 * the dialog's staged-video list directly from the DOM (`new-project-video-list`,
 * populated by `NewProjectDialog`), same idiom as `GENERATE_SUGGESTIONS_STEP`
 * reading a local `<Select>`'s value.
 *
 * Targets the "Use sample video" button rather than the dropzone: the button
 * sits directly above the dropzone/staged-video list in the dialog, so a
 * "bottom" placement would park the coachmark right on top of them for the
 * whole step (the user can drag a file in as an alternative the whole time).
 * "right" keeps both fully visible.
 */
export const ADD_VIDEO_IN_DIALOG_STEP: TutorialStep = {
  id: "add-video-in-dialog",
  title: "Add a video",
  body: 'This tutorial uses a short sample video, mice.mp4. Click **Use sample video** to add it. If you already have mice.mp4, you can drag it into the dropzone instead.',
  targetSelector: '[data-tutorial="new-project-sample-video-button"]',
  placement: "right",
  isComplete: (_entry, _current) => {
    const list = document.querySelector('[data-tutorial="new-project-video-list"]');
    return !!list && list.children.length > 0;
  },
};

/** Fresh-app step 3: confirm the staged video, then commit the project. */
export const CONFIRM_VIDEO_AND_CREATE_STEP: TutorialStep = {
  id: "confirm-video-and-create",
  title: "Create the project",
  body: "Check that your video is listed above, then click **Create Project**.",
  targetSelector: '[data-tutorial="new-project-create-button"]',
  placement: "top",
  isComplete: (_entry, current) =>
    current.projectLoaded === true && (current.labels?.videos.length ?? 0) > 0,
};

export const SAVE_PROJECT_STEP: TutorialStep = {
  id: "save-project",
  title: "Save your project",
  body: `Save your project: open **File ▸ Save**, or press \`${SAVE_KEY}\`. The first time, you'll choose where to put the file.\n\nSLEAP projects are .slp files. Open this one later to pick up where you left off.`,
  targetSelector: '[data-tutorial="file-menu-trigger"]',
  placement: "bottom",
  isComplete: (_entry, current) => current.hasChanges === false,
};

/**
 * Whether the Suggestions panel's Method / Per video controls are at the
 * tutorial's Stride / 20. Both are local component state, so read from the DOM.
 */
function suggestionSettingsOk(): boolean {
  const select = document.querySelector(
    '[data-tutorial="suggestions-method-select"]',
  );
  const input = document.querySelector(
    '[data-tutorial="suggestions-per-video-input"]',
  ) as HTMLInputElement | null;
  const methodOk = (select?.textContent ?? "").includes("Stride");
  const perVideoOk = input?.value === "20";
  return methodOk && perVideoOk;
}

function suggestionsGrew(entry: TutorialSnapshot, current: TutorialWatchState): boolean {
  return (current.labels?.suggestions.length ?? 0) > entry.suggestionCount;
}

export const GENERATE_SUGGESTIONS_STEP: TutorialStep = {
  id: "generate-suggestions",
  title: "Generate suggestions",
  body: "Suggestions are frames SLEAP picks for you to label, spread out so your labels cover the whole video. The settings are filled in to pick 20 evenly spaced frames (**Method: Stride**, **Per video: 20**). Keep them as they are and click **Generate**.",
  panelId: "suggestions",
  targetSelector: '[data-tutorial="generate-suggestions-button"]',
  placement: "left",
  isComplete: (entry, current) =>
    suggestionsGrew(entry, current) && suggestionSettingsOk(),
  incompleteHint: (entry, current) =>
    suggestionsGrew(entry, current) && !suggestionSettingsOk()
      ? "These suggestions weren't made with **Method: Stride** and **Per video: 20**, which this tutorial relies on. Set them back and click **Generate** again."
      : null,
};

export const CREATE_SKELETON_STEP: TutorialStep = {
  id: "create-skeleton",
  title: "Create a skeleton",
  body: "A skeleton is the set of body parts you track (nodes) and the lines between them (edges). For the mice, make 3 nodes named **head**, **torso**, and **tailbase**, with edges from **torso to head** and from **torso to tailbase**.\n\nClick **Draw skeleton on frame**, then follow the bar at the top of the frame:\n• Click the frame to place each node. Double-click a node to rename it.\n• Click **Next: Connect edges**. Edges follow the direction you drag, so draw **two strokes, each starting at torso**: one to head, one to tailbase.\n• Click **Done**. When asked, click **Create instance** to put this skeleton on the current frame.\n\nDraw the skeleton **only once**, even if there's more than one mouse. It's a template: each animal gets its own copy in the next step.",
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
  body: `An instance is one animal's copy of the skeleton. To get to training quickly, fully label **just one suggested frame**: one instance per animal, with each node on the right body part.\n• If you clicked **Create instance** in the last step, it's already on this frame. Drag its nodes onto a mouse.\n• For each other mouse, right-click the frame and choose **Add Instance ▸ Best** (or press \`${ADD_INSTANCE_KEY}\`), or \`Ctrl\`+drag an existing instance to copy it. Then drag its nodes into place.\n• Save with \`${SAVE_KEY}\`.\n\nYou're on a suggested frame already. The rest are listed in the Suggestions panel; click one to jump to it.`,
  panelId: "suggestions",
  targetSelector: '[data-tutorial="suggestions-panel"]',
  placement: "left",
  isComplete: (_entry, current) =>
    countLabeledSuggestions(current.labels) >= 1 && current.hasChanges === false,
};

/**
 * Step ids covering the tutorial's FIRST training pass — shared by `TutorialOverlay`
 * (forces epochs down to `TUTORIAL_MAX_EPOCHS` here, see trainingDefaults.ts) and `TrainingPanel`'s
 * config-autoload effect (forces the generic baseline profile here, even if a
 * trained run already exists on disk for this head, e.g. from a prior tutorial
 * pass on the same project — the first pass is meant to demonstrate the
 * baseline workflow). Past this set (e.g. `retrain`), a trained run's exact
 * config is preferred again, same as normal "Train Again" behavior.
 */
export const TUTORIAL_FIRST_TRAINING_STEP_IDS = new Set(["run-training"]);

/**
 * The anchor part is set to torso for the user (trainingDefaults.ts), so this
 * step only explains it. Completion only requires training to finish — not a
 * particular anchor — so a run started with a different pick still moves the
 * tutorial on rather than stranding the user.
 */
export const RUN_TRAINING_STEP: TutorialStep = {
  id: "run-training",
  title: "Train a model",
  body: "Training teaches a model to find your skeleton's nodes, using the frames you labeled. Everything is set up for a quick first pass of 5 epochs (an epoch is one pass over your labels), just enough to see the whole workflow.\n\nClick **Start Training**. When it finishes, the app runs the new model on your suggested frames and the tutorial continues.",
  tips: {
    label: "About these settings",
    text: "Top-Down is selected. It trains two models one after the other: the first finds each animal by its anchor part, the second crops around that anchor and finds the rest of the nodes. Anchor Part is set to torso because it's central and visible in most frames.\n\nTo watch training live, scroll down and click the graph icon next to a model's progress to see its loss curves.",
  },
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "top",
  isComplete: (entry, current) =>
    entry.everTraining && current.trainingStatus === "completed",
  cpuNote: () =>
    "Training will run on the CPU, which is much slower than on a GPU. If you'd rather not wait, you can exit the tutorial here, because the remaining steps all need this trained model.",
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
  body: `Training is done, and the app has run the new model on your suggested frames. Expect rough predictions: the model has learned from just one labeled frame. Correcting them is how it improves.\n\nIn the Suggestions panel, frames with a value in the **Score** column have predictions. Click one and accept its predictions: **double-click** a predicted instance, or press \`${ACCEPT_ALL_KEY}\` to accept every prediction on the frame. Then drag any nodes that are off. Do **at least one frame**, and ideally all of them, for a better retrain.`,
  tips: {
    label: "Label tips",
    text: "Predicted nodes are yellow. Once accepted, a node is red until you click or drag it, then it turns green. A hollow gray marker means that node is set as not visible. Right-click it and choose **Mark Node Visible**, or select several and use **Toggle Selected Nodes Visibility**, to turn it back on.",
  },
  panelId: "suggestions",
  targetSelector: '[data-tutorial="suggestions-panel"]',
  placement: "left",
  isComplete: (entry, current) =>
    entry.suggestionFramesWithPredictionsAtEntry > 0 &&
    countSuggestionsWithPredictions(current.labels) <
      entry.suggestionFramesWithPredictionsAtEntry,
};

/**
 * Epochs default to `TUTORIAL_RETRAIN_EPOCHS` here (trainingDefaults.ts, applied
 * by `TutorialOverlay`), but completion only requires training to finish, not a
 * particular epoch count or config — the user may change the epochs or click
 * Stop Early to move on sooner, and Stop Early still ends the run as
 * "completed".
 */
export const RETRAIN_STEP: TutorialStep = {
  id: "retrain",
  title: "Re-train with the corrected labels",
  body: "Click **Train Again**, then **Start Training**. Epochs is now 50 for a better model; everything else stays the same. As before, the new model runs on your suggested frames when it finishes.\n\nYou don't have to wait for all 50 epochs: click **Stop Early** to keep what's been trained so far. Top-Down trains two models one after the other, so you'll click Stop Early once for each.",
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "top",
  isComplete: (entry, current) =>
    entry.everTraining && current.trainingStatus === "completed",
};

function inferenceFinished(entry: TutorialSnapshot, current: TutorialWatchState): boolean {
  return entry.everInferenceRunning && current.inferenceStatus === "completed";
}

/**
 * Inference Target is local component state (InferencePanel), not part of any
 * store — same DOM-text-read idiom `suggestionSettingsOk` uses for a local
 * <Select>'s current value.
 */
function inferenceTargetOk(): boolean {
  const targetSelect = document.querySelector(
    '[data-tutorial="inference-target-select"]',
  );
  return (targetSelect?.textContent ?? "").includes("Entire current video");
}

export const RUN_INFERENCE_STEP: TutorialStep = {
  id: "run-inference-video",
  title: "Run inference on the whole video",
  body: 'Inference means running your model on frames to predict poses. Set Inference Target to **Entire current video** and click **Run Inference**. When it finishes, play or scrub through the video to see predictions on every frame.',
  panelId: "inference",
  targetSelector: '[data-tutorial="run-inference-button"]',
  placement: "top",
  isComplete: (entry, current) =>
    inferenceFinished(entry, current) && inferenceTargetOk(),
  incompleteHint: (entry, current) =>
    inferenceFinished(entry, current) && !inferenceTargetOk()
      ? 'That run didn\'t cover the whole video. Set Inference Target to **Entire current video** and click **Run Inference** again.'
      : null,
};

/**
 * The step sequence for the desktop app (`desktop`) or the browser. Resolved
 * once, at tutorial start (see `startTutorial` in appStore.ts), so it isn't
 * re-derived mid-run. The browser can't train, so its run stops after
 * labeling.
 */
export function buildTutorialSteps(desktop: boolean): TutorialStep[] {
  const steps = [
    NEW_PROJECT_STEP,
    ADD_VIDEO_IN_DIALOG_STEP,
    CONFIRM_VIDEO_AND_CREATE_STEP,
    SAVE_PROJECT_STEP,
    GENERATE_SUGGESTIONS_STEP,
    CREATE_SKELETON_STEP,
    LABEL_ONE_FRAME_STEP,
    RUN_TRAINING_STEP,
    CORRECT_PREDICTIONS_STEP,
    RETRAIN_STEP,
    RUN_INFERENCE_STEP,
  ];
  if (!desktop) {
    return [
      WELCOME_STEP,
      BROWSER_NOTICE_STEP,
      ...steps.slice(0, steps.indexOf(LABEL_ONE_FRAME_STEP) + 1),
    ];
  }
  return [WELCOME_STEP, CHECK_ENVIRONMENT_STEP, ...steps];
}

/** True when the sequence includes training (the desktop one). */
export function tutorialIncludesTraining(steps: TutorialStep[]): boolean {
  return steps.some((s) => s.id === RUN_TRAINING_STEP.id);
}

const STEP_ZERO_IDS = new Set([CHECK_ENVIRONMENT_STEP.id, BROWSER_NOTICE_STEP.id]);

/**
 * The number shown for `steps[index]`. The welcome card isn't counted, and the
 * environment check / browser notice is "Step 0", so the steps after it keep
 * the same numbers in both builds. Returns -1 for the welcome card itself.
 */
export function tutorialStepNumber(steps: TutorialStep[], index: number): number {
  const numbered = steps.filter((s) => s.id !== WELCOME_STEP.id);
  const position = numbered.indexOf(steps[index]);
  if (position === -1) return -1;
  return STEP_ZERO_IDS.has(numbered[0]?.id ?? "") ? position : position + 1;
}
