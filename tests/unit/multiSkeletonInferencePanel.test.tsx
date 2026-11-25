/**
 * The Inference panel on a mice + pellet project (#99): no longer gated — it
 * explains that models are matched to skeletons by node names, and on a
 * worker it refuses the targets sleap-nn can't run on mixed-skeleton frames.
 */

import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { Labels } from "@talmolab/sleap-io.js";
import { makeMouseSkeleton, makeTwoSkeletonProject } from "./multiSkeletonFixture";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { InferencePanel } = await import("@/components/panels/InferencePanel");

/** In a browser build the panel needs a connected worker to show its body. */
function renderWith(labels: Labels) {
  useAppStore.getState().setLabels(labels, "p.slp");
  useConnectStore.setState({ connectionStatus: "connected" });
  return render(<InferencePanel />);
}

afterEach(() => {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("Inference panel with several skeletons", () => {
  // Inference is no longer refused on mice + pellets: the panel shows instead.
  it("shows the panel with the node-name matching note, not the gate", () => {
    renderWith(makeTwoSkeletonProject().labels);
    expect(screen.queryByTestId("multi-skeleton-gate")).toBeNull();
    expect(screen.getByTestId("multi-skeleton-pipeline-note")).toBeTruthy();
  });

  // Single-skeleton projects keep the pipeline picker (no note).
  it("keeps the pipeline picker on a single-skeleton project", () => {
    renderWith(new Labels({ skeletons: [makeMouseSkeleton()] }));
    expect(screen.queryByTestId("multi-skeleton-pipeline-note")).toBeNull();
  });
});
