/**
 * Compare Models review-window prototypes (dev only): the switch that turns
 * them on, what one disagreement looks like, the crop, the mock models used
 * to try them, the shared decisions, and that each window opens on a queue.
 */
import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, renderHook, act, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Labels, LabeledFrame, Skeleton } from "@talmolab/sleap-io.js";
import {
  cropAround,
  itemRings,
  makeMockModels,
  projectPosesOnFrame,
  readReviewSwitch,
  reviewGroupsOnFrame,
  reviewItemKey,
  REVIEW_SWITCH_KEY,
} from "@/lib/modelOverlay/reviewPrototype";
import { clearDisagreementIndexCache, disagreementIndexFor, fillIndex, disagreementFrames } from "@/lib/modelOverlay/disagreementIndex";
import { DEFAULT_REVIEW_THRESHOLD_PX, isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import { ReviewStepperPrototype } from "@/components/video/compareReview/ReviewStepperPrototype";
import { ReviewPanesPrototype } from "@/components/video/compareReview/ReviewPanesPrototype";
import { ReviewGridPrototype } from "@/components/video/compareReview/ReviewGridPrototype";
import { makePred, makePredictionLabels, makeUser, makeVideo, NODES, poseAt } from "./modelOverlayTestData";
import { acceptForItem, keysBelongElsewhere, worstFrames } from "@/components/video/compareReview/useReviewQueue";
import { acceptModelPose } from "@/lib/modelOverlay/canvasActions";
import { useConfirmStore } from "@/stores/confirmStore";
import { PoseStore } from "@/lib/modelOverlay/poseStore";
import { clearFrameDecodeCache, decodeFrame, DECODE_ATTEMPTS } from "@/components/video/compareReview/frameDecodeCache";
import { parseReviewThreshold, ProjectInstancesKey, ReviewThresholdInput, useProjectPoses } from "@/components/video/compareReview/reviewParts";
import { rawFrameToRGBA } from "@/lib/videoExport";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function pose(xy: [number, number][], trackName: string | null = null): OverlayPose {
  return { xy: Float64Array.from(xy.flat()), score: 0.9, trackName };
}

function model(id: string, frames: Record<number, OverlayPose[]>, video = makeVideo()): OverlayModel {
  return {
    id,
    name: id,
    source: id,
    color: MODEL_COLORS[0],
    visible: true,
    video,
    frames: new Map(Object.entries(frames).map(([f, p]) => [Number(f), p])),
    trackNames: new Set(),
  };
}

describe("review prototype switch", () => {
  // The URL turns it on and is remembered, so the desktop window (no address bar) keeps it after a reload.
  it("turns on from the URL and remembers it", () => {
    const st = memStorage();
    expect(readReviewSwitch("?reviewUi=grid", st)).toEqual({ on: true, layout: "grid" });
    expect(st.getItem(REVIEW_SWITCH_KEY)).toBe("grid");
    expect(readReviewSwitch("", st)).toEqual({ on: true, layout: "grid" });
  });

  // Off by default, and ?reviewUi=off forgets it; an unknown value opens the stepper.
  it("is off by default and can be turned off", () => {
    const st = memStorage();
    expect(readReviewSwitch("", st).on).toBe(false);
    expect(readReviewSwitch("?reviewUi=1", st)).toEqual({ on: true, layout: "stepper" });
    expect(readReviewSwitch("?reviewUi=off", st).on).toBe(false);
    expect(readReviewSwitch("", st).on).toBe(false);
  });
});

describe("reviewGroupsOnFrame", () => {
  // One item per animal the models disagree on, with the disputed nodes and each model's distance.
  it("lists disputed nodes and how far each model is", () => {
    const same = poseAt(100, 100);
    const off: [number, number][] = same.map((p, i) => (i === 0 ? [p[0] + 40, p[1]] : p));
    const models = [model("a", { 0: [pose(same)] }), model("b", { 0: [pose(same)] }), model("c", { 0: [pose(off)] })];
    const [g] = reviewGroupsOnFrame(models, 0, false, 10);
    expect(g.flagged).toEqual([0]);
    expect(g.members.map((m) => m.modelId).sort()).toEqual(["a", "b", "c"]);
    const c = g.members.find((m) => m.modelId === "c")!;
    const a = g.members.find((m) => m.modelId === "a")!;
    expect(c.distance).toBeGreaterThan(a.distance);
    expect(itemRings(g)).toHaveLength(1);
    expect(reviewGroupsOnFrame(models, 0, false, 50)).toEqual([]);
  });

  // A frame only one model has can't be a disagreement.
  it("needs two models on the frame", () => {
    expect(reviewGroupsOnFrame([model("a", { 0: [pose(poseAt(1, 1))] }), model("b", {})], 0, false, 0)).toEqual([]);
  });
});

describe("cropAround", () => {
  // The crop surrounds the animal with padding and never leaves the frame.
  it("pads and stays inside the frame", () => {
    const r = cropAround([Float64Array.from([5, 5, 25, 25])], 640, 480, 0.5, 50)!;
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBeGreaterThanOrEqual(50);
    expect(cropAround([Float64Array.from([NaN, NaN])], 640, 480)).toBeNull();
  });
});

describe("makeMockModels", () => {
  beforeEach(() => clearDisagreementIndexCache());

  // With nothing labeled, five mock models still give something to review.
  it("makes five models with disagreements on an empty project", () => {
    const video = makeVideo("/data/v.mp4", [500, 480, 640, 1]);
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    const mocks = makeMockModels(labels, video, skeleton);
    expect(mocks).toHaveLength(5);
    expect(mocks[0].frames.size).toBe(500);
    useModelOverlayStore.getState().addModels(labels, mocks);
    const index = disagreementIndexFor(useModelOverlayStore.getState().models, video);
    fillIndex(index, Infinity);
    expect(disagreementFrames(index, 10).length).toBeGreaterThan(0);
    useModelOverlayStore.getState().clear();
  });

  // Where the project has instances, the mocks follow them (so crops show the real animals).
  it("copies the project's instances when there are some", () => {
    const labels = makePredictionLabels({ frames: { 7: [{ xy: poseAt(200, 300) }] } });
    const mocks = makeMockModels(labels, labels.videos[0], labels.skeletons[0]);
    expect([...mocks[0].frames.keys()]).toEqual([7]);
    const xy = mocks[0].frames.get(7)![0].xy;
    expect(Math.abs(xy[2] - 200)).toBeLessThan(2);
  });
});

describe("review decisions", () => {
  beforeEach(() => useCompareReviewStore.getState().clearAll());

  // One decision per item — use a model, skip, or label by hand — the latest one wins.
  it("records use, skip and label-by-hand", () => {
    const s = useCompareReviewStore.getState();
    s.use("3:0", "a");
    expect(useCompareReviewStore.getState().decisions["3:0"]).toEqual({ used: "a", skipped: false, byHand: false });
    s.markByHand("3:0");
    expect(useCompareReviewStore.getState().decisions["3:0"]).toEqual({ used: null, skipped: false, byHand: true });
    s.skip("4:0");
    expect(isReviewed(useCompareReviewStore.getState().decisions["4:0"])).toBe(true);
    s.reset("4:0");
    expect(isReviewed(useCompareReviewStore.getState().decisions["4:0"])).toBe(false);
  });
});

describe("review prototype windows", () => {
  function loadMocks() {
    const video = makeVideo("/data/v.mp4", [300, 480, 640, 1]);
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    useAppStore.setState({ labels, video, skeleton, frameIdx: 0 });
    useModelOverlayStore.getState().addModels(labels, makeMockModels(labels, video, skeleton));
  }
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useModelOverlayStore.getState().clear();
    useCompareReviewStore.getState().clearAll();
    clearDisagreementIndexCache();
    loadMocks();
  });
  afterEach(() => {
    cleanup();
    useModelOverlayStore.getState().clear();
  });

  // Prototype A walks the queue: one row per model, Skip moves on and is counted.
  it("A: stepper lists every model and records decisions", async () => {
    render(<ReviewStepperPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-model-row").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("review-proto-status").textContent).toContain("disagreement");
    fireEvent.click(screen.getByText("Skip"));
    expect(screen.getByTestId("review-proto-summary").textContent).toContain("1 skipped");
  });

  // Prototype B shows one pane per model, each with a single "Use this one" and no per-model "wrong".
  it("B: side by side has a pane per model with Use this one", async () => {
    render(<ReviewPanesPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-pane").length).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByTestId("review-proto-use")).toHaveLength(screen.getAllByTestId("review-proto-pane").length);
    expect(screen.queryByTitle("Mark this model wrong here")).toBeNull();
    expect(screen.getByTestId("review-proto-summary").textContent).not.toContain("rejected");
  });

  // User direction: the review starts with the worst disagreement and steps worst first.
  it("B: goes worst first and Skip moves to the next worse one", async () => {
    useCompareReviewStore.getState().setThreshold(10);
    render(<ReviewPanesPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-pane").length).toBeGreaterThanOrEqual(2));
    const spreadOf = () => Number(/(\d+) px\)/.exec(screen.getByText(/Disputed:/).textContent ?? "")?.[1]);
    const first = spreadOf();
    fireEvent.click(screen.getByTestId("review-proto-skip"));
    expect(spreadOf()).toBeLessThanOrEqual(first);
    useCompareReviewStore.getState().setThreshold(DEFAULT_REVIEW_THRESHOLD_PX);
  });

  // User direction: "None are right" sends the frame to the main view to label by hand and closes the review.
  it("B: None are right goes to the frame and closes the review", async () => {
    useCompareReviewStore.getState().setOpen("panes");
    render(<ReviewPanesPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-pane").length).toBeGreaterThanOrEqual(2));
    const frame = Number(/frame (\d+)/.exec(screen.getByText(/· frame /).textContent ?? "")?.[1]);
    fireEvent.click(screen.getByTestId("review-proto-none-right"));
    expect(useAppStore.getState().frameIdx).toBe(frame);
    expect(useCompareReviewStore.getState().open).toBeNull();
    expect(Object.values(useCompareReviewStore.getState().decisions).some((d) => d.byHand)).toBe(true);
  });

  // Prototype C shows a page of crops (at most 12).
  it("C: crop grid shows a page of crops", async () => {
    render(<ReviewGridPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-cell").length).toBeGreaterThan(0));
    expect(screen.getAllByTestId("review-proto-cell").length).toBeLessThanOrEqual(12);
  });
});

describe("review fixes", () => {
  let labels: Labels;
  let lf: LabeledFrame;
  let skeleton: Skeleton;
  const same = poseAt(100, 100);
  const off: [number, number][] = same.map((p, i) => (i === 0 ? [p[0] + 40, p[1]] : p));

  /** A project frame with a user instance on the animal, and two models that disagree on it. */
  function setup(source: (name: string) => string) {
    useAppStore.setState(useAppStore.getInitialState());
    useModelOverlayStore.getState().clear();
    useCompareReviewStore.getState().clearAll();
    useConfirmStore.setState({ request: null });
    skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const video = makeVideo();
    lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makeUser(skeleton, poseAt(100, 100)));
    labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setFrameIdx(0);
    useModelOverlayStore.getState().addModels(labels, [
      { name: "a", source: source("a"), video, frames: new Map([[0, [pose(same)]]]) },
      { name: "b", source: source("b"), video, frames: new Map([[0, [pose(off)]]]) },
    ]);
    const models = useModelOverlayStore.getState().models;
    return { models, item: reviewGroupsOnFrame(models, 0, false, 10)[0] };
  }
  afterEach(() => {
    cleanup();
    useConfirmStore.setState({ request: null });
    useModelOverlayStore.getState().clear();
  });

  // Review #1: cancelling "Replace your instance?" must not count the item as accepted.
  it("records an accept only when the project changed", async () => {
    const { models, item } = setup((n) => `/${n}.slp`);
    const user = lf.instances[0];
    let done = acceptForItem(item, models[1].id);
    await Promise.resolve();
    await Promise.resolve();
    expect(useConfirmStore.getState().request).not.toBeNull();
    useConfirmStore.getState().respond(false);
    expect(await done).toBe(false);
    expect(lf.instances[0]).toBe(user);
    expect(useCompareReviewStore.getState().decisions[reviewItemKey(item)]).toBeUndefined();

    done = acceptForItem(item, models[1].id);
    await Promise.resolve();
    await Promise.resolve();
    useConfirmStore.getState().respond(true);
    expect(await done).toBe(true);
    expect(lf.instances[0]).not.toBe(user);
    expect(useCompareReviewStore.getState().decisions[reviewItemKey(item)]?.used).toBe(models[1].id);
  });

  // Review #2: a mock model (noisy copy of the user's labels) must never overwrite the project.
  it("never writes a mock model's pose to the project", async () => {
    const { models, item } = setup((n) => `mock://${n}`);
    const before = [...lf.instances];
    expect(await acceptModelPose(models[1].id, 0)).toBe(false);
    expect(await acceptForItem(item, models[1].id)).toBe(true);
    expect(lf.instances).toEqual(before);
    expect(useConfirmStore.getState().request).toBeNull();
    expect(useCompareReviewStore.getState().decisions[reviewItemKey(item)]?.used).toBe(models[1].id);
  });

  // Review #3: while "Replace your instance?" is open, the prototypes' Esc/←/→ must leave it alone.
  it("leaves keys to an open dialog or a text field", async () => {
    setup((n) => `mock://${n}`);
    const key = (target: EventTarget | null = null) => {
      const e = new KeyboardEvent("keydown", { key: "Escape" });
      Object.defineProperty(e, "target", { value: target });
      return e;
    };
    expect(keysBelongElsewhere(key())).toBe(false);
    expect(keysBelongElsewhere(key(document.createElement("input")))).toBe(true);
    useConfirmStore.setState({ request: { title: "Replace your instance?", message: "" } as never });
    expect(keysBelongElsewhere(key())).toBe(true);
    let closed = false;
    render(<ReviewPanesPrototype onClose={() => (closed = true)} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(false);
  });

  // Review #4: a decision is tied to the exact model poses, and loading other models forgets it.
  it("keys decisions by the poses and clears them when the models change", () => {
    const { models, item } = setup((n) => `/${n}.slp`);
    useCompareReviewStore.getState().skip(reviewItemKey(item));
    // Hiding a model: same models loaded, so decisions stay (the item itself changes key).
    useModelOverlayStore.getState().setVisible(models[0].id, false);
    expect(Object.keys(useCompareReviewStore.getState().decisions)).toHaveLength(1);
    expect(reviewItemKey({ ...item, members: item.members.slice(1) })).not.toBe(reviewItemKey(item));
    // Removing a model (or loading others / another project): decisions are forgotten.
    useModelOverlayStore.getState().removeModel(models[0].id);
    expect(useCompareReviewStore.getState().decisions).toEqual({});
  });

  // Review #5: with more disagreement frames than the cap, the worst ones are kept, wherever they are.
  it("keeps the worst frames across the whole video", () => {
    const spread: Record<number, number> = { 1: 5, 2: 50, 3: 6, 900: 40 };
    expect(worstFrames([1, 2, 3, 900], (f) => spread[f], 2)).toEqual([2, 900]);
    expect(worstFrames([1, 2], (f) => spread[f], 5)).toEqual([1, 2]);
  });

  // Review #7: filling the index must not push the frame on screen out of the store's small cache.
  it("fills the index without evicting the frame on screen", () => {
    const frames = new Map<number, OverlayPose[]>();
    for (let f = 0; f < 40; f++) frames.set(f, [pose(poseAt(100 + f, 100))]);
    const video = makeVideo();
    const a = { ...model("a", {}, video), frames: PoseStore.from(frames) };
    const b = { ...model("b", {}, video), frames: PoseStore.from(frames) };
    const onScreen = a.frames.get(0);
    clearDisagreementIndexCache();
    fillIndex(disagreementIndexFor([a, b], video), Infinity);
    expect(a.frames.get(0)).toBe(onScreen!);
  });
});

describe("hand-test fixes (real grayscale video, project instances)", () => {
  afterEach(() => {
    cleanup();
    clearFrameDecodeCache();
  });

  const fakeVideo = () => makeVideo("/data/gray.mp4", [10, 4, 4, 1]) as unknown as Parameters<typeof decodeFrame>[0];
  const noSleep = () => Promise.resolve();

  // Hand-test #525: a read that failed once (e.g. during the main canvas's seek) left the pane black for good.
  it("retries a failed frame read and never caches the failure", async () => {
    const video = fakeVideo();
    let reads = 0;
    const canvas = { width: 4, height: 4 } as unknown as OffscreenCanvas;
    const deps = {
      read: async () => {
        reads++;
        if (reads === 1) throw new Error("busy");
        return { data: new Uint8ClampedArray(16), width: 4, height: 4, channels: 1 };
      },
      toDrawable: async () => canvas,
      sleep: noSleep,
    };
    expect(await decodeFrame(video, 3, deps)).toBe(canvas);
    expect(reads).toBe(2);
    // Cached once it worked: no new read.
    expect(await decodeFrame(video, 3, deps)).toBe(canvas);
    expect(reads).toBe(2);

    // A frame that keeps failing gives null, and the next request tries again.
    let fails = 0;
    const bad = { read: async () => { fails++; throw new Error("no"); }, toDrawable: async () => canvas, sleep: noSleep };
    const warn = console.warn;
    console.warn = () => {};
    expect(await decodeFrame(video, 4, bad)).toBeNull();
    expect(fails).toBe(DECODE_ATTEMPTS);
    await decodeFrame(video, 4, bad);
    console.warn = warn;
    expect(fails).toBe(2 * DECODE_ATTEMPTS);
  });

  // Hand-test #525: the worker decoder returns grayscale frames as {data, width, height, channels: 1}.
  it("expands a 1-channel raw frame to grey RGBA", () => {
    const raw = { data: new Uint8ClampedArray([10, 20, 30, 40]), width: 2, height: 2, channels: 1 };
    const out = rawFrameToRGBA(raw)!;
    expect([out.width, out.height]).toEqual([2, 2]);
    expect([...out.rgba.slice(0, 8)]).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
  });

  // Hand-test #525: the panes must show the project's own instances, yours solid and predictions dashed.
  it("lists the project's instances on the frame in skeleton order", () => {
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const video = makeVideo();
    const lf = new LabeledFrame({ video, frameIdx: 5 });
    lf.instances.push(makeUser(skeleton, poseAt(10, 20)));
    lf.instances.push(makePred(skeleton, poseAt(30, 40)));
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    const poses = projectPosesOnFrame(labels, video, 5, ["thorax", "head", "abdomen"]);
    expect(poses.map((p) => p.predicted)).toEqual([false, true]);
    expect([...poses[0].xy.slice(0, 2)]).toEqual([10, 20]); // thorax first
    expect(projectPosesOnFrame(labels, video, 6, NODES)).toEqual([]);
  });

  // Hand-test #525: with "Show project instances (H)" off the crops leave them out, and say so loudly.
  it("follows the H toggle and shows when instances are hidden", () => {
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const video = makeVideo();
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makeUser(skeleton, poseAt(10, 20)));
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    useAppStore.setState({ ...useAppStore.getInitialState(), labels, video, skeleton, showInstances: true });
    const shown = renderHook(() => useProjectPoses(0));
    expect(shown.result.current).toHaveLength(1);
    act(() => useAppStore.setState({ showInstances: false }));
    expect(shown.result.current).toBeUndefined();
    render(<ProjectInstancesKey count={null} />);
    fireEvent.click(screen.getByTestId("review-proto-project-hidden"));
    expect(useAppStore.getState().showInstances).toBe(true);
    expect(screen.getByTestId("review-proto-project-key")).toBeTruthy();
  });
});

describe("frame reads one at a time", () => {
  afterEach(() => clearFrameDecodeCache());

  // Hand-test #525: a page of crops reading at once made the worker decoder drop some reads.
  it("never runs two reads at the same time", async () => {
    const video = makeVideo("/data/q.mp4", [10, 4, 4, 1]) as unknown as Parameters<typeof decodeFrame>[0];
    let running = 0;
    let maxRunning = 0;
    const canvas = { width: 4, height: 4 } as unknown as OffscreenCanvas;
    const deps = {
      read: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return {};
      },
      toDrawable: async () => canvas,
      sleep: () => Promise.resolve(),
    };
    await Promise.all([0, 1, 2, 3, 4].map((f) => decodeFrame(video, f, deps)));
    expect(maxRunning).toBe(1);
  });
});

describe("review threshold box", () => {
  beforeEach(() => useCompareReviewStore.getState().setThreshold(DEFAULT_REVIEW_THRESHOLD_PX));
  afterEach(() => {
    cleanup();
    useCompareReviewStore.getState().setThreshold(DEFAULT_REVIEW_THRESHOLD_PX);
  });

  // Hand-test #525: the box snapped back when cleared, so 0 (or a new number) couldn't be typed.
  it("can be cleared and retyped, including 0, and reverts on blur when empty", () => {
    render(<ReviewThresholdInput />);
    const box = screen.getByTestId("review-proto-threshold") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "" } });
    expect(box.value).toBe("");
    expect(useCompareReviewStore.getState().threshold).toBe(DEFAULT_REVIEW_THRESHOLD_PX);
    fireEvent.change(box, { target: { value: "0" } });
    expect(useCompareReviewStore.getState().threshold).toBe(0);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.change(box, { target: { value: "10" } });
    expect(useCompareReviewStore.getState().threshold).toBe(10);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    expect(box.value).toBe("10");
    expect(parseReviewThreshold("-3")).toBeNull();
    expect(parseReviewThreshold("abc")).toBeNull();
  });
});
