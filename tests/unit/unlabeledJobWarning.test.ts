/**
 * Training and inference jobs built from a project that holds nodes marked as
 * not labelled (an SLP format 3.0 file opened for editing) are written in the
 * 2.x layout, where those nodes read as hidden. The app says so once, with
 * Continue and Cancel, before building the job.
 *
 * The points of the stand-in instance are overridden so this runs against any
 * sleap-io.js (the pinned one has no `labeled` flag).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { Instance, LabeledFrame, Labels, PredictedInstance, Skeleton, Video } from "@talmolab/sleap-io.js";
import { confirmUnlabeledAsHidden, countUnlabeledNodes } from "@/lib/slpAccess";
import { useConfirmStore, type ConfirmRequest } from "@/stores/confirmStore";
import { useSlpFormatStore, type SlpFormatPrompt } from "@/stores/slpFormatStore";
import { useAppStore } from "@/stores/appStore";
import { useInferenceStore } from "@/stores/inferenceStore";
import { useTrainingStore } from "@/stores/trainingStore";

/** A one-frame project; `unlabeled` nodes of its instance are not labeled. */
function project(unlabeled: number): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b", "c"] });
  const video = new Video({ filename: "v.mp4" });
  const inst = new Instance({
    skeleton,
    points: [0, 1, 2].map((i) => ({ xy: [i, i] as [number, number], visible: true, complete: true })),
  });
  const points = [0, 1, 2].map((i) =>
    i < unlabeled
      ? { xy: [Number.NaN, Number.NaN] as [number, number], visible: false, complete: false, labeled: false }
      : { xy: [i, i] as [number, number], visible: true, complete: true },
  );
  Object.defineProperty(inst, "points", { get: () => points });
  return new Labels({
    labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })],
    videos: [video],
    skeletons: [skeleton],
  });
}

/** Answer the next confirm with `ok`; returns the requests seen. */
function answerNextConfirm(ok: boolean): ConfirmRequest[] {
  const seen: ConfirmRequest[] = [];
  const unsub = useConfirmStore.subscribe((s) => {
    if (!s.request) return;
    seen.push(s.request);
    unsub();
    queueMicrotask(() => useConfirmStore.getState().respond(ok));
  });
  return seen;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useConfirmStore.setState({ request: null });
});

describe("nodes not labeled, before a job", () => {
  it("counts them in user instances only (training uses no predictions)", () => {
    expect(countUnlabeledNodes(project(2))).toBe(2);
    expect(countUnlabeledNodes(project(0))).toBe(0);
    expect(countUnlabeledNodes(null)).toBe(0);
    const labels = project(0);
    const skeleton = labels.skeletons[0];
    const pred = new PredictedInstance({
      skeleton,
      points: [0, 1, 2].map((i) => ({ xy: [i, i] as [number, number], visible: true, complete: false, score: 1 })),
      score: 1,
    });
    const unlabeled = { xy: [Number.NaN, Number.NaN] as [number, number], visible: false, complete: false, labeled: false };
    Object.defineProperty(pred, "points", { get: () => [unlabeled, unlabeled, unlabeled] });
    labels.labeledFrames[0].instances.push(pred);
    expect(countUnlabeledNodes(labels)).toBe(0);
  });

  it("asks once with Continue and Cancel when there are some", async () => {
    const seen = answerNextConfirm(true);
    expect(await confirmUnlabeledAsHidden(project(2), "training")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("2 nodes marked as not labeled");
    expect(seen[0].message).toContain("trains on them as hidden nodes");
    expect(seen[0].confirmLabel).toBe("Continue");
    expect(seen[0].cancelLabel).toBe("Cancel");

    answerNextConfirm(false);
    expect(await confirmUnlabeledAsHidden(project(1), "inference")).toBe(false);
  });

  it("asks nothing when there are none", async () => {
    expect(await confirmUnlabeledAsHidden(project(0), "training")).toBe(true);
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("Cancel stops a local inference run before it starts", async () => {
    useAppStore.getState().setLabels(project(1), "x.slp", "/data/x.slp");
    const seen = answerNextConfirm(false);
    await useInferenceStore.getState().startInference({} as never);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("inference job");
    expect(useInferenceStore.getState().status).toBe("idle");
  });

  it("Cancel stops a training run before it starts", async () => {
    useAppStore.getState().setLabels(project(1), "x.slp", "/data/x.slp");
    const before = useTrainingStore.getState().status;
    const seen = answerNextConfirm(false);
    await useTrainingStore.getState().startTraining();
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("training job");
    expect(useTrainingStore.getState().status).toBe(before);
  });
});

/** The project `project(n)` opened View only from a format 3.0 file. */
function viewOnlyProject(unlabeled: number): Labels {
  const labels = project(unlabeled);
  (labels as unknown as { sourceFormat: unknown }).sourceFormat = {
    formatId: 3,
    access: "view",
    summary: {
      formatId: 3, unlabeledPoints: unlabeled, unlabeledUserPoints: unlabeled, unlabeledPredictedPoints: 0,
      metadataKeys: { instances: [], frames: [], bboxes: [] }, unknownColumns: [], lossless: unlabeled === 0,
    },
    labelsPath: "/data/x.slp",
  };
  return labels;
}

/** Answer the next SLP format prompt with Cancel; returns the prompts seen. */
function cancelNextFormatPrompt(): SlpFormatPrompt[] {
  const seen: SlpFormatPrompt[] = [];
  const unsub = useSlpFormatStore.subscribe((s) => {
    if (!s.prompt) return;
    seen.push(s.prompt);
    unsub();
    queueMicrotask(() => useSlpFormatStore.getState().respond(null));
  });
  return seen;
}

describe("a job on a project opened View only", () => {
  beforeEach(() => useSlpFormatStore.setState({ prompt: null }));

  it("inference asks to allow editing first (its predictions come back); Cancel stops it", async () => {
    useAppStore.getState().setLabels(viewOnlyProject(0), "x.slp", "/data/x.slp");
    const seen = cancelNextFormatPrompt();
    await useInferenceStore.getState().startInference({} as never);
    expect(seen).toEqual([expect.objectContaining({ kind: "allow-edit", action: "predictions" })]);
    expect(useInferenceStore.getState().status).toBe("idle");
  });

  it("remote inference asks too", async () => {
    useAppStore.getState().setLabels(viewOnlyProject(0), "x.slp", "/data/x.slp");
    const seen = cancelNextFormatPrompt();
    await useInferenceStore
      .getState()
      .startInference({} as never, { remote: true, dataPath: "/w/x.slp", workerId: "w" });
    expect(seen).toHaveLength(1);
    expect(useInferenceStore.getState().status).toBe("idle");
  });

  it("training asks to allow editing first; Cancel stops it", async () => {
    useAppStore.getState().setLabels(viewOnlyProject(1), "x.slp", "/data/x.slp");
    const before = useTrainingStore.getState().status;
    const seen = cancelNextFormatPrompt();
    await useTrainingStore.getState().startTraining();
    expect(seen).toEqual([expect.objectContaining({ kind: "allow-edit", action: "train" })]);
    expect(useConfirmStore.getState().request).toBeNull(); // never got to the hidden-nodes warning
    expect(useTrainingStore.getState().status).toBe(before);
  });
});

describe("loading finished job predictions into a project opened View only", () => {
  beforeEach(() => useSlpFormatStore.setState({ prompt: null }));

  it("Fetch & Load asks to allow editing first; Cancel keeps the pending merge and reports nothing as merged", async () => {
    useAppStore.getState().setLabels(viewOnlyProject(0), "x.slp", "/data/x.slp");
    const pendingMerge = { results: [{ jobId: "j1" }], mode: "replace", trackOnly: false };
    useTrainingStore.setState({
      postTrainingInference: { pendingMerge, merged: false, message: null } as never,
      log: [],
    });
    const seen = cancelNextFormatPrompt();
    await useTrainingStore.getState().fetchAndLoadPostTrainingPredictions();
    expect(seen).toEqual([expect.objectContaining({ kind: "allow-edit", action: "predictions" })]);
    const post = useTrainingStore.getState().postTrainingInference as unknown as {
      pendingMerge: unknown;
      merged: boolean;
      message: string | null;
    };
    expect(post.pendingMerge).toBe(pendingMerge);
    expect(post.merged).toBe(false);
    expect(post.message).toContain("View only");
    expect(useTrainingStore.getState().log.join("\n")).not.toContain("merged into project");
  });
});
