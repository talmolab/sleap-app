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
import { frameHasUserLabels } from "@/lib/frameLabeling";
import type { TrainingStatus } from "@/stores/trainingStore";
import type { InferenceStatus } from "@/stores/inferenceStore";
import { formatShortcut } from "@/lib/formatShortcut";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import {
  TUTORIAL_ANCHOR_PART,
  TUTORIAL_MAX_EPOCHS,
  TUTORIAL_RETRAIN_EPOCHS,
} from "./trainingDefaults";
import { skeletonExample } from "./skeletonExample";

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
  /** The centroid config's `maxEpochs` (top-down pipeline only), or null. */
  trainingCentroidMaxEpochs: number | null;
  /**
   * Post-Training Inference Target as the Training panel shows it (e.g.
   * "Suggested frames"), or null while that panel isn't open. It's local
   * component state in `TrainingPanel`, not in any store, so the overlay reads
   * it off the select — same as `inferenceTargetOk` does for InferencePanel.
   */
  postTrainingInferenceTarget: string | null;
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

/**
 * Count of frames with at least one accepted prediction: accepting keeps a
 * `fromPredicted` link to the prediction it replaced (editCommands.ts), and
 * correcting the nodes afterwards doesn't clear it.
 */
function countFramesWithAcceptedPredictions(labels: Labels | null): number {
  if (!labels) return 0;
  return labels.labeledFrames.filter((lf) =>
    lf.instances.some((inst) => (inst as { fromPredicted?: unknown }).fromPredicted),
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
  /** How many frames had accepted predictions (see `countFramesWithAcceptedPredictions`) when this step started. */
  correctedFrameCount: number;
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
  /**
   * The `labels.suggestions` array last seen by `observeTutorialState`. The
   * Suggestions panel replaces the array on every Generate, so a new
   * reference marks a new generation.
   */
  seenSuggestions: unknown;
  /**
   * Whether Method / Per video were Stride / 20 when suggestions last changed
   * during this step; null if they haven't changed yet. Recorded then, not
   * read at check time, so fixing the settings afterwards without clicking
   * Generate again doesn't count.
   */
  suggestionSettingsOkAtGenerate: boolean | null;
  /**
   * Whether Inference Target was "Entire current video" while inference ran
   * during this step; null if it hasn't run. The select is disabled while a
   * run is in progress, so reading it then gives the run's real target.
   */
  inferenceTargetOkAtRun: boolean | null;
  /**
   * The step's checklist failures as last read while training wasn't
   * running, so that when a run starts, it can be judged on the settings the
   * user had when they clicked Start Training. Null while training is running.
   */
  trainingChecksIdle: string[] | null;
  /** Whether training was running at the last re-check, to spot a run starting. */
  wasTrainingRunning: boolean;
  /**
   * The step's checklist failures for the most recent training run started
   * during this step: empty when it started as the checklist asks, null if
   * none has. Empty, too, when the step opens with a run already going, since
   * its settings can't be known then.
   */
  trainingStartFailures: string[] | null;
}

/**
 * `checklist` is the step's own (see `TutorialStep.checklist`): a training run
 * started during the step is judged against it.
 */
export function snapshotTutorialState(
  state: TutorialWatchState,
  checklist: TutorialCheck[] = [],
): TutorialSnapshot {
  const trainingRunning = state.trainingStatus === "running";
  return {
    videoCount: state.labels?.videos.length ?? 0,
    suggestionCount: state.labels?.suggestions.length ?? 0,
    skeletonNodeCount: state.skeleton?.nodes.length ?? 0,
    skeletonEdgeCount: state.skeleton?.edges.length ?? 0,
    everEnteredSkeletonBuild: state.skeletonBuildMode,
    correctedFrameCount: countFramesWithAcceptedPredictions(state.labels),
    everTraining: state.trainingStatus === "running",
    everInferenceRunning: state.inferenceStatus === "running",
    seenSuggestions: state.labels?.suggestions ?? null,
    suggestionSettingsOkAtGenerate: null,
    inferenceTargetOkAtRun: null,
    trainingChecksIdle: trainingRunning ? null : checklistFailures(checklist, state),
    wasTrainingRunning: trainingRunning,
    trainingStartFailures: trainingRunning ? [] : null,
  };
}

/**
 * Carry the step's snapshot forward with what's happened since it was taken:
 * the sticky flags (once true, stay true) and the settings in effect when the
 * user acted. `TutorialOverlay` calls this on every re-check, before
 * `isComplete`.
 */
export function observeTutorialState(
  entry: TutorialSnapshot,
  current: TutorialWatchState,
  checklist: TutorialCheck[] = [],
): void {
  entry.everEnteredSkeletonBuild ||= current.skeletonBuildMode;
  entry.everTraining ||= current.trainingStatus === "running";
  entry.everInferenceRunning ||= current.inferenceStatus === "running";
  const suggestions = current.labels?.suggestions ?? null;
  if (suggestions !== entry.seenSuggestions) {
    entry.seenSuggestions = suggestions;
    entry.suggestionSettingsOkAtGenerate = suggestionSettingsOk();
  }
  if (current.inferenceStatus === "running") {
    entry.inferenceTargetOkAtRun = inferenceTargetOk();
  }
  const trainingRunning = current.trainingStatus === "running";
  if (!trainingRunning) {
    entry.trainingChecksIdle = checklistFailures(checklist, current);
  } else if (!entry.wasTrainingRunning) {
    // A run just started. The controls are disabled while it runs, so they
    // still show what it started with; if one can't be read now (its panel
    // closed), fall back to the last reading from before the click.
    const readable = checklist.every((c) => c.current(current) !== null);
    entry.trainingStartFailures = readable
      ? checklistFailures(checklist, current)
      : (entry.trainingChecksIdle ?? checklistFailures(checklist, current));
    entry.trainingChecksIdle = null;
  }
  entry.wasTrainingRunning = trainingRunning;
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
  /**
   * Panel to force-open (via the store's `openPanel`) when this step starts.
   * The card names it at the top ("Skeleton panel"), with its sidebar icon.
   */
  panelId?: string;
  /**
   * Where a step without a sidebar panel happens (e.g. "File menu"), named at
   * the top of the card in the panel's place. Steps that are only reading
   * (the welcome card) have neither.
   */
  location?: string;
  /**
   * CSS selector for the element to spotlight, e.g. a `data-tutorial` hook.
   * `null` for a step that isn't about any one control — its card is centered.
   */
  targetSelector: string | null;
  /**
   * Further controls the step's text sends the user to, ringed like the
   * target whenever they're on screen (e.g. the skeleton builder's bar, which
   * only appears once the builder is open). The card is still placed against
   * `targetSelector`, but kept clear of these so it never covers them.
   */
  alsoHighlightSelector?: string;
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
  /**
   * Settings the user should confirm before acting, shown on the card as a
   * live checklist (re-read on every tick, revisits included, so it always
   * shows what's really set), with a toggle that reveals each one's `meaning`.
   */
  checklist?: TutorialCheck[];
  /** A labeled example image the card shows behind a toggle. */
  example?: TutorialExample;
}

/**
 * An example image with a skeleton drawn over it, e.g. the one the user is
 * about to make. Its toggle sits right after the step's first paragraph. Coordinates are in a `width` x `height` space matching the
 * image, which may be stored at a higher resolution.
 */
export interface TutorialExample {
  /** The toggle's text while the example is hidden, and while it's showing. */
  showLabel: string;
  hideLabel: string;
  imageUrl: string;
  alt: string;
  width: number;
  height: number;
  nodes: { name: string; x: number; y: number }[];
  /** `[source, destination]` node names; drawn with an arrow at the destination. */
  edges: [string, string][];
  caption: string;
}

/** One setting on a step's checklist. */
export interface TutorialCheck {
  label: string;
  /** The value the step needs, as the control shows it. */
  expected: string;
  /** The value as the control shows it now; null when it isn't loaded or on screen. */
  current: (state: TutorialWatchState) => string | null;
  /** What the setting does and where to change it. Takes `renderInline` marks. */
  meaning: string;
}

export interface TutorialCheckRow {
  label: string;
  expected: string;
  current: string | null;
  ok: boolean;
}

export function evaluateChecklist(
  checks: TutorialCheck[],
  state: TutorialWatchState,
): TutorialCheckRow[] {
  return checks.map((c) => {
    const current = c.current(state);
    return { label: c.label, expected: c.expected, current, ok: current === c.expected };
  });
}

/**
 * Starter card for both builds, before Step 0: what the tutorial covers and
 * how to work the card. Unnumbered (see `tutorialStepNumber`); the overlay
 * shows "Welcome" in place of "Step N of M" and labels its button Start.
 */
export const WELCOME_STEP: TutorialStep = {
  id: "welcome",
  title: "Welcome to SLEAP",
  body: "This hands-on tutorial walks through the whole SLEAP workflow on a sample video of mice: label a few frames, train a model on them, correct its predictions, retrain, then run the model on the whole video.\n\nThis card shows what to do at each step and moves on once you've done it. Drag it by its handle, collapse it with the toggle button, or exit the tutorial with ✕ at any time.\n\nClick **Start** when you're ready.",
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
  body: "Training needs two tools: uv and sleap-nn (SLEAP's training engine). If uv shows \"Not installed\", click **Install** next to it, then do the same for sleap-nn.\n\nOnce sleap-nn is installed, look at **Accelerator** below it: a green light means a GPU was detected, so training will run fast.\n\nWhen both tools show as installed, click **Next**.",
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
  location: "Welcome screen",
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
  body: 'This tutorial uses a sample video, mice.mp4. Click **Use sample video** to add it. If you already have mice.mp4, you can drag it into the dropzone instead.',
  location: "New Project dialog",
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
  location: "New Project dialog",
  targetSelector: '[data-tutorial="new-project-create-button"]',
  placement: "top",
  isComplete: (_entry, current) =>
    current.projectLoaded === true && (current.labels?.videos.length ?? 0) > 0,
};

export const SAVE_PROJECT_STEP: TutorialStep = {
  id: "save-project",
  title: "Save your project",
  body: `Save your project: open **File ▸ Save**, or press \`${SAVE_KEY}\`. The first time, you'll choose where to put the file.\n\nSLEAP projects are .slp files. The save dialog suggests the name **labels.v001.slp**. Next time, open that file (**File ▸ Open Project**) to load this project and pick up where you left off.`,
  location: "File menu",
  targetSelector: '[data-tutorial="file-menu-trigger"]',
  placement: "bottom",
  isComplete: (_entry, current) => current.hasChanges === false,
};

/**
 * Whether the Suggestions panel's Method / Per video controls are at the
 * tutorial's Stride / 20. Both are local component state, so read from the DOM,
 * by `observeTutorialState` when suggestions change.
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
    suggestionsGrew(entry, current) && entry.suggestionSettingsOkAtGenerate === true,
  incompleteHint: (entry, current) =>
    suggestionsGrew(entry, current) && entry.suggestionSettingsOkAtGenerate === false
      ? "These suggestions weren't made with **Method: Stride** and **Per video: 20**, which this tutorial relies on. Set them back and click **Generate** again."
      : null,
};

/**
 * Frame the "Create a skeleton" step jumps to on entry, and the one the label
 * step asks the user to label. This tutorial is built around a fixed sample
 * video (mice.mp4) generated with a deterministic Stride/20 suggestion — 1410
 * is one of the resulting suggestion frames, so drawing the skeleton here
 * always lands on a real suggested frame (letting it double-count toward
 * `LABEL_ONE_FRAME_STEP` if the user creates an instance from it).
 * `setFrameIdx` clamps to the loaded video's last frame, so this is a harmless
 * no-op/best-effort jump on a different or shorter video.
 */
export const TUTORIAL_LABEL_FRAME_IDX = 1410;

/**
 * The skeleton `CREATE_SKELETON_STEP` asks for. Later steps depend on it
 * exactly: the training anchor is only set when a node is named `torso`
 * (trainingDefaults.ts), and an extra node is one more keypoint every frame
 * has to label before the model can learn it.
 */
export const TUTORIAL_SKELETON = {
  nodes: ["head", "torso", "tailbase"],
  edges: [
    ["torso", "head"],
    ["torso", "tailbase"],
  ],
} as const;

export const CREATE_SKELETON_STEP: TutorialStep = {
  id: "create-skeleton",
  title: "Create a skeleton",
  body: `A skeleton is the set of body parts you track (nodes) and the lines between them (edges). For the mice, make 3 nodes named **head**, **torso**, and **tailbase**, with edges from **torso to head** and from **torso to tailbase**.\n\nWe've moved to **frame ${TUTORIAL_LABEL_FRAME_IDX}**, one of your suggested frames, to draw and label on. Click **Draw skeleton on frame**, then follow the highlighted bar at the top of the frame:\n• Click the frame to place each node. Double-click a node to rename it.\n• Click **Next: Connect edges**. Edges follow the direction you drag, so draw **two strokes, each starting at torso**: one to head, one to tailbase.\n• Click **Done**. When asked, click **Create instance** to put this skeleton on frame ${TUTORIAL_LABEL_FRAME_IDX}.\n\nDraw the skeleton **only once**, even if there's more than one mouse. It's a template: each animal gets its own copy in the next step.`,
  panelId: "skeleton",
  example: skeletonExample(TUTORIAL_SKELETON.nodes, TUTORIAL_SKELETON.edges),
  targetSelector: '[data-tutorial="draw-skeleton-button"]',
  alsoHighlightSelector: '[data-tutorial="skeleton-build-bar"]',
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
/**
 * How `skeleton` differs from `TUTORIAL_SKELETON`, as short phrases for the
 * coachmark; empty when it matches. Names must match exactly, since the
 * anchor lookup does. Edges are only compared once the nodes match: a node
 * named `tail` instead of `tailbase` would otherwise also report both its
 * edges, and renaming the node fixes those anyway.
 */
export function tutorialSkeletonProblems(skeleton: Skeleton | null): string[] {
  const names = skeleton?.nodes.map((n) => n.name) ?? [];
  if (names.length === 0) return ["it has no nodes"];

  const expected: readonly string[] = TUTORIAL_SKELETON.nodes;
  const problems: string[] = [];
  for (const name of names) {
    if (!expected.includes(name)) problems.push(`extra node **${name}**`);
  }
  for (const name of expected) {
    if (!names.includes(name)) problems.push(`missing node **${name}**`);
  }
  if (problems.length > 0) return problems;

  const edgeKey = (src: string, dst: string) => `${src} → ${dst}`;
  const actual = new Set(
    (skeleton?.edges ?? []).map((e) => edgeKey(e.source.name, e.destination.name)),
  );
  const wanted = new Set(TUTORIAL_SKELETON.edges.map(([s, d]) => edgeKey(s, d)));
  for (const [src, dst] of TUTORIAL_SKELETON.edges) {
    if (actual.has(edgeKey(src, dst))) continue;
    problems.push(
      actual.has(edgeKey(dst, src))
        ? `edge **${edgeKey(dst, src)}** should go from ${src} to ${dst}`
        : `missing edge **${edgeKey(src, dst)}**`,
    );
  }
  for (const key of actual) {
    // A reversed edge was already reported above as pointing the wrong way.
    const [src, dst] = key.split(" → ");
    if (!wanted.has(key) && !wanted.has(edgeKey(dst, src))) {
      problems.push(`extra edge **${key}**`);
    }
  }
  return problems;
}

export const LABEL_ONE_FRAME_STEP: TutorialStep = {
  id: "label-one-frame",
  title: "Label one frame, then save",
  body: `An instance is one animal's copy of the skeleton. We'll label **just one suggested frame**, **frame ${TUTORIAL_LABEL_FRAME_IDX}** (the one you're on), only to see how the whole workflow works; a real project needs many more labeled frames. Fully label it: one instance per animal, with each node on the right body part.\n• If you clicked **Create instance** in the last step, it's already on this frame. Drag its nodes onto a mouse.\n• For each other mouse, right-click the frame and choose **Add Instance ▸ Best** (or press \`${ADD_INSTANCE_KEY}\`), or \`Ctrl\`+drag an existing instance to copy it. Then drag its nodes into place.\n• Save with \`${SAVE_KEY}\`.\n\nYour other suggested frames are listed in the Suggestions panel; click one to jump to it.`,
  panelId: "suggestions",
  targetSelector: '[data-tutorial="suggestions-panel"]',
  placement: "left",
  isComplete: (_entry, current) =>
    countLabeledSuggestions(current.labels) >= 1 &&
    current.hasChanges === false &&
    tutorialSkeletonProblems(current.skeleton).length === 0,
  // Shown from the moment the step opens, before any labeling: catching an
  // extra node here is far cheaper than at training, and fixing the skeleton
  // also fixes the instances already placed with it.
  incompleteHint: (_entry, current) => {
    const problems = tutorialSkeletonProblems(current.skeleton);
    if (problems.length === 0) return null;
    return `Your skeleton isn't the one this tutorial uses (**head**, **torso**, **tailbase**, with edges **torso → head** and **torso → tailbase**): ${problems.join("; ")}. Open the **Skeleton** panel in the sidebar to fix it: rename or delete nodes on its **Nodes** tab, add or delete edges on its **Edges** tab. Then save again with \`${SAVE_KEY}\`.`;
  },
};

// Defined in trainingDefaults.ts (which this module imports for the training
// checklist), re-exported here where TrainingPanel has always found it.
export { TUTORIAL_FIRST_TRAINING_STEP_IDS } from "./trainingDefaults";

const epochsText = (epochs: number | null) => (epochs === null ? null : String(epochs));

/**
 * What a tutorial training run needs, for `RUN_TRAINING_STEP` and
 * `RETRAIN_STEP`: the same target and anchor both times, with `epochs` per
 * run. The overlay sets most of these for the user (trainingDefaults.ts), but
 * not on a revisit, and other steps change them ("Train Again" reloads the
 * last run's config; the retrain step raises epochs), so a user can find other
 * values here. The checklist makes them look rather than trust the card text.
 */
function trainingChecks(
  epochs: number,
  why: { target: string; epochs: string },
): TutorialCheck[] {
  return [
    {
      label: "Post-training inference target",
      expected: "Suggested frames",
      current: (s) => s.postTrainingInferenceTarget,
      meaning: `Which frames the new model predicts on as soon as training ends. ${why.target} Change it under **Post-Training Inference Target**.`,
    },
    {
      label: "Anchor part",
      expected: TUTORIAL_ANCHOR_PART,
      // trainingMaxEpochs is null when there's no centered-instance config at
      // all; anchorPart is null for Auto, which the dropdown shows as such.
      current: (s) =>
        s.trainingMaxEpochs === null ? null : (s.trainingAnchorPart ?? "Auto"),
      meaning:
        "The node Top-Down uses to find each animal before it looks for the rest. Torso is central and visible in most frames. Change it under **Hyperparameters ▸ Anchor Part**.",
    },
    {
      label: "Centroid epochs",
      expected: String(epochs),
      current: (s) => epochsText(s.trainingCentroidMaxEpochs),
      meaning: `Top-Down's first model finds each animal's anchor. An epoch is one pass over your labeled frames; ${why.epochs} Change it under **Hyperparameters ▸ Centroid ▸ Max Epochs**.`,
    },
    {
      label: "Centered instance epochs",
      expected: String(epochs),
      current: (s) => epochsText(s.trainingMaxEpochs),
      meaning:
        "Top-Down's second model looks in a crop around each anchor and finds the rest of the nodes. Change it under **Hyperparameters ▸ Centered Instance ▸ Max Epochs**.",
    },
  ];
}

/** The first run's checklist. The target matters most: the next step corrects predictions on the suggested frames. */
export const TRAINING_CHECKS = trainingChecks(TUTORIAL_MAX_EPOCHS, {
  target: "The next step has you correct those predictions, so they need to be on your suggested frames.",
  epochs: `${TUTORIAL_MAX_EPOCHS} is just enough to see training work.`,
});

/** The retrain run's checklist: the same settings, with more epochs. */
export const RETRAIN_CHECKS = trainingChecks(TUTORIAL_RETRAIN_EPOCHS, {
  target: "Predicting on the same frames as last time lets you compare the new model with the first one.",
  epochs: `${TUTORIAL_RETRAIN_EPOCHS} gives a better model than the first run's ${TUTORIAL_MAX_EPOCHS}, and you can stop early.`,
});

/** Checks in `checks` not set as they ask, e.g. "Anchor part is head". */
export function checklistFailures(
  checks: TutorialCheck[],
  state: TutorialWatchState,
): string[] {
  return evaluateChecklist(checks, state)
    .filter((row) => !row.ok)
    .map((row) => `${row.label} is ${row.current ?? "not set"}`);
}

/**
 * Hint for a training step whose latest run started with checklist settings
 * off: cancel it while it runs, or train again once it has finished. Null
 * otherwise; with no run going, the checklist itself shows what to fix.
 */
function checklistRunHint(entry: TutorialSnapshot, current: TutorialWatchState): string | null {
  const failures = entry.trainingStartFailures;
  if (!failures?.length) return null;
  const what = `(${failures.join("; ")})`;
  if (current.trainingStatus === "running") {
    return `This run didn't start with the settings above ${what}. Click **Cancel**, fix them, then click **Start Training** again.`;
  }
  if (current.trainingStatus === "completed") {
    return `That run didn't use the settings above ${what}. Click **Train Again**, fix them, then click **Start Training**.`;
  }
  return null;
}

/**
 * The first training run. Completes once a run starts with every
 * `TRAINING_CHECKS` setting as the checklist asks; a run started otherwise
 * holds the step with a hint to cancel, fix and start again, rather than
 * letting a run with the wrong target (or 200 epochs) carry the tutorial on.
 * `TRAINING_PROGRESS_STEP` takes over while it runs.
 */
export const RUN_TRAINING_STEP: TutorialStep = {
  id: "run-training",
  title: "Train a model",
  body: "Training teaches a model to find your skeleton's nodes, using the frames you labeled. You've labeled just one frame, so this first model won't be accurate; it's here to show how training works.\n\nBefore you start, check that the Training panel matches the list below. These are usually set for you, but if you come back to this step later they may have changed. Fix anything that isn't ticked, then click **Start Training**.",
  tips: {
    label: "About Top-Down",
    text: "Top-Down is selected. It trains two models one after the other: the first finds each animal by its anchor part, the second crops around that anchor and finds the rest of the nodes.",
  },
  checklist: TRAINING_CHECKS,
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "left",
  isComplete: (entry) => entry.trainingStartFailures?.length === 0,
  incompleteHint: checklistRunHint,
  cpuNote: () =>
    "Training will run on the CPU, which is much slower than on a GPU. If you'd rather not wait, you can exit the tutorial here, because the remaining steps all need this trained model.",
};

/**
 * Shown while the first training run is in progress: how to follow it (loss
 * curves) and what happens when it ends. Completes when training finishes,
 * which `trainingStore` only reports after the post-training inference on the
 * suggested frames is done, so the next step always has predictions to show.
 */
export const TRAINING_PROGRESS_STEP: TutorialStep = {
  id: "training-progress",
  title: "Watch training",
  body: "Training is running. Top-Down trains two models one after the other, and each gets a progress bar here.\n\nClick a model's name to open its **loss curves**. Loss measures how far the model's predictions are from your labels, so it should go down as training goes on. If this card is in the way, collapse it.\n\nWhen training finishes, the app runs the new model on your suggested frames to predict poses there (this is called **inference**), then the tutorial moves on.",
  panelId: "training",
  targetSelector: '[data-tutorial="training-progress"]',
  placement: "left",
  isComplete: (entry, current) =>
    entry.everTraining && current.trainingStatus === "completed",
};

/**
 * Phase 2, step 4: training runs post-training inference on the suggested
 * frames, so some of them now carry predictions. Completes once predictions
 * have been accepted (double-click, or Ctrl/Cmd+Shift+A) on at least
 * `MIN_CORRECTED_FRAMES` more frames than at step entry, and the project is
 * saved — not that every frame was corrected; the body text still encourages
 * doing more before retraining.
 */
const MIN_CORRECTED_FRAMES = 2;

export const CORRECT_PREDICTIONS_STEP: TutorialStep = {
  id: "correct-predictions",
  title: "Review and correct predictions",
  body: `Training is done, and the app has run the new model on your suggested frames. Expect rough predictions: the model has learned from just one labeled frame. Correcting them is how it improves.\n\nIn the Suggestions panel, frames with a value in the **Score** column have predictions. The score is the model's confidence in its predictions on that frame: higher means more confident. Click one and accept its predictions: **double-click** a predicted instance, or press \`${ACCEPT_ALL_KEY}\` to accept every prediction on the frame. Then drag any nodes that are off.\n\nAccept and correct predictions on **at least ${MIN_CORRECTED_FRAMES} frames**, then save with \`${SAVE_KEY}\` to continue. The more you correct, the better the retrained model.`,
  tips: {
    label: "Label tips",
    text: "Predicted nodes are yellow. Once accepted, a node is red until you click or drag it, then it turns green. A hollow gray marker means that node is set as not visible. Right-click it and choose **Mark Node Visible**, or select several and use **Toggle Selected Nodes Visibility**, to turn it back on.",
  },
  panelId: "suggestions",
  targetSelector: '[data-tutorial="suggestions-panel"]',
  placement: "left",
  isComplete: (entry, current) =>
    countFramesWithAcceptedPredictions(current.labels) - entry.correctedFrameCount >=
      MIN_CORRECTED_FRAMES && current.hasChanges === false,
};

/**
 * The second training run, on the corrected labels. Completes when a run that
 * started with every `RETRAIN_CHECKS` setting as the checklist asks finishes.
 * Epochs default to `TUTORIAL_RETRAIN_EPOCHS` (trainingDefaults.ts, applied by
 * `TutorialOverlay` once "Train Again" reloads the first run's 5-epoch
 * config), but the checklist is what makes sure they were really used. Stop
 * Early still counts: it ends the run as "completed", and the run started
 * with 50.
 */
export const RETRAIN_STEP: TutorialStep = {
  id: "retrain",
  title: "Re-train with the corrected labels",
  body: `Click **Train Again**. Then check that the Training panel matches the list below: the same settings as the first run, except epochs are now ${TUTORIAL_RETRAIN_EPOCHS} for a better model. Fix anything that isn't ticked, then click **Start Training**. As before, the new model runs on your suggested frames when it finishes.\n\nYou don't have to wait for all ${TUTORIAL_RETRAIN_EPOCHS} epochs: click **Stop Early** to keep what's been trained so far. Top-Down trains two models one after the other, so you'll click Stop Early once for each.`,
  checklist: RETRAIN_CHECKS,
  panelId: "training",
  targetSelector: '[data-tutorial="start-training-button"]',
  placement: "left",
  isComplete: (entry, current) =>
    entry.trainingStartFailures?.length === 0 && current.trainingStatus === "completed",
  incompleteHint: checklistRunHint,
};

function inferenceFinished(entry: TutorialSnapshot, current: TutorialWatchState): boolean {
  return entry.everInferenceRunning && current.inferenceStatus === "completed";
}

/**
 * Inference Target is local component state (InferencePanel), not part of any
 * store — same DOM-text-read idiom `suggestionSettingsOk` uses for a local
 * <Select>'s current value. Read during the run by `observeTutorialState`.
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
  body: "The retrained model has already made new predictions on your suggested frames. Now run it on the whole video to see how it does: Inference Target is set to **Entire current video**, so click **Run Inference**. When it finishes, play or scrub through the video to see predictions on every frame.",
  panelId: "inference",
  targetSelector: '[data-tutorial="run-inference-button"]',
  placement: "left",
  isComplete: (entry, current) =>
    inferenceFinished(entry, current) && entry.inferenceTargetOkAtRun === true,
  incompleteHint: (entry, current) =>
    inferenceFinished(entry, current) && entry.inferenceTargetOkAtRun === false
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
    TRAINING_PROGRESS_STEP,
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
