import { describe, it, expect } from "../bun-test";
import {
  NEW_PROJECT_STEP,
  ADD_VIDEO_IN_DIALOG_STEP,
  ADD_VIDEO_STEP,
  SAVE_PROJECT_STEP,
  GENERATE_SUGGESTIONS_STEP,
  CREATE_SKELETON_STEP,
  buildTutorialSteps,
  snapshotTutorialState,
  type TutorialWatchState,
} from "@/lib/tutorial/steps";

function watchState(overrides: Partial<TutorialWatchState> = {}): TutorialWatchState {
  return {
    labels: null,
    hasChanges: false,
    skeleton: null,
    skeletonBuildMode: false,
    newProjectDialogOpen: false,
    projectLoaded: false,
    ...overrides,
  };
}

function fakeLabels(opts: { videos?: number; suggestions?: number } = {}) {
  return {
    videos: new Array(opts.videos ?? 0).fill(null),
    suggestions: new Array(opts.suggestions ?? 0).fill(null),
  } as unknown as TutorialWatchState["labels"];
}

function fakeSkeleton(opts: { nodes?: number; edges?: number } = {}) {
  return {
    nodes: new Array(opts.nodes ?? 0).fill(null),
    edges: new Array(opts.edges ?? 0).fill(null),
  } as unknown as TutorialWatchState["skeleton"];
}

describe("buildTutorialSteps", () => {
  it("starts with New Project + add-video-in-dialog when no project is loaded", () => {
    const steps = buildTutorialSteps(false);
    expect(steps.map((s) => s.id)).toEqual([
      "new-project",
      "add-video-in-dialog",
      "save-project",
      "generate-suggestions",
      "create-skeleton",
    ]);
  });

  it("skips straight to the Videos-panel add-video step when a project is already loaded", () => {
    const steps = buildTutorialSteps(true);
    expect(steps.map((s) => s.id)).toEqual([
      "add-video",
      "save-project",
      "generate-suggestions",
      "create-skeleton",
    ]);
  });
});

describe("new-project step", () => {
  it("is incomplete until the New Project dialog opens", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ newProjectDialogOpen: false });
    expect(NEW_PROJECT_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once the New Project dialog opens", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ newProjectDialogOpen: true });
    expect(NEW_PROJECT_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("add-video-in-dialog step", () => {
  it("is incomplete before the project is created", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ projectLoaded: false, labels: fakeLabels({ videos: 1 }) });
    expect(ADD_VIDEO_IN_DIALOG_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete if the project was created with no videos", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ projectLoaded: true, labels: fakeLabels({ videos: 0 }) });
    expect(ADD_VIDEO_IN_DIALOG_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once the project is created with at least one video", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ projectLoaded: true, labels: fakeLabels({ videos: 1 }) });
    expect(ADD_VIDEO_IN_DIALOG_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("add-video step (existing project)", () => {
  it("is incomplete when video count hasn't grown", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ videos: 1 }) }));
    const current = watchState({ labels: fakeLabels({ videos: 1 }) });
    expect(ADD_VIDEO_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once the video count increases from the entry snapshot", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ videos: 0 }) }));
    const current = watchState({ labels: fakeLabels({ videos: 1 }) });
    expect(ADD_VIDEO_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("save-project step", () => {
  it("is incomplete while hasChanges is still true", () => {
    const entry = snapshotTutorialState(watchState({ hasChanges: true }));
    const current = watchState({ hasChanges: true });
    expect(SAVE_PROJECT_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once hasChanges flips to false", () => {
    const entry = snapshotTutorialState(watchState({ hasChanges: true }));
    const current = watchState({ hasChanges: false });
    expect(SAVE_PROJECT_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("generate-suggestions step", () => {
  it("is incomplete when the suggestion count hasn't grown", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 0 }) }));
    const current = watchState({ labels: fakeLabels({ suggestions: 0 }) });
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("does not complete just from a grown count without matching DOM param values", () => {
    // No matching data-tutorial elements exist in this DOM-less test env, so
    // textContent/value reads come back empty/undefined — params don't validate.
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 0 }) }));
    const current = watchState({ labels: fakeLabels({ suggestions: 5 }) });
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, current)).toBe(false);
  });
});

describe("create-skeleton step", () => {
  it("is incomplete if the builder was never entered, even if counts grew", () => {
    const entry = snapshotTutorialState(watchState({ skeletonBuildMode: false }));
    const current = watchState({
      skeleton: fakeSkeleton({ nodes: 2, edges: 1 }),
      skeletonBuildMode: false,
    });
    expect(CREATE_SKELETON_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete while still inside the builder", () => {
    const entry = snapshotTutorialState(watchState({ skeletonBuildMode: true }));
    const current = watchState({
      skeleton: fakeSkeleton({ nodes: 2, edges: 1 }),
      skeletonBuildMode: true,
    });
    expect(CREATE_SKELETON_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once the builder was entered, exited, and nodes/edges grew", () => {
    // The engine ORs `everEnteredSkeletonBuild` forward as it observes
    // skeletonBuildMode; simulate that here directly on the entry snapshot.
    const entry = snapshotTutorialState(watchState({ skeletonBuildMode: false }));
    entry.everEnteredSkeletonBuild = true;
    const current = watchState({
      skeleton: fakeSkeleton({ nodes: 2, edges: 1 }),
      skeletonBuildMode: false,
    });
    expect(CREATE_SKELETON_STEP.isComplete(entry, current)).toBe(true);
  });
});
