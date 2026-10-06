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
 * Both builds open with a "Step 0" (see `tutorialStepNumber`). On desktop it's
 * `CHECK_ENVIRONMENT_STEP`: training needs uv + sleap-nn, and a first-time
 * user would otherwise only find that out at the training step. The browser
 * build can't train models at all, so its Step 0 is `BROWSER_NOTICE_STEP`
 * instead, and its sequence ends at `LABEL_ONE_FRAME_STEP`, before training.
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
  body: string;
  /**
   * Turns one occurrence of `text` inside `body` into a hyperlink to `href`,
   * rendered by `TutorialOverlay` — lets a step's own instructions carry a
   * download/reference link instead of pointing at a separate link elsewhere
   * in the app.
   */
  bodyLink?: { text: string; href: string };
  /**
   * Optional supplementary reference (e.g. "Label tips"), rendered by
   * `TutorialOverlay` behind a collapsed-by-default toggle so it doesn't
   * lengthen the coachmark for users who don't need it, while staying one
   * click away for anyone who does.
   */
  tips?: { label: string; text: string };
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
}

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
  body: "Start with the SLEAP App section at the top. Stable is the recommended channel. If a newer version is available, it appears in orange next to an Update button. Click Update to move to the latest version. The app restarts, so start the tutorial again afterwards.\n\nTraining and inference run on sleap-nn, which the app installs using uv. If uv shows \"Not installed\", click Install next to it, then click Install next to sleap-nn. When both show as installed, click Next.",
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
  title: "Before you start",
  body: "You're using SLEAP in the browser, where models can't be trained. This tutorial covers everything up to training and ends there: creating a project, adding a video, generating suggestions, building a skeleton, and labeling a frame.\n\nTo train a model and run it on your videos, use the SLEAP desktop app.",
  targetSelector: null,
  placement: "bottom",
  isComplete: () => true,
  holdBeforeAdvance: () => true,
};

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
 * Direct download of the fixed sample video (mice.mp4) this tutorial is built
 * around. Google Drive's `uc?export=download` form starts the download
 * straight away; the `/file/d/<id>/view` share link would open Drive's preview
 * page instead.
 */
export const SAMPLE_VIDEO_URL =
  "https://drive.google.com/uc?export=download&id=1ncZJlGdBSH0JCYhh_Af3lTsizR2Z8rQQ";

/**
 * Fresh-app step 2: videos picked in the New Project dialog are local
 * component state (no `labels` exists yet, since the project isn't created
 * until "Create Project" is clicked in the next step) — so completion reads
 * the dialog's staged-video list directly from the DOM (`new-project-video-list`,
 * populated by `NewProjectDialog`), same idiom as `GENERATE_SUGGESTIONS_STEP`
 * reading a local `<Select>`'s value.
 */
export const ADD_VIDEO_IN_DIALOG_STEP: TutorialStep = {
  id: "add-video-in-dialog",
  title: "Add a video",
  body: "This tutorial uses a short sample video, mice.mp4. Click the name to download it, then add it using the video dropzone: drag the file in, or click to browse.",
  bodyLink: { text: "mice.mp4", href: SAMPLE_VIDEO_URL },
  targetSelector: '[data-tutorial="new-project-add-video-button"]',
  placement: "bottom",
  isComplete: (_entry, _current) => {
    const list = document.querySelector('[data-tutorial="new-project-video-list"]');
    return !!list && list.children.length > 0;
  },
};

/** Fresh-app step 3: confirm the staged video, then commit the project. */
export const CONFIRM_VIDEO_AND_CREATE_STEP: TutorialStep = {
  id: "confirm-video-and-create",
  title: "Create the project",
  body: "Check that your video is listed above, then click \"Create Project\".",
  targetSelector: '[data-tutorial="new-project-create-button"]',
  placement: "top",
  isComplete: (_entry, current) =>
    current.projectLoaded === true && (current.labels?.videos.length ?? 0) > 0,
};

export const SAVE_PROJECT_STEP: TutorialStep = {
  id: "save-project",
  title: "Save your project",
  body: "Save your work so it isn't lost: open File ▸ Save, or press ⌘S / Ctrl+S.\n\nThis writes your project to a .slp file, SLEAP's project format. It keeps track of your videos, skeleton, and labels, and it's the file you open to come back to this project.",
  targetSelector: '[data-tutorial="file-menu-trigger"]',
  placement: "bottom",
  isComplete: (_entry, current) => current.hasChanges === false,
};

export const GENERATE_SUGGESTIONS_STEP: TutorialStep = {
  id: "generate-suggestions",
  title: "Generate suggestions",
  body: "Suggestions are the frames SLEAP picks for you to label. Method and Per video are already set to Stride and 20, so just click Generate.",
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
  body: "Click \"Draw skeleton on frame\", then follow the bar that appears at the top of the frame:\n• Click on the frame to place each node. Double-click a node to rename it.\n• Click \"Next: Connect edges\" and drag a stroke through the nodes to connect them.\n• Click Done. When asked whether to create an instance on this frame, click \"Create instance\". This is one of your suggested frames, so it gives you a head start on the next step.\n\nFor the sample video, create 3 nodes named head, torso, and tailbase, with edges torso → head and torso → tailbase. Draw the skeleton only once, even if there's more than one mouse in the frame. This step only defines the skeleton; you'll add an instance for each animal next.",
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
  body: "To get to training quickly, label just one suggested frame completely. Place a skeleton on every animal in it, with each node on the right body part, then save (⌘S / Ctrl+S).\n\nMore than one animal in the frame? Ctrl+drag an existing instance to clone it, or right-click and choose Add Instance ▸ Best.",
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
  body: "Top-Down is selected with its default config loaded, and we've set its Anchor Part to torso. Top-Down crops around the anchor in every frame, so it should be a central node that's visible most of the time.\n\nEpochs is set to 5 for this first pass, which is just enough to see the whole workflow. Click Start Training. When training finishes, the app automatically runs the new model on your suggested frames, and the tutorial picks up from there. While it runs, scroll down and click the graph icon next to a model's progress to watch its loss curves live.",
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
  body: "Training is done, and the app has already run the new model on your suggested frames. Expect these first predictions to be rough: the model has seen one labeled frame for 5 epochs. Correcting them is how it improves.\n\nIn the Suggestions panel, frames with a Score have predictions. Open one and accept its predictions: double-click a predicted instance, or press ⌘⇧A / Ctrl+Shift+A to accept every prediction on the frame. Then drag any points that are off. Do this for at least one frame, and ideally all of them, for a better retrain.",
  tips: {
    label: "Label tips",
    text: "Predicted nodes are yellow. Once accepted, a node is red until you click or drag it, then it turns green. A hollow gray marker means that node is set as not visible. Right-click it and choose \"Mark Node Visible\", or select several and use \"Toggle Selected Nodes Visibility\", to turn it back on.",
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
  body: "Back in the Training tab, click \"Train Again\". Epochs is now set to 50 for a better model, and Anchor Part stays torso. Click Start Training. As before, the new model runs on your suggested frames when training finishes.\n\nYou don't have to wait for every epoch. Once you've seen how it works, click Stop Early to keep what's been trained so far. Top-Down trains two models one after the other, so click it once for each.",
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "top",
  isComplete: (entry, current) =>
    entry.everTraining && current.trainingStatus === "completed",
};

export const RUN_INFERENCE_STEP: TutorialStep = {
  id: "run-inference-video",
  title: "Run inference on the whole video",
  body: 'Set Inference Target to "Entire current video" and click Run Inference. When it finishes, play or scrub through the video to see the model\'s predictions on every frame.',
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
      BROWSER_NOTICE_STEP,
      ...steps.slice(0, steps.indexOf(LABEL_ONE_FRAME_STEP) + 1),
    ];
  }
  return [CHECK_ENVIRONMENT_STEP, ...steps];
}

/** True when the sequence includes training (the desktop one). */
export function tutorialIncludesTraining(steps: TutorialStep[]): boolean {
  return steps.some((s) => s.id === RUN_TRAINING_STEP.id);
}

const STEP_ZERO_IDS = new Set([CHECK_ENVIRONMENT_STEP.id, BROWSER_NOTICE_STEP.id]);

/**
 * The number shown for `steps[index]`. The environment check / browser notice
 * is "Step 0", so the steps after it keep the same numbers in both builds.
 */
export function tutorialStepNumber(steps: TutorialStep[], index: number): number {
  return STEP_ZERO_IDS.has(steps[0]?.id ?? "") ? index : index + 1;
}
