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

/** The minimal slice of AppState a step's snapshot/isComplete needs. */
export interface TutorialWatchState {
  labels: Labels | null;
  hasChanges: boolean;
  skeleton: Skeleton | null;
  skeletonBuildMode: boolean;
  newProjectDialogOpen: boolean;
  projectLoaded: boolean;
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
  body: 'Click "+ Add video(s)…", pick a video file, then click "Create Project".',
  targetSelector: '[data-tutorial="new-project-add-video-button"]',
  placement: "bottom",
  isComplete: (_entry, current) =>
    current.projectLoaded === true && (current.labels?.videos.length ?? 0) > 0,
};

/** Already-has-a-project step 1: add a video via the Videos panel directly. */
export const ADD_VIDEO_STEP: TutorialStep = {
  id: "add-video",
  title: "Add a video",
  body: 'Click "Add Videos" to import a video file to label.',
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
  body: 'Click "Draw skeleton on frame", place nodes on the frame, then drag a stroke through them to connect edges. Click Done when finished.',
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
 * Resolves the step sequence once, at tutorial start — not re-evaluated
 * mid-run, so a project created partway through the New Project steps
 * doesn't retroactively change the list out from under the engine.
 */
export function buildTutorialSteps(startedWithProjectLoaded: boolean): TutorialStep[] {
  const rest = [SAVE_PROJECT_STEP, GENERATE_SUGGESTIONS_STEP, CREATE_SKELETON_STEP];
  return startedWithProjectLoaded
    ? [ADD_VIDEO_STEP, ...rest]
    : [NEW_PROJECT_STEP, ADD_VIDEO_IN_DIALOG_STEP, ...rest];
}
