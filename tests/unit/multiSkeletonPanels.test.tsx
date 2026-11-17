/**
 * The real Training panel, gated on projects that use several different
 * skeletons: closed to new runs, but a running job stays visible, and identical
 * duplicate skeletons (old files) see the panel exactly as on main.
 */

import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { useTrainingStore } from "@/stores/trainingStore";
import type { Labels } from "@talmolab/sleap-io.js";
import {
  makeDuplicateSkeletonProject,
  makeTwoSkeletonProject,
} from "./multiSkeletonFixture";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { TrainingPanel } = await import("@/components/panels/TrainingPanel");

/** In a browser build the panel needs a connected worker to show its body. */
function renderWith(labels: Labels) {
  useAppStore.getState().setLabels(labels, "p.slp");
  useConnectStore.setState({ connectionStatus: "connected" });
  return render(<TrainingPanel />);
}

afterEach(() => {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
  useTrainingStore.setState({ status: "idle" });
});

describe("Training panel on a multi-skeleton project", () => {
  // Training reads skeletons[0]: on mice + pellets it says so instead.
  it("shows the not-supported message instead of the panel", () => {
    renderWith(makeTwoSkeletonProject().labels);
    expect(screen.getByTestId("multi-skeleton-gate")).toBeTruthy();
    expect(
      screen.getByText("Training with several skeletons isn't supported yet."),
    ).toBeTruthy();
  });

  // Adding a second skeleton mid-run must not hide the job or its Stop button.
  it("keeps a running job visible, with a note, instead of unmounting it", () => {
    useTrainingStore.setState({ status: "running" });
    renderWith(makeTwoSkeletonProject().labels);
    expect(screen.queryByTestId("multi-skeleton-gate")).toBeNull();
    expect(screen.getByTestId("multi-skeleton-busy-note")).toBeTruthy();
  });

  // Identical duplicate skeletons aren't "several skeletons": no gate, no note.
  it("renders the panel unchanged for identical duplicate skeletons", () => {
    renderWith(makeDuplicateSkeletonProject().labels);
    expect(screen.queryByTestId("multi-skeleton-gate")).toBeNull();
    expect(screen.queryByTestId("multi-skeleton-busy-note")).toBeNull();
  });
});

describe("store-level guard", () => {
  // The panel isn't the only way in (menu, Connect): the store refuses too.
  it("startTraining refuses on a multi-skeleton project", async () => {
    useAppStore.getState().setLabels(makeTwoSkeletonProject().labels, "p.slp");
    await useTrainingStore.getState().startTraining();
    expect(useTrainingStore.getState().status).toBe("idle");
  });
});
