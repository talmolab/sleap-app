/**
 * The Compare Model Predictions corner panel after hand-testing: title,
 * folding it into a pill, the "Hide project instances (H)" button, selecting
 * a model's row, models drawn in the app's predicted-instance style, and
 * hovering a model pose.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach } from "../bun-test";
import { render, renderHook, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Labels } from "@talmolab/sleap-io.js";
import { ModelOverlayLegend, NO_POSES_ON_FRAME } from "@/components/video/ModelOverlayLegend";
import { modelHoverLines } from "@/components/video/ModelPoseHoverLabel";
import { useModelOverlayUiStore } from "@/stores/modelOverlayUiStore";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { modelPoseToRendered, modelRenderOptions, hoverTestModelOverlay } from "@/canvas/modelOverlayRenderer";
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

describe("ModelOverlayLegend", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useModelOverlayStore.getState().clear();
    useModelOverlayStore.setState({ legendMinimized: false });
    useModelOverlayUiStore.setState({ selectedModelId: null, hover: null });
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

  // Hand-test: a clear title, and (round 2) no summary line under it.
  it("shows the title without a summary line", () => {
    showTwo();
    render(<ModelOverlayLegend disagreementCount={0} />);
    expect(screen.getByTestId("model-overlay-title").textContent).toBe("Compare Model Predictions");
    expect(screen.queryByTestId("model-overlay-summary")).toBeNull();
  });

  // Hand-test round 2: clicking a model's name selects its row; again (or Esc) deselects.
  it("selects a model row by its name and deselects on a second click or Esc", () => {
    showTwo();
    render(<ModelOverlayLegend disagreementCount={0} />);
    const id = useModelOverlayStore.getState().models[0].id;
    fireEvent.click(screen.getByRole("button", { name: "a" }));
    expect(useModelOverlayUiStore.getState().selectedModelId).toBe(id);
    expect(screen.getAllByTestId("model-overlay-row")[0].getAttribute("data-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "a" }));
    expect(useModelOverlayUiStore.getState().selectedModelId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "a" }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useModelOverlayUiStore.getState().selectedModelId).toBeNull();
  });

  // Hand-test round 2: a selected model with nothing on this frame says so in its row.
  it("says when the selected model has no poses on this frame", () => {
    showTwo();
    act(() => useAppStore.setState({ frameIdx: 3 })); // model b has nothing on frame 3, a does
    render(<ModelOverlayLegend disagreementCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: "a" }));
    expect(screen.queryByTestId("model-overlay-no-poses")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(screen.getByTestId("model-overlay-no-poses").textContent).toBe(NO_POSES_ON_FRAME);
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

describe("model pose drawing strength and hover", () => {
  // Hand-test round 2: a low pose-opacity setting must not make model poses fainter than full strength.
  it("never draws model poses below full opacity", () => {
    const o = modelRenderOptions({ markerSize: 4, poseOpacity: 0.3, showEdges: true, zoom: 1, toImage: (x, y) => [x, y] });
    expect(o.poseOpacity).toBe(1);
    expect(o.colorPredicted).toBe(true);
  });

  const id = (x: number, y: number): [number, number] => [x, y];
  const layers = [
    { modelId: "a", color: MODEL_COLORS[0], poses: [pose(poseAt(100, 100))] },
    { modelId: "b", color: MODEL_COLORS[1], poses: [pose(poseAt(300, 300))] },
  ];

  // Hovering a model's node finds that model, pose and node (like a project prediction).
  it("hit-tests a model node", () => {
    expect(hoverTestModelOverlay(layers, [[0, 1]], 301, 290, 5, 30, id)).toEqual({ layer: 1, pose: 0, node: 0 });
  });

  // Off the nodes but on the pose's body, hover still finds the pose (node null), like a project instance.
  it("hit-tests a model pose's body", () => {
    expect(hoverTestModelOverlay(layers, [[0, 1]], 108, 104, 2, 30, id)).toEqual({ layer: 0, pose: 0, node: null });
  });

  // Far from every pose: no hover.
  it("finds nothing away from the poses", () => {
    expect(hoverTestModelOverlay(layers, [[0, 1]], 600, 600, 5, 30, id)).toBeNull();
  });

  // The hover label names the model, like "Predicted Instance" for a project prediction.
  it("labels a hovered model pose with the model's name and the node", () => {
    const lines = modelHoverLines("bottomup", pose(poseAt(10, 20)), 1, ["head", "thorax", "abdomen"]);
    expect(lines?.[0]).toBe("Predicted Instance · bottomup");
    expect(lines?.[1]).toBe("thorax · x: 10.0, y: 20.0");
    expect(modelHoverLines("m", undefined, null, [])).toBeNull();
  });
});
