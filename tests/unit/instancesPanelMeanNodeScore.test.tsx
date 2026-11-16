/**
 * View ▸ Show Mean Node Score adds a "Mean node score" column to the
 * Instances panel (PyQt's Instances dock column of the same name).
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Instance,
  LabeledFrame,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Radix ScrollArea/Tooltip need ResizeObserver in happy-dom.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

/** One predicted instance (node scores 0.8 and 0.4, instance score 0.99) and one user instance. */
function loadFrame() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const pred = PredictedInstance.fromArray([[10, 10, 0.8], [20, 20, 0.4]], skeleton, 0.99);
  const user = Instance.fromArray([[30, 30], [40, 40]], skeleton);
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  lf.instances = [pred, user];
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.append(lf);
  useAppStore.setState({ labels, video, frameIdx: 0 });
}

describe("Instances panel Mean node score column", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  // Off by default, like PyQt, so the table stays narrow.
  it("is hidden until the View toggle is on, then shows the node-score mean", async () => {
    loadFrame();
    const { InstancesPanel } = await import("@/components/panels/InstancesPanel");
    render(<InstancesPanel />);

    expect(screen.queryByText("Mean node score")).toBeNull();
    // The instance score is there either way.
    expect(screen.getByText("0.99")).toBeInTheDocument();

    act(() => useAppStore.getState().toggle("showMeanNodeScore"));

    expect(screen.getByText("Mean node score")).toBeInTheDocument();
    // (0.8 + 0.4) / 2, not the 0.99 instance score.
    expect(screen.getByText("0.60")).toBeInTheDocument();
  });
});
