/**
 * The Training panel refuses to start, with legacy SLEAP's reasons, when an ID
 * model has no tracked user instances to learn from, or when Bottom-Up is
 * picked for a skeleton that isn't a tree with one root.
 */

import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, Track, Video } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { useTrainingStore, type ModelType } from "@/stores/trainingStore";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { TrainingPanel } = await import("@/components/panels/TrainingPanel");

const tree = new Skeleton({ nodes: ["a", "b", "c"], edges: [["a", "b"], ["b", "c"]] });
const cyclic = new Skeleton({ nodes: ["a", "b", "c"], edges: [["a", "b"], ["b", "c"], ["c", "a"]] });

function project(skeleton: Skeleton, tracked: boolean): Labels {
  const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
  const tracks = tracked ? [new Track("mouse")] : [];
  return new Labels({
    videos: [video],
    skeletons: [skeleton],
    tracks,
    labeledFrames: Array.from({ length: 4 }, (_, i) =>
      new LabeledFrame({
        video,
        frameIdx: i,
        instances: [
          Instance.fromNumpy({
            pointsData: [[10, 10], [40, 40], [70, 70]],
            skeleton,
            track: tracks[0],
          }),
        ],
      })
    ),
  });
}

/** In a browser build the panel needs a connected worker; it then trains on this window's labels. */
function renderWith(labels: Labels, modelType: ModelType) {
  useAppStore.setState({ labels, skeleton: labels.skeletons[0] });
  useConnectStore.setState({ connectionStatus: "connected" });
  render(<TrainingPanel />);
  // After mount, so the panel's auto-pick of a recommended model type can't override it.
  act(() => useTrainingStore.getState().setConfig("modelType", modelType));
}

const problem = () => screen.queryByTestId("training-pipeline-problem");

afterEach(() => {
  cleanup();
  useAppStore.setState({ labels: null, skeleton: null });
  useConnectStore.setState({ connectionStatus: "disconnected" });
  useTrainingStore.setState(useTrainingStore.getInitialState());
});

describe("Training pre-run checks", () => {
  it("blocks Top-Down + ID when no user instance has a track", () => {
    renderWith(project(tree, false), "top_down_id");
    expect(problem()?.textContent).toMatch(/ID models learn from tracks/);
    expect(screen.getByText(/Fix the problem under Model Type/)).toBeInTheDocument();
  });

  it("blocks Bottom-Up + ID the same way", () => {
    renderWith(project(tree, false), "bottom_up_id");
    expect(problem()?.textContent).toMatch(/ID models learn from tracks/);
  });

  it("allows ID models once user instances are tracked", () => {
    renderWith(project(tree, true), "top_down_id");
    expect(problem()).toBeNull();
  });

  it("blocks Bottom-Up on a skeleton with a cycle", () => {
    renderWith(project(cyclic, true), "bottom_up");
    expect(problem()?.textContent).toMatch(/tree with one root.*cycle: a → b → c → a/);
  });

  it("follows a skeleton edit made while the panel is open", () => {
    const skeleton = new Skeleton({ nodes: ["a", "b", "c"], edges: [["a", "b"], ["b", "c"]] });
    renderWith(project(skeleton, true), "bottom_up");
    expect(problem()).toBeNull();
    // AddEdgeCommand mutates the skeleton in place, then marks the project changed.
    act(() => {
      skeleton.addEdge("c", "a");
      useAppStore.getState().markChanged();
    });
    expect(problem()?.textContent).toMatch(/cycle: a → b → c → a/);
  });

  it("allows Bottom-Up on a tree, and other model types on a cyclic skeleton", () => {
    renderWith(project(tree, false), "bottom_up");
    expect(problem()).toBeNull();
    cleanup();
    renderWith(project(cyclic, false), "top_down");
    expect(problem()).toBeNull();
  });
});
