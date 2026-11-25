/**
 * Compare Models "Review disagreements" window: what one disagreement looks
 * like, the crop, the test models, the decisions, opening it from the corner
 * panel, jumping, and the fixes from review and hand-testing.
 */
import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, renderHook, act, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Labels, LabeledFrame, Skeleton } from "@talmolab/sleap-io.js";
import {
  cropAround,
  disputedNodeMarks,
  itemRings,
  projectPosesOnFrame,
  reviewGroupsOnFrame,
  reviewItemKey,
} from "@/lib/modelOverlay/review";
import { makeMockModels } from "./compareReviewTestData";
import { clearDisagreementIndexCache, disagreementIndexFor, fillIndex, disagreementFrames } from "@/lib/modelOverlay/disagreementIndex";
import { DEFAULT_REVIEW_THRESHOLD_PX, isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import { CompareReviewWindow, ReviewWindow } from "@/components/video/compareReview/CompareReviewWindow";
import { ModelOverlayLegend } from "@/components/video/ModelOverlayLegend";
import { makePred, makePredictionLabels, makeUser, makeVideo, NODES, poseAt } from "./modelOverlayTestData";
import { acceptForItem, keysBelongElsewhere, worstFrames } from "@/components/video/compareReview/useReviewQueue";
import { useConfirmStore } from "@/stores/confirmStore";
import { PoseStore } from "@/lib/modelOverlay/poseStore";
import { clearFrameDecodeCache, decodeFrame, DECODE_ATTEMPTS } from "@/components/video/compareReview/frameDecodeCache";
import {
  JumpNumber,
  nearestItemToFrame,
  parseJumpNumber,
  parseReviewThreshold,
  ProjectInstancesKey,
  ReviewThresholdInput,
  useProjectPoses,
} from "@/components/video/compareReview/reviewParts";
import { rawFrameToRGBA } from "@/lib/videoExport";

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

  // One decision per item — accept a model ("Use this one"), skip, or label by hand — the latest one wins.
  it("records accept, skip and label-by-hand", () => {
    const s = useCompareReviewStore.getState();
    s.accept("3:0", "a");
    expect(useCompareReviewStore.getState().decisions["3:0"]).toEqual({ accepted: "a", skipped: false, byHand: false });
    s.markByHand("3:0");
    expect(useCompareReviewStore.getState().decisions["3:0"]).toEqual({ accepted: null, skipped: false, byHand: true });
    s.skip("4:0");
    expect(isReviewed(useCompareReviewStore.getState().decisions["4:0"])).toBe(true);
    s.reset("4:0");
    expect(isReviewed(useCompareReviewStore.getState().decisions["4:0"])).toBe(false);
  });
});

describe("review window", () => {
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

  // One pane per model, each with a single "Use this one" and no per-model "wrong".
  it("has a pane per model with Use this one", async () => {
    render(<ReviewWindow onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-pane").length).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByTestId("review-use")).toHaveLength(screen.getAllByTestId("review-pane").length);
    expect(screen.queryByTitle("Mark this model wrong here")).toBeNull();
    expect(screen.getByTestId("review-summary").textContent).not.toContain("rejected");
    // Hand-test: "used" was unclear; the footer says "accepted".
    expect(screen.getByTestId("review-summary").textContent).toContain("0 accepted");
  });

  // User direction: the review starts with the worst disagreement and steps worst first.
  it("goes worst first and Skip moves to the next worse one", async () => {
    useCompareReviewStore.getState().setThreshold(10);
    render(<ReviewWindow onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-pane").length).toBeGreaterThanOrEqual(2));
    const spreadOf = () => Number(/(\d+) px\)/.exec(screen.getByTestId("review-disputed").textContent ?? "")?.[1]);
    const first = spreadOf();
    fireEvent.click(screen.getByTestId("review-skip"));
    expect(spreadOf()).toBeLessThanOrEqual(first);
    useCompareReviewStore.getState().setThreshold(DEFAULT_REVIEW_THRESHOLD_PX);
  });

  // User direction: "None are right" sends the frame to the main view to label by hand and closes the review.
  it("None are right goes to the frame and closes the review", async () => {
    useCompareReviewStore.getState().setOpen(true);
    render(<ReviewWindow onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-pane").length).toBeGreaterThanOrEqual(2));
    const frame = Number(/frame (\d+)/.exec(screen.getByText(/· frame /).textContent ?? "")?.[1]);
    fireEvent.click(screen.getByTestId("review-none-right"));
    expect(useAppStore.getState().frameIdx).toBe(frame);
    expect(useCompareReviewStore.getState().open).toBe(false);
    expect(Object.values(useCompareReviewStore.getState().decisions).some((d) => d.byHand)).toBe(true);
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
    expect(useCompareReviewStore.getState().decisions[reviewItemKey(item)]?.accepted).toBe(models[1].id);
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
    render(<ReviewWindow onClose={() => (closed = true)} />);
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

  // Hand-test #538: the cards open without the project's instances (the window's own eye, not H); the eye turns them on.
  it("opens with project instances off, separate from H", () => {
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const video = makeVideo();
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makeUser(skeleton, poseAt(10, 20)));
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    useAppStore.setState({ ...useAppStore.getInitialState(), labels, video, skeleton, showInstances: true });
    useCompareReviewStore.getState().setShowProjectInstances(true);
    useCompareReviewStore.getState().setOpen(true);
    expect(useCompareReviewStore.getState().showProjectInstances).toBe(false);
    // The poses are still found (for the "N here" count); the toggle decides whether they're drawn.
    expect(renderHook(() => useProjectPoses(0)).result.current).toHaveLength(1);
    render(<ProjectInstancesKey count={1} />);
    expect(screen.getByTestId("review-project-key").textContent).toContain("hidden");
    fireEvent.click(screen.getByTestId("review-project-toggle"));
    expect(useCompareReviewStore.getState().showProjectInstances).toBe(true);
    expect(useAppStore.getState().showInstances).toBe(true);
    expect(screen.getByTestId("review-project-key").textContent).not.toContain("hidden");
    useCompareReviewStore.getState().setOpen(false);
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
    const box = screen.getByTestId("review-threshold") as HTMLInputElement;
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

describe("review window: opening and jumping", () => {
  function loadMocks() {
    const video = makeVideo("/data/v.mp4", [300, 480, 640, 1]);
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    useAppStore.setState({ ...useAppStore.getInitialState(), labels, video, skeleton, frameIdx: 0 });
    useModelOverlayStore.getState().addModels(labels, makeMockModels(labels, video, skeleton));
  }
  beforeEach(() => {
    useModelOverlayStore.getState().clear();
    useCompareReviewStore.getState().clearAll();
    useCompareReviewStore.getState().setOpen(false);
    clearDisagreementIndexCache();
    loadMocks();
  });
  afterEach(() => {
    cleanup();
    useCompareReviewStore.getState().setOpen(false);
    useModelOverlayStore.getState().clear();
  });

  // The chosen layout ships: "Review" in the corner panel opens the window.
  it("opens from the corner panel's Review button", async () => {
    render(
      <>
        <ModelOverlayLegend disagreementCount={0} />
        <CompareReviewWindow />
      </>
    );
    expect(screen.queryByTestId("review-window")).toBeNull();
    fireEvent.click(screen.getByTestId("model-overlay-review"));
    expect(await screen.findByTestId("review-window")).toBeTruthy();
  });

  // Hand-test: the "i / N" counter jumps to a typed item; bad input puts the old number back.
  it("jumps to a typed item number", async () => {
    useCompareReviewStore.getState().setThreshold(10);
    render(<ReviewWindow onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-pane").length).toBeGreaterThanOrEqual(2));
    const total = Number(/\/ (\d+)/.exec(screen.getByTestId("review-position").textContent ?? "")?.[1]);
    expect(total).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByTestId("review-jump-item"));
    const box = screen.getByTestId("review-jump-item-input") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "" } });
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("review-jump-item").textContent).toBe("3");
    // Out of range: back to 3. Esc: back to 3.
    fireEvent.click(screen.getByTestId("review-jump-item"));
    fireEvent.change(screen.getByTestId("review-jump-item-input"), { target: { value: String(total + 5) } });
    fireEvent.blur(screen.getByTestId("review-jump-item-input"));
    expect(screen.getByTestId("review-jump-item").textContent).toBe("3");
    fireEvent.click(screen.getByTestId("review-jump-item"));
    fireEvent.change(screen.getByTestId("review-jump-item-input"), { target: { value: "1" } });
    fireEvent.keyDown(screen.getByTestId("review-jump-item-input"), { key: "Escape" });
    expect(screen.getByTestId("review-jump-item").textContent).toBe("3");
    useCompareReviewStore.getState().setThreshold(DEFAULT_REVIEW_THRESHOLD_PX);
  });

  // Typing a frame goes to the item nearest it.
  it("finds the item nearest a frame and only accepts whole numbers in range", () => {
    const items = [{ frame: 40 }, { frame: 10 }, { frame: 25 }];
    expect(nearestItemToFrame(items, 12)).toBe(1);
    expect(nearestItemToFrame(items, 33)).toBe(0);
    expect(nearestItemToFrame(items, 30)).toBe(2);
    expect(nearestItemToFrame([], 5)).toBe(-1);
    expect(parseJumpNumber("2", 1, 3)).toBe(2);
    expect(parseJumpNumber("", 1, 3)).toBeNull();
    expect(parseJumpNumber("4", 1, 3)).toBeNull();
    expect(parseJumpNumber("1.5", 1, 3)).toBeNull();
  });

  // The jump box keeps what is typed (never snaps mid-typing) and commits on Enter.
  it("keeps the typed text until it is committed", () => {
    let got = -1;
    render(<JumpNumber value={4} min={1} max={9} onCommit={(n) => (got = n)} label="item" testId="j" />);
    fireEvent.click(screen.getByTestId("j"));
    const box = screen.getByTestId("j-input") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.change(box, { target: { value: "7" } });
    expect(got).toBe(-1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(got).toBe(7);
  });
});

describe("review window: which node is which", () => {
  const same = poseAt(100, 100);
  // Head and abdomen both off in model c: two nodes disagree on one animal.
  const off: [number, number][] = same.map((p, i) => (i === 1 ? p : [p[0] + 25, p[1]]));

  // User question: several disputed nodes on one animal are one item, each named on the panes.
  it("puts every disputed node of an animal on one item, each with its name", () => {
    const models = [model("a", { 0: [pose(same)] }), model("b", { 0: [pose(same)] }), model("c", { 0: [pose(off)] })];
    const items = reviewGroupsOnFrame(models, 0, false, 10);
    expect(items).toHaveLength(1);
    expect([...items[0].flagged].sort()).toEqual([0, 2]);
    const names = disputedNodeMarks(items[0], NODES).map((m) => m.label).sort();
    expect(names).toEqual(["abdomen", "head"]);
    // In model c's own pane the tags sit on c's points, not on the average.
    const c = items[0].members.find((m) => m.modelId === "c")!;
    const headTag = disputedNodeMarks(items[0], NODES, c.xy).find((m) => m.label === "head")!;
    expect(headTag.x).toBe(off[0][0]);
  });

  // User feedback: "N disagreements above N px, worst first" repeated the header, so it's gone once listed.
  it("drops the status line once the queue is listed", async () => {
    const video = makeVideo("/data/v.mp4", [300, 480, 640, 1]);
    const skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    useAppStore.setState({ ...useAppStore.getInitialState(), labels, video, skeleton, frameIdx: 0 });
    useModelOverlayStore.getState().clear();
    clearDisagreementIndexCache();
    useModelOverlayStore.getState().addModels(labels, makeMockModels(labels, video, skeleton));
    render(<ReviewWindow onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-pane").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId("review-status")).toBeNull();
    cleanup();
    useModelOverlayStore.getState().clear();
  });
});

describe("review window card layout (hand-test 2026-11-24)", () => {
  // Hand-test #538: cards always have a 4-per-row slot's size (2 cards don't grow); a 5th wraps.
  it("keeps every card the size of a 4-per-row slot and wraps the 5th", async () => {
    const { cardLayout } = await import("@/components/video/compareReview/CompareReviewWindow");
    const two = cardLayout(2, 1200, 800);
    const four = cardLayout(4, 1200, 800);
    const five = cardLayout(5, 1200, 800);
    expect([two.cols, two.rows]).toEqual([2, 1]);
    expect([four.cols, four.rows]).toEqual([4, 1]);
    expect([five.cols, five.rows]).toEqual([4, 2]);
    expect(two.cardWidth).toBe(four.cardWidth);
    expect(two.cardHeight).toBe(four.cardHeight);
    expect(four.cardWidth).toBe(Math.floor((1200 - 24) / 4) - 10);
    // Two rows still fit the height with their buttons.
    expect(2 * (five.cardHeight + 110) + 8).toBeLessThanOrEqual(800);
});
});

describe("Hide model predictions (M)", () => {
  afterEach(() => {
    cleanup();
    useModelOverlayStore.getState().clear();
  });

  // Hand-test: the models could not be hidden to look at the project's own instances; M (remappable) does it.
  it("is bound to M, listed in the Shortcuts dialog, and hides the models on the canvas only", async () => {
    const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
    const { SHORTCUT_CATEGORIES } = await import("@/lib/shortcutEditing");
    const { useModelOverlayFrame } = await import("@/hooks/useModelOverlayFrame");
    const { toggleModelPredictions } = await import("@/lib/modelOverlay/canvasActions");
    expect(DEFAULT_SHORTCUTS["show model predictions"]).toBe("KeyM");
    expect(Object.values(DEFAULT_SHORTCUTS).filter((k) => k === "KeyM")).toHaveLength(1);
    expect(SHORTCUT_CATEGORIES.View).toContain("show model predictions");

    const video = makeVideo();
    const labels = new Labels({ videos: [video] });
    useAppStore.setState({ ...useAppStore.getInitialState(), labels, video, frameIdx: 0 });
    useModelOverlayStore.getState().addModels(labels, [
      { name: "a", source: "/a.slp", video, frames: new Map([[0, [pose(poseAt(10, 10))]]]) },
    ]);
    const frame = renderHook(() => useModelOverlayFrame());
    expect(frame.result.current.layers).toHaveLength(1);
    render(<ModelOverlayLegend disagreementCount={0} />);
    expect(screen.getByTestId("model-overlay-hide-models").textContent).toBe("Hide model predictions (M)");
    act(() => toggleModelPredictions());
    expect(frame.result.current.layers).toHaveLength(0);
    expect(screen.getByTestId("model-overlay-hide-models").textContent).toBe("Show model predictions (M)");
    // The models stay loaded (the Review window still shows them).
    expect(useModelOverlayStore.getState().models).toHaveLength(1);
  });
});

describe("Label QC Review hides the models", () => {
  afterEach(async () => {
    const { useQcStore } = await import("@/stores/qcStore");
    useQcStore.setState({ reviewOpen: false });
    useModelOverlayStore.getState().clear();
  });

  // Hand-test #538: QC Review is about your labels; the models start hidden there, M still shows them, and leaving restores M.
  it("hides models while QC Review is open and restores the user's choice after", async () => {
    const { useQcStore } = await import("@/stores/qcStore");
    const { toggleModelPredictions } = await import("@/lib/modelOverlay/canvasActions");
    const video = makeVideo();
    const labels = new Labels({ videos: [video] });
    useAppStore.setState({ ...useAppStore.getInitialState(), labels, video, frameIdx: 0 });
    useModelOverlayStore.getState().addModels(labels, [
      { name: "a", source: "/a.slp", video, frames: new Map([[0, [pose(poseAt(10, 10))]]]) },
    ]);
    const hidden = () => useModelOverlayStore.getState().hideModels;
    expect(hidden()).toBe(false);
    useQcStore.setState({ reviewOpen: true });
    expect(hidden()).toBe(true);
    toggleModelPredictions(); // M during Review shows them
    expect(hidden()).toBe(false);
    useQcStore.setState({ reviewOpen: false });
    expect(hidden()).toBe(false); // back to what it was before Review

    // Hidden before Review: still hidden after.
    toggleModelPredictions();
    useQcStore.setState({ reviewOpen: true });
    toggleModelPredictions();
    useQcStore.setState({ reviewOpen: false });
    expect(hidden()).toBe(true);
  });
});
