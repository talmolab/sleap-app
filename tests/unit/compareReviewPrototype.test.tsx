/**
 * Compare Models review-window prototypes (dev only): the switch that turns
 * them on, what one disagreement looks like, the crop, the mock models used
 * to try them, the shared decisions, and that each window opens on a queue.
 */
import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Labels, Skeleton } from "@talmolab/sleap-io.js";
import {
  cropAround,
  itemRings,
  makeMockModels,
  readReviewSwitch,
  reviewGroupsOnFrame,
  REVIEW_SWITCH_KEY,
} from "@/lib/modelOverlay/reviewPrototype";
import { clearDisagreementIndexCache, disagreementIndexFor, fillIndex, disagreementFrames } from "@/lib/modelOverlay/disagreementIndex";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import { ReviewStepperPrototype } from "@/components/video/compareReview/ReviewStepperPrototype";
import { ReviewPanesPrototype } from "@/components/video/compareReview/ReviewPanesPrototype";
import { ReviewGridPrototype } from "@/components/video/compareReview/ReviewGridPrototype";
import { makePredictionLabels, makeVideo, NODES, poseAt } from "./modelOverlayTestData";

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

  // Accept, reject and "fine" are remembered per item; rejecting the accepted model un-accepts it.
  it("records accept, reject and skip", () => {
    const s = useCompareReviewStore.getState();
    s.accept("3:0", "a");
    s.toggleReject("3:0", "a");
    expect(useCompareReviewStore.getState().decisions["3:0"]).toEqual({ accepted: null, rejected: ["a"], skipped: false });
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

  // Prototype A walks the queue: one row per model, Reject marks it, "fine" moves on.
  it("A: stepper lists every model and records decisions", async () => {
    render(<ReviewStepperPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-model-row").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("review-proto-status").textContent).toContain("disagreement");
    fireEvent.click(screen.getByText(/Looks fine, next/));
    expect(screen.getByTestId("review-proto-summary").textContent).toContain("1 fine");
  });

  // Prototype B shows one pane per model on the item.
  it("B: side by side has a pane per model", async () => {
    render(<ReviewPanesPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-pane").length).toBeGreaterThanOrEqual(2));
  });

  // Prototype C shows a page of crops (at most 12).
  it("C: crop grid shows a page of crops", async () => {
    render(<ReviewGridPrototype onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("review-proto-cell").length).toBeGreaterThan(0));
    expect(screen.getAllByTestId("review-proto-cell").length).toBeLessThanOrEqual(12);
  });
});
