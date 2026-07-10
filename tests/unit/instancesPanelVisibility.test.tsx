/**
 * Render tests for the Instances panel's per-instance visibility columns
 * (Task 5 — SLEAP PyQt parity #2755/#2782/#2772/#2784).
 *
 * Exercises the three checkbox columns (Visibility / View Only / Invisible
 * Nodes) via real store actions and real reads of the resulting transient
 * per-instance visibility state. The pure predicate math is covered by
 * tests/unit/instanceVisibility.test.ts; these tests assert the panel wiring.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

// Mock platform module (matches suggestionsPanelControls.test.tsx).
vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
}));

// Mock sonner toast so toast.* are no-ops here.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

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

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Build a 2-instance labeled frame at frameIdx 0 and load it into the store so
 * InstancesPanel's `labels.find({ video, frameIdx })` resolves to the frame.
 */
function loadTwoInstanceFrame() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const inst0 = Instance.fromArray(
    [
      [10, 10],
      [20, 20],
    ],
    skeleton,
  );
  const inst1 = Instance.fromArray(
    [
      [30, 30],
      [40, 40],
    ],
    skeleton,
  );
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  lf.instances = [inst0, inst1];
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.append(lf);

  useAppStore.setState({ labels, video, frameIdx: 0 });
  return { labels, video, skeleton, inst0, inst1 };
}

describe("InstancesPanel per-instance visibility columns (Task 5)", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  it("unchecking a row's Visibility hides that instance", async () => {
    loadTwoInstanceFrame();

    const { InstancesPanel } = await import(
      "@/components/panels/InstancesPanel"
    );
    render(<InstancesPanel />);

    const visBoxes = screen.getAllByRole("checkbox", { name: /visibility/i });
    expect(visBoxes.length).toBe(2);
    // Boxes start checked (nothing hidden, no view-only).
    expect(visBoxes[0]).toBeChecked();

    fireEvent.click(visBoxes[0]);

    expect(useAppStore.getState().hiddenInstances.size).toBe(1);
    // The panel must re-render off the store change: re-query and confirm the
    // box now reflects hidden (guards the subscription, the task's main risk).
    expect(
      screen.getAllByRole("checkbox", { name: /visibility/i })[0],
    ).not.toBeChecked();
  });

  it("View Only is radio-like: clicking a second row moves the focus", async () => {
    const { inst0, inst1 } = loadTwoInstanceFrame();

    const { InstancesPanel } = await import(
      "@/components/panels/InstancesPanel"
    );
    render(<InstancesPanel />);

    fireEvent.click(
      screen.getAllByRole("checkbox", { name: /view only/i })[0],
    );
    expect(useAppStore.getState().viewOnlyInstance).not.toBeNull();
    expect(useAppStore.getState().viewOnlyInstance).toBe(inst0);
    // Panel re-renders off the store: box[0] now reads checked.
    expect(
      screen.getAllByRole("checkbox", { name: /view only/i })[0],
    ).toBeChecked();

    fireEvent.click(
      screen.getAllByRole("checkbox", { name: /view only/i })[1],
    );
    const viewOnly = useAppStore.getState().viewOnlyInstance;
    expect(viewOnly).not.toBeNull();
    expect(viewOnly).toBe(inst1);
    // Focus moved: box[1] is checked, box[0] is not.
    const viewOnlyBoxes = screen.getAllByRole("checkbox", {
      name: /view only/i,
    });
    expect(viewOnlyBoxes[1]).toBeChecked();
    expect(viewOnlyBoxes[0]).not.toBeChecked();
  });

  it("clicking a row's Invisible Nodes records a per-instance override", async () => {
    loadTwoInstanceFrame();

    const { InstancesPanel } = await import(
      "@/components/panels/InstancesPanel"
    );
    render(<InstancesPanel />);

    const invBoxes = screen.getAllByRole("checkbox", {
      name: /invisible nodes/i,
    });
    expect(invBoxes.length).toBe(2);

    fireEvent.click(invBoxes[0]);

    expect(useAppStore.getState().showNonVisibleOverride.size).toBe(1);
  });

  it("the three checkboxes are disabled outside manual QC display mode", async () => {
    loadTwoInstanceFrame();
    useAppStore.setState({ qcDisplayMode: "all_visible_only" });

    const { InstancesPanel } = await import(
      "@/components/panels/InstancesPanel"
    );
    render(<InstancesPanel />);

    for (const name of [/visibility/i, /view only/i, /invisible nodes/i]) {
      for (const box of screen.getAllByRole("checkbox", { name })) {
        expect(box).toBeDisabled();
      }
    }
  });

  it("clicking a checkbox hides the right instance and never changes selection", async () => {
    const { inst0, inst1 } = loadTwoInstanceFrame();
    // Pre-select instance 1; toggling instance 0's boxes must not steal it.
    useAppStore.setState({ instance: inst1 });

    const { InstancesPanel } = await import(
      "@/components/panels/InstancesPanel"
    );
    render(<InstancesPanel />);

    fireEvent.click(screen.getAllByRole("checkbox", { name: /visibility/i })[0]);
    // The clicked row's instance (inst0) is hidden — not some other row — and the
    // stopPropagation guard keeps the selected instance (inst1) untouched.
    expect(useAppStore.getState().hiddenInstances.has(inst0)).toBe(true);
    expect(useAppStore.getState().instance).toBe(inst1);

    fireEvent.click(
      screen.getAllByRole("checkbox", { name: /invisible nodes/i })[1],
    );
    expect(useAppStore.getState().instance).toBe(inst1);
  });
});
