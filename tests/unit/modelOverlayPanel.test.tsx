/**
 * The Compare Model Predictions corner panel after hand-testing: title and
 * summary counts, folding it into a pill, the "Hide project instances (H)"
 * button, and models drawn in the app's predicted-instance style.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach } from "../bun-test";
import { render, renderHook, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Labels } from "@talmolab/sleap-io.js";
import { ModelOverlayLegend, summaryLine } from "@/components/video/ModelOverlayLegend";
import { compareSummary } from "@/hooks/useModelOverlayFrame";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { modelPoseToRendered } from "@/canvas/modelOverlayRenderer";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import { makeVideo, poseAt } from "./modelOverlayTestData";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function pose(xy: [number, number][]): OverlayPose {
  return { xy: Float64Array.from(xy.flat()), score: 0.9, trackName: null };
}

function model(id: string, video: ReturnType<typeof makeVideo>, frames: Record<number, OverlayPose[]>): OverlayModel {
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

/** Frames 0–3: a and b both on 0, 1, 2; they disagree (head 40 px apart) on frame 2 only. */
function twoModels(video = makeVideo("/data/mouse.mp4")) {
  const same = poseAt(100, 100);
  const off = same.map((p, i) => (i === 0 ? ([p[0] + 40, p[1]] as [number, number]) : p));
  const a = model("a", video, { 0: [pose(same)], 1: [pose(same)], 2: [pose(same)], 3: [pose(same)] });
  const b = model("b", video, { 0: [pose(same)], 1: [pose(same)], 2: [pose(off)] });
  return { video, a, b };
}

describe("compareSummary", () => {
  // The header's counts: video name, models shown, frames with 2+ models, frames they disagree on.
  it("counts shown models, overlapping frames and disagreeing frames", () => {
    const { video, a, b } = twoModels();
    const s = compareSummary([a, b], video, 10, true);
    expect(s).toEqual({ videoName: "mouse.mp4", shown: 2, overlapFrames: 3, disagreeFrames: 1 });
    expect(summaryLine(s, true)).toBe("mouse.mp4 · 2 models shown · 3 frames with 2+ · 1 disagree");
  });

  // A hidden model doesn't count, and with the highlight off there's no "disagree" part.
  it("leaves out hidden models and the disagree count when the highlight is off", () => {
    const { video, a, b } = twoModels();
    const s = compareSummary([a, { ...b, visible: false }], video, 10, true);
    expect(s.shown).toBe(1);
    expect(s.overlapFrames).toBe(0);
    expect(summaryLine(compareSummary([a, b], video, 10, false), false)).toBe("mouse.mp4 · 2 models shown · 3 frames with 2+");
  });
});

describe("ModelOverlayLegend", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useModelOverlayStore.getState().clear();
    useModelOverlayStore.setState({ legendMinimized: false });
  });
  afterEach(() => cleanup());

  function showTwo() {
    const { video, a, b } = twoModels();
    const labels = new Labels({ videos: [video] });
    useAppStore.setState({ labels, video, frameIdx: 0 });
    useModelOverlayStore.getState().addModels(labels, [
      { name: "a", source: "/a.slp", video, frames: a.frames },
      { name: "b", source: "/b.slp", video, frames: b.frames },
    ]);
  }

  // Hand-test: the panel needs a clear title so it's obvious what it is.
  it("shows the title and the summary line", () => {
    showTwo();
    render(<ModelOverlayLegend disagreementCount={0} />);
    expect(screen.getByTestId("model-overlay-title").textContent).toBe("Compare Model Predictions");
    expect(screen.getByTestId("model-overlay-summary").textContent).toContain("3 frames with 2+");
  });

  // Hand-test: "–" folds the whole panel into a pill; clicking the pill brings it back. Models stay loaded.
  it("minimizes to a pill and expands again", () => {
    showTwo();
    render(<ModelOverlayLegend disagreementCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(useModelOverlayStore.getState().legendMinimized).toBe(true);
    expect(screen.queryByTestId("model-overlay-legend")).toBeNull();
    expect(screen.getByTestId("model-overlay-pill").textContent).toBe("Compare Models (2)");
    expect(useModelOverlayStore.getState().models.length).toBe(2);
    fireEvent.click(screen.getByTestId("model-overlay-pill"));
    expect(screen.getByTestId("model-overlay-legend")).toBeTruthy();
  });

  // Hand-test: the panel's eye button does exactly what H does (hide/show the project's instances).
  it("toggles project instances like the H key", () => {
    showTwo();
    renderHook(() => useKeyboardShortcuts());
    render(<ModelOverlayLegend disagreementCount={0} />);
    expect(useAppStore.getState().showInstances).toBe(true);
    fireEvent.click(screen.getByTestId("model-overlay-hide-instances"));
    expect(useAppStore.getState().showInstances).toBe(false);
    expect(screen.getByTestId("model-overlay-hide-instances").textContent).toContain("Show project instances (H)");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", code: "KeyH", bubbles: true }));
    });
    expect(useAppStore.getState().showInstances).toBe(true);
  });

  // Hand-test: the traces button says "Traces" instead of an unlabeled pulse icon.
  it("labels the traces button", () => {
    showTwo();
    render(<ModelOverlayLegend disagreementCount={0} />);
    fireEvent.click(screen.getByTestId("model-overlay-traces"));
    expect(screen.getByTestId("model-overlay-traces").textContent).toContain("Traces");
    expect(useModelOverlayStore.getState().tracesOpen).toBe(true);
  });
});

describe("modelPoseToRendered", () => {
  // Hand-test: models must look like the project's predicted instances, just in the model's colour.
  it("draws a model pose as a predicted instance in its colour, skipping missing nodes", () => {
    const p = poseAt(10, 20);
    p[1] = [NaN, NaN];
    const r = modelPoseToRendered(pose(p), MODEL_COLORS[2], [[0, 1]], (x, y) => [x, y]);
    expect(r.isPredicted).toBe(true);
    expect(r.color).toEqual(MODEL_COLORS[2]);
    expect(r.trackName).toBeNull();
    expect(r.nodes.map((n) => n.visible)).toEqual([true, false, true]);
    expect(r.showNonVisible).toBe(false);
  });
});
