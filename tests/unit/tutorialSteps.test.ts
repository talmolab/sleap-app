import { describe, it, expect, afterEach } from "../bun-test";
import {
  NEW_PROJECT_STEP,
  ADD_VIDEO_IN_DIALOG_STEP,
  CONFIRM_VIDEO_AND_CREATE_STEP,
  ADD_VIDEO_STEP,
  SAVE_PROJECT_STEP,
  GENERATE_SUGGESTIONS_STEP,
  CREATE_SKELETON_STEP,
  LABEL_ONE_FRAME_STEP,
  SELECT_ANCHOR_PART_STEP,
  RUN_TRAINING_STEP,
  CORRECT_PREDICTIONS_STEP,
  RETRAIN_STEP,
  RUN_INFERENCE_STEP,
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
    trainingStatus: "idle",
    trainingAnchorPart: null,
    trainingMaxEpochs: null,
    inferenceStatus: "idle",
    ...overrides,
  };
}

/**
 * `suggestions` frames are numbered 0..count-1; `labeledFrameIdxs` and
 * `predictedFrameIdxs` mark which of those already carry a user label or an
 * unaccepted prediction, matching `frameHasUserLabels`/
 * `frameHasPredictedInstances` (both keyed on `labels.find({video, frameIdx})`).
 */
function fakeLabels(
  opts: {
    videos?: number;
    suggestions?: number;
    labeledFrameIdxs?: number[];
    predictedFrameIdxs?: number[];
  } = {},
) {
  const labeledSet = new Set(opts.labeledFrameIdxs ?? []);
  const predictedSet = new Set(opts.predictedFrameIdxs ?? []);
  const suggestions = new Array(opts.suggestions ?? 0)
    .fill(null)
    .map((_, i) => ({ video: {}, frameIdx: i }));
  return {
    videos: new Array(opts.videos ?? 0).fill(null),
    suggestions,
    find: ({ frameIdx }: { frameIdx: number }) => [
      {
        isUserLabeled: labeledSet.has(frameIdx),
        hasPredictedInstances: predictedSet.has(frameIdx),
      },
    ],
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
      "confirm-video-and-create",
      "save-project",
      "generate-suggestions",
      "create-skeleton",
      "label-one-frame",
      "select-anchor-part",
      "run-training",
      "correct-predictions",
      "retrain",
      "run-inference-video",
    ]);
  });

  it("skips straight to the Videos-panel add-video step when a project is already loaded", () => {
    const steps = buildTutorialSteps(true);
    expect(steps.map((s) => s.id)).toEqual([
      "add-video",
      "save-project",
      "generate-suggestions",
      "create-skeleton",
      "label-one-frame",
      "select-anchor-part",
      "run-training",
      "correct-predictions",
      "retrain",
      "run-inference-video",
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
  afterEach(() => {
    document
      .querySelectorAll('[data-tutorial="new-project-video-list"]')
      .forEach((el) => el.remove());
  });

  it("is incomplete before any video is staged in the dialog", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState();
    expect(ADD_VIDEO_IN_DIALOG_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete if the staged-video list renders empty", () => {
    const ul = document.createElement("ul");
    ul.setAttribute("data-tutorial", "new-project-video-list");
    document.body.appendChild(ul);
    const entry = snapshotTutorialState(watchState());
    const current = watchState();
    expect(ADD_VIDEO_IN_DIALOG_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once a video is staged in the dialog's video list", () => {
    const ul = document.createElement("ul");
    ul.setAttribute("data-tutorial", "new-project-video-list");
    ul.appendChild(document.createElement("li"));
    document.body.appendChild(ul);
    const entry = snapshotTutorialState(watchState());
    const current = watchState();
    expect(ADD_VIDEO_IN_DIALOG_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("confirm-video-and-create step", () => {
  it("is incomplete before the project is created", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ projectLoaded: false, labels: fakeLabels({ videos: 1 }) });
    expect(CONFIRM_VIDEO_AND_CREATE_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete if the project was created with no videos", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ projectLoaded: true, labels: fakeLabels({ videos: 0 }) });
    expect(CONFIRM_VIDEO_AND_CREATE_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once the project is created with at least one video", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ projectLoaded: true, labels: fakeLabels({ videos: 1 }) });
    expect(CONFIRM_VIDEO_AND_CREATE_STEP.isComplete(entry, current)).toBe(true);
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

describe("label-one-frame step", () => {
  it("is incomplete with no suggestions labeled at all", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    const current = watchState({
      labels: fakeLabels({ suggestions: 5 }),
      hasChanges: false,
    });
    expect(LABEL_ONE_FRAME_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes even if the labeled frame predates this step (e.g. an instance created while finishing create-skeleton)", () => {
    // Unlike sibling steps, this one does NOT require growth from entry —
    // labeling a suggestion frame during the prior step (via the "Create
    // instance" prompt) already satisfies the goal; the user shouldn't have
    // to label a second frame just because it happened one step early.
    const entry = snapshotTutorialState(
      watchState({ labels: fakeLabels({ suggestions: 5, labeledFrameIdxs: [0] }) }),
    );
    const current = watchState({
      labels: fakeLabels({ suggestions: 5, labeledFrameIdxs: [0] }),
      hasChanges: false,
    });
    expect(LABEL_ONE_FRAME_STEP.isComplete(entry, current)).toBe(true);
  });

  it("is incomplete if a frame was labeled but not yet saved", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    const current = watchState({
      labels: fakeLabels({ suggestions: 5, labeledFrameIdxs: [0] }),
      hasChanges: true,
    });
    expect(LABEL_ONE_FRAME_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once one frame is labeled during this step and saved", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    const current = watchState({
      labels: fakeLabels({ suggestions: 5, labeledFrameIdxs: [0] }),
      hasChanges: false,
    });
    expect(LABEL_ONE_FRAME_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("select-anchor-part step", () => {
  it("is incomplete while the anchor part is unset (Auto)", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ trainingAnchorPart: null });
    expect(SELECT_ANCHOR_PART_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once an explicit anchor part is picked", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ trainingAnchorPart: "thorax" });
    expect(SELECT_ANCHOR_PART_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("run-training step", () => {
  it("is incomplete if training never ran during this step", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "idle" }));
    const current = watchState({ trainingStatus: "completed" });
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete while training is still running", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "running" }));
    const current = watchState({ trainingStatus: "running" });
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once a run seen during this step reaches completed", () => {
    // The engine ORs `everTraining` forward as it observes `trainingStatus`;
    // simulate that here directly on the entry snapshot (same idiom as
    // `everEnteredSkeletonBuild` above).
    const entry = snapshotTutorialState(watchState());
    entry.everTraining = true;
    const current = watchState({ trainingStatus: "completed" });
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("correct-predictions step", () => {
  it("is incomplete if no suggestion frame had a prediction at entry", () => {
    const entry = snapshotTutorialState(
      watchState({ labels: fakeLabels({ suggestions: 5 }) }),
    );
    const current = watchState({ labels: fakeLabels({ suggestions: 5 }) });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete while the predicted-frame count hasn't dropped", () => {
    const entry = snapshotTutorialState(
      watchState({
        labels: fakeLabels({ suggestions: 5, predictedFrameIdxs: [0, 1] }),
      }),
    );
    const current = watchState({
      labels: fakeLabels({ suggestions: 5, predictedFrameIdxs: [0, 1] }),
    });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once at least one predicted frame is accepted/corrected", () => {
    const entry = snapshotTutorialState(
      watchState({
        labels: fakeLabels({ suggestions: 5, predictedFrameIdxs: [0, 1] }),
      }),
    );
    const current = watchState({
      labels: fakeLabels({ suggestions: 5, predictedFrameIdxs: [1] }),
    });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(true);
  });
});

describe("retrain step", () => {
  it("is incomplete until a run seen during this step reaches completed", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "idle" }));
    const current = watchState({
      trainingStatus: "completed",
      trainingAnchorPart: "torso",
      trainingMaxEpochs: 200,
    });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete if training finished but Anchor Part isn't torso", () => {
    const entry = snapshotTutorialState(watchState());
    entry.everTraining = true;
    const current = watchState({
      trainingStatus: "completed",
      trainingAnchorPart: "thorax",
      trainingMaxEpochs: 200,
    });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete if training finished but Epochs isn't 200", () => {
    const entry = snapshotTutorialState(watchState());
    entry.everTraining = true;
    const current = watchState({
      trainingStatus: "completed",
      trainingAnchorPart: "torso",
      trainingMaxEpochs: 5,
    });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete without a matching Post-Training Inference Target DOM element", () => {
    // No matching data-tutorial element exists in this DOM-less test env, so
    // textContent reads back empty — same idiom as generate-suggestions above.
    const entry = snapshotTutorialState(watchState());
    entry.everTraining = true;
    const current = watchState({
      trainingStatus: "completed",
      trainingAnchorPart: "torso",
      trainingMaxEpochs: 200,
    });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  describe("with a Post-Training Inference Target DOM element", () => {
    let select: HTMLElement;

    afterEach(() => {
      select.remove();
    });

    it("is incomplete if Post-Training Inference Target isn't Random sample (current video)", () => {
      select = document.createElement("div");
      select.setAttribute("data-tutorial", "post-training-inference-target-select");
      select.textContent = "Suggested frames";
      document.body.appendChild(select);

      const entry = snapshotTutorialState(watchState());
      entry.everTraining = true;
      const current = watchState({
        trainingStatus: "completed",
        trainingAnchorPart: "torso",
        trainingMaxEpochs: 200,
      });
      expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
    });

    it("completes once a run seen during this step reaches completed with Anchor Part torso, Epochs 200, and target Random sample (current video)", () => {
      select = document.createElement("div");
      select.setAttribute("data-tutorial", "post-training-inference-target-select");
      select.textContent = "Random sample (current video)";
      document.body.appendChild(select);

      const entry = snapshotTutorialState(watchState());
      entry.everTraining = true;
      const current = watchState({
        trainingStatus: "completed",
        trainingAnchorPart: "torso",
        trainingMaxEpochs: 200,
      });
      expect(RETRAIN_STEP.isComplete(entry, current)).toBe(true);
    });
  });
});

describe("run-inference-video step", () => {
  it("is incomplete if inference never ran during this step", () => {
    const entry = snapshotTutorialState(watchState());
    const current = watchState({ inferenceStatus: "completed" });
    expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete while inference is still running", () => {
    const entry = snapshotTutorialState(watchState({ inferenceStatus: "running" }));
    const current = watchState({ inferenceStatus: "running" });
    expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(false);
  });

  it("does not complete from status alone without a matching DOM target select", () => {
    // No matching data-tutorial element exists in this DOM-less test env, so
    // textContent reads back empty — same idiom as generate-suggestions above.
    const entry = snapshotTutorialState(watchState());
    entry.everInferenceRunning = true;
    const current = watchState({ inferenceStatus: "completed" });
    expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(false);
  });
});
