/**
 * The Training panel must say so when a project has no ground truth, instead
 * of presenting baseline-preset defaults as if they were derived from the data.
 *
 * Reproduces the reported case: opening a `labels_pr.*.slp` (predictions only)
 * and going to Training showed a fully populated config with a "💡 Only one
 * animal per frame" suggestion, on a two-animal project.
 */

import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { TrainingPanel } = await import("@/components/panels/TrainingPanel");

const skeleton = new Skeleton({ nodes: ["a", "b"], edges: [["a", "b"]] });

function video(): Video {
  return new Video({
    filename: "clip.mp4",
    openBackend: false,
    backendMetadata: { shape: [100, 480, 640, 1] },
  });
}

function twoPoints(x: number, size: number): number[][] {
  return [
    [x, x],
    [x + size, x + size],
  ];
}

/** 2 instances per frame, of the given kind. */
function project(kind: "predicted" | "user"): Labels {
  const v = video();
  return new Labels({
    videos: [v],
    skeletons: [skeleton],
    labeledFrames: Array.from({ length: 8 }, (_, i) =>
      new LabeledFrame({
        video: v,
        frameIdx: i,
        instances: [10, 300].map((x) =>
          kind === "user"
            ? Instance.fromNumpy({ pointsData: twoPoints(x, 40), skeleton })
            : PredictedInstance.fromNumpy({
                pointsData: twoPoints(x, 40),
                skeleton,
                score: 0.9,
              })
        ),
      })
    ),
  });
}

const WARNING = /No labeled frames in this project/i;

/** Render the panel with a project loaded. In a browser build the panel is
 *  gated behind a connected worker (it renders only a "connect to a worker"
 *  stub otherwise), so mark the connection up. */
function renderWith(labels: Labels) {
  useAppStore.setState({ labels });
  useConnectStore.setState({ connectionStatus: "connected" });
  return render(<TrainingPanel />);
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ labels: null });
  useConnectStore.setState({ connectionStatus: "disconnected" });
});

describe("Training panel no-labeled-frames warning", () => {
  it("warns when the project holds only predictions", () => {
    renderWith(project("predicted"));
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("does not suggest a model type from predictions", () => {
    renderWith(project("predicted"));
    // The bogus suggestion that prompted this fix.
    expect(screen.queryByText(/Only one animal per frame/i)).toBeNull();
  });

  it("stays quiet — and still suggests — for a user-labeled project", () => {
    renderWith(project("user"));
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
