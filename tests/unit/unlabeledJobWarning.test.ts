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

import { Instance, LabeledFrame, Labels, Skeleton, Video } from "@talmolab/sleap-io.js";
import { confirmUnlabeledAsHidden, countUnlabeledNodes } from "@/lib/slpAccess";
import { useConfirmStore, type ConfirmRequest } from "@/stores/confirmStore";
import { useAppStore } from "@/stores/appStore";
import { useInferenceStore } from "@/stores/inferenceStore";
import { useTrainingStore } from "@/stores/trainingStore";

/** A one-frame project; `unlabeled` nodes of its instance are not labelled. */
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

describe("nodes not labelled, before a job", () => {
  it("counts them", () => {
    expect(countUnlabeledNodes(project(2))).toBe(2);
    expect(countUnlabeledNodes(project(0))).toBe(0);
    expect(countUnlabeledNodes(null)).toBe(0);
  });

  it("asks once with Continue and Cancel when there are some", async () => {
    const seen = answerNextConfirm(true);
    expect(await confirmUnlabeledAsHidden(project(2), "training")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("2 nodes marked as not labelled");
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
    useAppStore.getState().setLabels(project(1), "x.slp");
    const seen = answerNextConfirm(false);
    await useInferenceStore.getState().startInference({} as never);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("inference job");
    expect(useInferenceStore.getState().status).toBe("idle");
  });

  it("Cancel stops a training run before it starts", async () => {
    useAppStore.getState().setLabels(project(1), "x.slp");
    const before = useTrainingStore.getState().status;
    const seen = answerNextConfirm(false);
    await useTrainingStore.getState().startTraining();
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("training job");
    expect(useTrainingStore.getState().status).toBe(before);
  });
});
