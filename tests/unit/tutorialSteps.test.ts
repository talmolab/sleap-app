import { describe, it, expect, afterEach } from "../bun-test";
import {
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
  CHECK_ENVIRONMENT_STEP,
  BROWSER_NOTICE_STEP,
  WELCOME_STEP,
  tutorialIncludesTraining,
  buildTutorialSteps,
  tutorialStepNumber,
  snapshotTutorialState,
  observeTutorialState,
  TUTORIAL_FIRST_TRAINING_STEP_IDS,
  TUTORIAL_SKELETON,
  tutorialSkeletonProblems,
  TRAINING_CHECKS,
  evaluateChecklist,
  checklistFailures,
  RETRAIN_CHECKS,
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
    trainingCentroidMaxEpochs: null,
    postTrainingInferenceTarget: null,
    inferenceStatus: "idle",
    envDetected: false,
    uvAvailable: false,
    sleapNnInstalled: false,
    acceleratorDetected: false,
    accelerator: null,
    ...overrides,
  };
}

/**
 * `suggestions` frames are numbered 0..count-1; `labeledFrameIdxs` marks which
 * of those already carry a user label, matching `frameHasUserLabels` (keyed on
 * `labels.find({video, frameIdx})`). `correctedFrames` frames in
 * `labeledFrames` each hold `acceptedPerFrame` user instances with a
 * `fromPredicted` link; one more frame holds only a plain user instance and a
 * prediction, which don't count as accepted.
 */
function fakeLabels(
  opts: {
    videos?: number;
    suggestions?: number;
    labeledFrameIdxs?: number[];
    correctedFrames?: number;
    acceptedPerFrame?: number;
  } = {},
) {
  const labeledSet = new Set(opts.labeledFrameIdxs ?? []);
  const suggestions = new Array(opts.suggestions ?? 0)
    .fill(null)
    .map((_, i) => ({ video: {}, frameIdx: i }));
  const corrected = new Array(opts.correctedFrames ?? 0).fill(null).map(() => ({
    instances: new Array(opts.acceptedPerFrame ?? 1)
      .fill(null)
      .map(() => ({ fromPredicted: { score: 1 } })),
  }));
  return {
    videos: new Array(opts.videos ?? 0).fill(null),
    suggestions,
    labeledFrames: [...corrected, { instances: [{ fromPredicted: null }, { score: 0.5 }] }],
    find: ({ frameIdx }: { frameIdx: number }) => [
      { isUserLabeled: labeledSet.has(frameIdx) },
    ],
  } as unknown as TutorialWatchState["labels"];
}

function fakeSkeleton(opts: { nodes?: number; edges?: number } = {}) {
  return {
    nodes: new Array(opts.nodes ?? 0).fill(null),
    edges: new Array(opts.edges ?? 0).fill(null),
  } as unknown as TutorialWatchState["skeleton"];
}

/** A skeleton with real node names and `[source, destination]` edges. */
function namedSkeleton(nodes: readonly string[], edges: readonly (readonly [string, string])[] = []) {
  return {
    nodes: nodes.map((name) => ({ name })),
    edges: edges.map(([source, destination]) => ({
      source: { name: source },
      destination: { name: destination },
    })),
  } as unknown as TutorialWatchState["skeleton"];
}

const tutorialSkeleton = () =>
  namedSkeleton(TUTORIAL_SKELETON.nodes, TUTORIAL_SKELETON.edges);

describe("buildTutorialSteps", () => {
  const core = [
    "new-project",
    "add-video-in-dialog",
    "confirm-video-and-create",
    "save-project",
    "generate-suggestions",
    "create-skeleton",
    "label-one-frame",
  ];

  it("desktop: welcome, environment check, then New Project through whole-video inference", () => {
    const steps = buildTutorialSteps(true);
    expect(steps.map((s) => s.id)).toEqual([
      "welcome",
      "check-environment",
      ...core,
      "run-training",
      "training-progress",
      "correct-predictions",
      "retrain",
      "run-inference-video",
    ]);
    expect(tutorialIncludesTraining(steps)).toBe(true);
  });

  it("browser: welcome, the can't-train notice, then stops after labeling", () => {
    const steps = buildTutorialSteps(false);
    expect(steps.map((s) => s.id)).toEqual(["welcome", "browser-notice", ...core]);
    expect(tutorialIncludesTraining(steps)).toBe(false);
  });
});

describe("add-video-in-dialog step target", () => {
  it("targets the sample video button and mentions it in the body", () => {
    expect(ADD_VIDEO_IN_DIALOG_STEP.targetSelector).toBe(
      '[data-tutorial="new-project-sample-video-button"]',
    );
    expect(ADD_VIDEO_IN_DIALOG_STEP.body).toContain("Use sample video");
  });
});

describe("tutorialStepNumber", () => {
  it("doesn't number the welcome card", () => {
    expect(tutorialStepNumber(buildTutorialSteps(true), 0)).toBe(-1);
    expect(tutorialStepNumber(buildTutorialSteps(false), 0)).toBe(-1);
  });

  it("makes the environment check step 0 so the rest keep their numbers", () => {
    const steps = buildTutorialSteps(true);
    expect(tutorialStepNumber(steps, steps.indexOf(CHECK_ENVIRONMENT_STEP))).toBe(0);
    expect(tutorialStepNumber(steps, steps.indexOf(NEW_PROJECT_STEP))).toBe(1);
    expect(tutorialStepNumber(steps, steps.indexOf(RUN_TRAINING_STEP))).toBe(8);
    expect(tutorialStepNumber(steps, steps.indexOf(TRAINING_PROGRESS_STEP))).toBe(9);
    expect(tutorialStepNumber(steps, steps.length - 1)).toBe(12);
  });

  it("numbers the browser run the same way, ending at step 7", () => {
    const steps = buildTutorialSteps(false);
    expect(tutorialStepNumber(steps, steps.indexOf(BROWSER_NOTICE_STEP))).toBe(0);
    expect(tutorialStepNumber(steps, steps.indexOf(NEW_PROJECT_STEP))).toBe(1);
    expect(tutorialStepNumber(steps, steps.length - 1)).toBe(7);
  });

  it("gives every shared step the same number in both builds", () => {
    const desktop = buildTutorialSteps(true);
    const browser = buildTutorialSteps(false);
    for (const [i, step] of browser.entries()) {
      if (step === WELCOME_STEP || step === BROWSER_NOTICE_STEP) continue;
      expect(tutorialStepNumber(browser, i)).toBe(
        tutorialStepNumber(desktop, desktop.indexOf(step)),
      );
    }
  });

  it("numbers from 1 when the sequence has no step 0", () => {
    const steps = buildTutorialSteps(true).slice(2);
    expect(tutorialStepNumber(steps, 0)).toBe(1);
  });
});

describe("welcome step", () => {
  it("is centered, complete straight away, and waits for Start", () => {
    const current = watchState();
    expect(WELCOME_STEP.targetSelector).toBeNull();
    expect(WELCOME_STEP.isComplete(snapshotTutorialState(current), current)).toBe(true);
    expect(WELCOME_STEP.holdBeforeAdvance?.(current)).toBe(true);
  });
});

describe("browser-notice step", () => {
  it("has no control to highlight", () => {
    expect(BROWSER_NOTICE_STEP.targetSelector).toBeNull();
  });

  it("is complete straight away but waits for Next", () => {
    const current = watchState();
    expect(BROWSER_NOTICE_STEP.isComplete(snapshotTutorialState(current), current)).toBe(true);
    expect(BROWSER_NOTICE_STEP.holdBeforeAdvance?.(current)).toBe(true);
  });

  it("says training isn't available and that the tutorial ends before it", () => {
    expect(BROWSER_NOTICE_STEP.body).toContain("can't be trained");
    expect(BROWSER_NOTICE_STEP.body).toContain("ends there");
  });
});

describe("check-environment step", () => {
  const ready = {
    envDetected: true,
    uvAvailable: true,
    sleapNnInstalled: true,
    acceleratorDetected: true,
  };
  const entry = snapshotTutorialState(watchState());

  it("is incomplete until detection has run", () => {
    expect(CHECK_ENVIRONMENT_STEP.isComplete(entry, watchState())).toBe(false);
  });

  it("is incomplete without uv", () => {
    expect(
      CHECK_ENVIRONMENT_STEP.isComplete(entry, watchState({ ...ready, uvAvailable: false })),
    ).toBe(false);
  });

  it("is incomplete without sleap-nn", () => {
    expect(
      CHECK_ENVIRONMENT_STEP.isComplete(entry, watchState({ ...ready, sleapNnInstalled: false })),
    ).toBe(false);
  });

  it("waits for the accelerator probe, so a CPU-only machine isn't skipped past", () => {
    expect(
      CHECK_ENVIRONMENT_STEP.isComplete(entry, watchState({ ...ready, acceleratorDetected: false })),
    ).toBe(false);
  });

  it("completes on any accelerator but always waits for Next", () => {
    for (const accelerator of ["cuda", "mps", "cpu", null] as const) {
      const current = watchState({ ...ready, accelerator });
      expect(CHECK_ENVIRONMENT_STEP.isComplete(entry, current)).toBe(true);
      expect(CHECK_ENVIRONMENT_STEP.holdBeforeAdvance?.(current)).toBe(true);
    }
  });

  it("names the training step and the last step before it in its CPU warning", () => {
    const note = CHECK_ENVIRONMENT_STEP.cpuNote?.(8) ?? "";
    expect(note).toContain("step 8");
    expect(note).toContain("step 7");
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
  let controls: HTMLElement[] = [];

  afterEach(() => {
    for (const el of controls) el.remove();
    controls = [];
  });

  /** Stand-ins for the Suggestions panel's Method select and Per video input. */
  function withSettings(method: string, perVideo: string) {
    for (const el of controls) el.remove();
    const select = document.createElement("div");
    select.setAttribute("data-tutorial", "suggestions-method-select");
    select.textContent = method;
    const input = document.createElement("input");
    input.setAttribute("data-tutorial", "suggestions-per-video-input");
    input.value = perVideo;
    controls = [select, input];
    for (const el of controls) document.body.appendChild(el);
  }

  it("is incomplete when the suggestion count hasn't grown", () => {
    withSettings("Stride", "20");
    const current = watchState({ labels: fakeLabels({ suggestions: 0 }) });
    const entry = snapshotTutorialState(current);
    observeTutorialState(entry, current);
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, current)).toBe(false);
    expect(GENERATE_SUGGESTIONS_STEP.incompleteHint?.(entry, current)).toBeNull();
  });

  it("completes when suggestions are generated with Stride / 20", () => {
    withSettings("Stride", "20");
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 0 }) }));
    const current = watchState({ labels: fakeLabels({ suggestions: 20 }) });
    observeTutorialState(entry, current);
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, current)).toBe(true);
  });

  it("names the expected settings when suggestions were made with others", () => {
    withSettings("Random", "5");
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 0 }) }));
    const current = watchState({ labels: fakeLabels({ suggestions: 5 }) });
    observeTutorialState(entry, current);
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, current)).toBe(false);
    const hint = GENERATE_SUGGESTIONS_STEP.incompleteHint?.(entry, current) ?? "";
    expect(hint).toContain("Stride");
    expect(hint).toContain("20");
  });

  it("doesn't complete from fixing the settings without generating again", () => {
    withSettings("Random", "5");
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 0 }) }));
    const current = watchState({ labels: fakeLabels({ suggestions: 5 }) });
    observeTutorialState(entry, current);
    withSettings("Stride", "20");
    observeTutorialState(entry, current);
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once regenerated with the right settings", () => {
    withSettings("Random", "5");
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 0 }) }));
    observeTutorialState(entry, watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    withSettings("Stride", "20");
    const regenerated = watchState({ labels: fakeLabels({ suggestions: 20 }) });
    observeTutorialState(entry, regenerated);
    expect(GENERATE_SUGGESTIONS_STEP.isComplete(entry, regenerated)).toBe(true);
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
      skeleton: tutorialSkeleton(),
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
      skeleton: tutorialSkeleton(),
    });
    expect(LABEL_ONE_FRAME_STEP.isComplete(entry, current)).toBe(true);
  });

  it("is incomplete while the skeleton has an extra node, even when labeled and saved", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    const current = watchState({
      labels: fakeLabels({ suggestions: 5, labeledFrameIdxs: [0] }),
      hasChanges: false,
      skeleton: namedSkeleton(["head", "torso", "tailbase", "nose"], TUTORIAL_SKELETON.edges),
    });
    expect(LABEL_ONE_FRAME_STEP.isComplete(entry, current)).toBe(false);
    const hint = LABEL_ONE_FRAME_STEP.incompleteHint?.(entry, current) ?? "";
    expect(hint).toContain("extra node **nose**");
    expect(hint).toContain("**Skeleton** panel");
  });

  it("shows the skeleton hint as soon as the step opens, before any labeling", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    const current = watchState({
      labels: fakeLabels({ suggestions: 5 }),
      skeleton: namedSkeleton(["head", "torso"], [["torso", "head"]]),
    });
    expect(LABEL_ONE_FRAME_STEP.incompleteHint?.(entry, current)).toContain(
      "missing node **tailbase**",
    );
  });

  it("has no hint when the skeleton matches", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels({ suggestions: 5 }) }));
    const current = watchState({
      labels: fakeLabels({ suggestions: 5 }),
      skeleton: tutorialSkeleton(),
    });
    expect(LABEL_ONE_FRAME_STEP.incompleteHint?.(entry, current)).toBeNull();
  });
});

/** Watch state with every `TRAINING_CHECKS` setting as the checklist asks. */
function trainingReady(
  overrides: Partial<TutorialWatchState> & { anchor?: string | null; epochs?: number } = {},
): TutorialWatchState {
  const { anchor = "torso", epochs = 5, ...rest } = overrides;
  return watchState({
    postTrainingInferenceTarget: "Suggested frames",
    trainingAnchorPart: anchor,
    trainingMaxEpochs: epochs,
    trainingCentroidMaxEpochs: epochs,
    ...rest,
  });
}

describe("run-training step", () => {
  it("is incomplete until training starts", () => {
    const current = watchState({ trainingStatus: "idle" });
    const entry = snapshotTutorialState(current, TRAINING_CHECKS);
    observeTutorialState(entry, current, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes as soon as training is running with the checklist's settings", () => {
    const entry = snapshotTutorialState(trainingReady({ trainingStatus: "idle" }), TRAINING_CHECKS);
    const current = trainingReady({ trainingStatus: "running" });
    observeTutorialState(entry, current, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(true);
  });

  it("holds the step when a run starts with a setting off, and says to cancel and fix it", () => {
    const entry = snapshotTutorialState(trainingReady({ trainingStatus: "idle" }), TRAINING_CHECKS);
    const wrong = trainingReady({
      trainingStatus: "running",
      postTrainingInferenceTarget: "Entire current video",
    });
    observeTutorialState(entry, wrong, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.isComplete(entry, wrong)).toBe(false);
    const hint = RUN_TRAINING_STEP.incompleteHint?.(entry, wrong) ?? "";
    expect(hint).toContain("Post-training inference target is Entire current video");
    expect(hint).toContain("**Cancel**");

    // Cancel ends the run (status "error"); the hint goes, the checklist takes over.
    const cancelled = trainingReady({ trainingStatus: "error" });
    observeTutorialState(entry, cancelled, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.incompleteHint?.(entry, cancelled)).toBeNull();

    // Starting again with everything set completes it.
    const restarted = trainingReady({ trainingStatus: "running" });
    observeTutorialState(entry, restarted, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.isComplete(entry, restarted)).toBe(true);
  });

  it("judges a run by the settings from before the click when a control can't be read once it runs", () => {
    const entry = snapshotTutorialState(trainingReady({ trainingStatus: "idle" }), TRAINING_CHECKS);
    observeTutorialState(entry, trainingReady({ anchor: "head" }), TRAINING_CHECKS);
    const running = trainingReady({
      trainingStatus: "running",
      anchor: "head",
      postTrainingInferenceTarget: null,
    });
    observeTutorialState(entry, running, TRAINING_CHECKS);
    expect(entry.trainingStartFailures).toEqual(["Anchor part is head"]);
    expect(RUN_TRAINING_STEP.isComplete(entry, running)).toBe(false);
  });

  it("completes when the step opens with a run already going", () => {
    const current = watchState({ trainingStatus: "running" });
    const entry = snapshotTutorialState(current, TRAINING_CHECKS);
    observeTutorialState(entry, current, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(true);
  });

  it("doesn't complete from an earlier run's completed status", () => {
    const current = watchState({ trainingStatus: "completed" });
    const entry = snapshotTutorialState(current, TRAINING_CHECKS);
    observeTutorialState(entry, current, TRAINING_CHECKS);
    expect(RUN_TRAINING_STEP.isComplete(entry, current)).toBe(false);
  });
});

describe("training-progress step", () => {
  it("points at the training progress area", () => {
    expect(TRAINING_PROGRESS_STEP.targetSelector).toBe('[data-tutorial="training-progress"]');
  });

  it("is incomplete while training is still running", () => {
    const current = watchState({ trainingStatus: "running" });
    const entry = snapshotTutorialState(current);
    observeTutorialState(entry, current);
    expect(TRAINING_PROGRESS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once the run it saw finishes", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "running" }));
    const current = watchState({ trainingStatus: "completed" });
    observeTutorialState(entry, current);
    expect(TRAINING_PROGRESS_STEP.isComplete(entry, current)).toBe(true);
  });

  it("keeps the first pass's 5-epoch settings while it runs", () => {
    expect(TUTORIAL_FIRST_TRAINING_STEP_IDS.has(TRAINING_PROGRESS_STEP.id)).toBe(true);
  });
});

describe("correct-predictions step", () => {
  it("is incomplete with predictions accepted on only 1 frame", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels() }));
    const current = watchState({ labels: fakeLabels({ correctedFrames: 1 }) });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("counts frames, not instances: 2 accepted on one frame isn't enough", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels() }));
    const current = watchState({
      labels: fakeLabels({ correctedFrames: 1, acceptedPerFrame: 2 }),
    });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete until saved", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels() }));
    const current = watchState({
      labels: fakeLabels({ correctedFrames: 2 }),
      hasChanges: true,
    });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes once predictions on 2 frames are accepted and saved", () => {
    const entry = snapshotTutorialState(watchState({ labels: fakeLabels() }));
    const current = watchState({ labels: fakeLabels({ correctedFrames: 2 }) });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(true);
  });

  it("only counts frames corrected during this step", () => {
    const entry = snapshotTutorialState(
      watchState({ labels: fakeLabels({ correctedFrames: 3 }) }),
    );
    const current = watchState({ labels: fakeLabels({ correctedFrames: 4 }) });
    expect(CORRECT_PREDICTIONS_STEP.isComplete(entry, current)).toBe(false);
  });
});

describe("retrain step", () => {
  it("is incomplete until a run seen during this step reaches completed", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "idle" }));
    const current = watchState({ trainingStatus: "completed" });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete while training is still running", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "running" }));
    const current = watchState({ trainingStatus: "running" });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  it("is incomplete if the run ended in an error (e.g. Cancel)", () => {
    const entry = snapshotTutorialState(watchState({ trainingStatus: "running" }));
    const current = watchState({ trainingStatus: "error" });
    expect(RETRAIN_STEP.isComplete(entry, current)).toBe(false);
  });

  it("completes when a run started with the retrain settings finishes (Stop Early included)", () => {
    const entry = snapshotTutorialState(trainingReady({ epochs: 50 }), RETRAIN_CHECKS);
    observeTutorialState(entry, trainingReady({ epochs: 50, trainingStatus: "running" }), RETRAIN_CHECKS);
    // Stop Early ends the run as "completed", whatever epoch it reached.
    const done = trainingReady({ epochs: 50, trainingStatus: "completed" });
    observeTutorialState(entry, done, RETRAIN_CHECKS);
    expect(RETRAIN_STEP.isComplete(entry, done)).toBe(true);
  });

  it("doesn't complete from a run started with the first run's 5 epochs, and says to train again", () => {
    const entry = snapshotTutorialState(trainingReady({ epochs: 5 }), RETRAIN_CHECKS);
    const running = trainingReady({ epochs: 5, trainingStatus: "running" });
    observeTutorialState(entry, running, RETRAIN_CHECKS);
    expect(RETRAIN_STEP.incompleteHint?.(entry, running)).toContain("**Cancel**");

    const done = trainingReady({ epochs: 5, trainingStatus: "completed" });
    observeTutorialState(entry, done, RETRAIN_CHECKS);
    expect(RETRAIN_STEP.isComplete(entry, done)).toBe(false);
    const hint = RETRAIN_STEP.incompleteHint?.(entry, done) ?? "";
    expect(hint).toContain("Centroid epochs is 5");
    expect(hint).toContain("**Train Again**");
  });

  it("checks a wrong anchor on the retrain run too", () => {
    const entry = snapshotTutorialState(trainingReady({ epochs: 50, anchor: "head" }), RETRAIN_CHECKS);
    observeTutorialState(
      entry,
      trainingReady({ epochs: 50, anchor: "head", trainingStatus: "running" }),
      RETRAIN_CHECKS,
    );
    const done = trainingReady({ epochs: 50, anchor: "head", trainingStatus: "completed" });
    observeTutorialState(entry, done, RETRAIN_CHECKS);
    expect(RETRAIN_STEP.isComplete(entry, done)).toBe(false);
    expect(entry.trainingStartFailures).toEqual(["Anchor part is head"]);
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
    observeTutorialState(entry, watchState({ inferenceStatus: "running" }));
    const current = watchState({ inferenceStatus: "completed" });
    expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(false);
  });

  describe("with an Inference Target DOM element", () => {
    let select: HTMLElement;

    afterEach(() => {
      select.remove();
    });

    function withTarget(text: string) {
      select = document.createElement("div");
      select.setAttribute("data-tutorial", "inference-target-select");
      select.textContent = text;
      document.body.appendChild(select);
    }

    function setTarget(text: string) {
      select.textContent = text;
    }

    it("is incomplete for a target other than the entire video", () => {
      withTarget("Random sample (current video)");
      const entry = snapshotTutorialState(watchState());
      observeTutorialState(entry, watchState({ inferenceStatus: "running" }));
      const current = watchState({ inferenceStatus: "completed" });
      expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(false);
      expect(RUN_INFERENCE_STEP.incompleteHint?.(entry, current)).toContain(
        "Entire current video",
      );
    });

    it("has no hint before inference has run", () => {
      withTarget("Random sample (current video)");
      const entry = snapshotTutorialState(watchState());
      const current = watchState({ inferenceStatus: "idle" });
      expect(RUN_INFERENCE_STEP.incompleteHint?.(entry, current)).toBeNull();
    });

    it("completes once inference on the entire current video finishes", () => {
      withTarget("Entire current video");
      const entry = snapshotTutorialState(watchState());
      observeTutorialState(entry, watchState({ inferenceStatus: "running" }));
      const current = watchState({ inferenceStatus: "completed" });
      observeTutorialState(entry, current);
      expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(true);
    });

    it("doesn't complete from switching the target after a wrong-target run", () => {
      withTarget("Random sample (current video)");
      const entry = snapshotTutorialState(watchState());
      observeTutorialState(entry, watchState({ inferenceStatus: "running" }));
      const current = watchState({ inferenceStatus: "completed" });
      observeTutorialState(entry, current);
      setTarget("Entire current video");
      observeTutorialState(entry, current);
      expect(RUN_INFERENCE_STEP.isComplete(entry, current)).toBe(false);
    });
  });
});

describe("tutorialSkeletonProblems", () => {
  it("accepts the skeleton the tutorial asks for", () => {
    expect(tutorialSkeletonProblems(tutorialSkeleton())).toEqual([]);
  });

  it("reports a missing or empty skeleton", () => {
    expect(tutorialSkeletonProblems(null)).toEqual(["it has no nodes"]);
    expect(tutorialSkeletonProblems(namedSkeleton([]))).toEqual(["it has no nodes"]);
  });

  it("reports extra and missing nodes by name", () => {
    expect(
      tutorialSkeletonProblems(namedSkeleton(["head", "torso", "tailbase", "nose"])),
    ).toEqual(["extra node **nose**"]);
    expect(tutorialSkeletonProblems(namedSkeleton(["head", "torso"]))).toEqual([
      "missing node **tailbase**",
    ]);
  });

  it("matches names exactly, since the torso anchor lookup does", () => {
    expect(
      tutorialSkeletonProblems(namedSkeleton(["head", "Torso", "tailbase"], [])),
    ).toEqual(["extra node **Torso**", "missing node **torso**"]);
  });

  it("reports a misnamed node once, not its edges too", () => {
    expect(
      tutorialSkeletonProblems(
        namedSkeleton(["head", "torso", "tail"], [["torso", "head"], ["torso", "tail"]]),
      ),
    ).toEqual(["extra node **tail**", "missing node **tailbase**"]);
  });

  it("reports missing, reversed and extra edges once the nodes match", () => {
    expect(
      tutorialSkeletonProblems(namedSkeleton(TUTORIAL_SKELETON.nodes, [["torso", "head"]])),
    ).toEqual(["missing edge **torso → tailbase**"]);
    expect(
      tutorialSkeletonProblems(
        namedSkeleton(TUTORIAL_SKELETON.nodes, [["head", "torso"], ["torso", "tailbase"]]),
      ),
    ).toEqual(["edge **head → torso** should go from torso to head"]);
    expect(
      tutorialSkeletonProblems(
        namedSkeleton(TUTORIAL_SKELETON.nodes, [...TUTORIAL_SKELETON.edges, ["head", "tailbase"]]),
      ),
    ).toEqual(["extra edge **head → tailbase**"]);
  });

  it("names the same nodes the create-skeleton step tells the user to make", () => {
    for (const name of TUTORIAL_SKELETON.nodes) {
      expect(CREATE_SKELETON_STEP.body).toContain(`**${name}**`);
    }
  });
});

describe("training checklist", () => {
  it("asks for the four settings the first training run needs", () => {
    expect(TRAINING_CHECKS.map((c) => [c.label, c.expected])).toEqual([
      ["Post-training inference target", "Suggested frames"],
      ["Anchor part", "torso"],
      ["Centroid epochs", "5"],
      ["Centered instance epochs", "5"],
    ]);
    expect(RUN_TRAINING_STEP.checklist).toBe(TRAINING_CHECKS);
    for (const check of TRAINING_CHECKS) expect(check.meaning.length).toBeGreaterThan(0);
  });

  it("asks the retrain run for the same settings, with 50 epochs instead of 5", () => {
    expect(RETRAIN_STEP.checklist).toBe(RETRAIN_CHECKS);
    expect(RETRAIN_CHECKS.map((c) => [c.label, c.expected])).toEqual([
      ["Post-training inference target", "Suggested frames"],
      ["Anchor part", "torso"],
      ["Centroid epochs", "50"],
      ["Centered instance epochs", "50"],
    ]);
    expect(checklistFailures(RETRAIN_CHECKS, trainingReady({ epochs: 50 }))).toEqual([]);
    expect(checklistFailures(RETRAIN_CHECKS, trainingReady({ epochs: 5 }))).toEqual([
      "Centroid epochs is 5",
      "Centered instance epochs is 5",
    ]);
  });

  it("ticks everything when the settings match", () => {
    expect(evaluateChecklist(TRAINING_CHECKS, trainingReady()).every((r) => r.ok)).toBe(true);
    expect(checklistFailures(TRAINING_CHECKS, trainingReady())).toEqual([]);
  });

  it("shows what is set instead, e.g. after coming back once the retrain step raised epochs", () => {
    const rows = evaluateChecklist(
      TRAINING_CHECKS,
      trainingReady({ trainingMaxEpochs: 50, trainingCentroidMaxEpochs: 50 }),
    );
    expect(rows.filter((r) => !r.ok).map((r) => [r.label, r.current])).toEqual([
      ["Centroid epochs", "50"],
      ["Centered instance epochs", "50"],
    ]);
  });

  it("reads an Auto anchor as Auto, but nothing when there's no top-down config", () => {
    const auto = evaluateChecklist(TRAINING_CHECKS, trainingReady({ anchor: null }));
    expect(auto.find((r) => r.label === "Anchor part")?.current).toBe("Auto");
    const none = evaluateChecklist(TRAINING_CHECKS, watchState());
    expect(none.every((r) => r.current === null && !r.ok)).toBe(true);
  });
});

describe("where each step happens", () => {
  it("names a sidebar panel or a location for every step that asks the user to act", async () => {
    const { DEFAULT_PANEL_ORDER } = await import("@/lib/panelLayout");
    const panels: readonly string[] = DEFAULT_PANEL_ORDER;
    for (const desktop of [true, false]) {
      for (const step of buildTutorialSteps(desktop)) {
        if (step === WELCOME_STEP || step === BROWSER_NOTICE_STEP) {
          expect(step.panelId ?? step.location).toBeUndefined();
          continue;
        }
        expect(Boolean(step.panelId) !== Boolean(step.location)).toBe(true);
        if (step.panelId) expect(panels).toContain(step.panelId);
      }
    }
  });
});
