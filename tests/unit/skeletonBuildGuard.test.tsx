/**
 * Render tests for the "Draw skeleton on frame" launch guard in SkeletonPanel.
 *
 * When a non-empty skeleton already exists, launching the visual builder first
 * warns the user (Edit existing / Delete & start new / Cancel) instead of
 * entering the builder immediately. An empty (or absent) skeleton enters the
 * builder directly, as before.
 *
 * These prove the PANEL wiring (button onClick → guard dialog → store actions),
 * not the command/store cores (covered by skeletonCommands + store tests). The
 * launch button requires a `video` in the store to be enabled, so each project
 * is seeded with a video.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";

// Toast is fire-and-forget; stub it so handlers don't depend on sonner.
vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// Radix dialogs need ResizeObserver + a few pointer/scroll shims in the DOM.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

function resetStore() {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Seed a project with a video (so the launch button is enabled) and a skeleton
 * with the given node names.
 */
function setupProject(nodeNames: string[]) {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "s" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.labeledFrames.push(new LabeledFrame({ video, frameIdx: 0 }));
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, skeleton, video };
}

describe("SkeletonPanel — Draw skeleton launch guard", () => {
  beforeEach(() => {
    resetStore();
  });

  it("enters the builder directly on an EMPTY skeleton (no guard dialog)", async () => {
    setupProject([]);
    const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
    render(<SkeletonPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );

    expect(useAppStore.getState().skeletonBuildMode).toBe(true);
    // No guard dialog was shown.
    expect(
      screen.queryByText(/skeleton already defined/i),
    ).not.toBeInTheDocument();
  });

  it("opens the guard dialog on a NON-empty skeleton without entering build", async () => {
    setupProject(["head", "tail"]);
    const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
    render(<SkeletonPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );

    // Guard dialog appears; build mode NOT entered yet.
    expect(screen.getByText(/skeleton already defined/i)).toBeInTheDocument();
    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
  });

  it("guard 'Edit existing' enters build with the skeleton unchanged", async () => {
    setupProject(["head", "tail"]);
    const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
    render(<SkeletonPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /edit existing/i }));

    expect(useAppStore.getState().skeletonBuildMode).toBe(true);
    // Skeleton is preserved (same node count).
    expect(useAppStore.getState().skeleton?.nodes.length).toBe(2);
  });

  it("guard 'Delete & start new' empties the skeleton, clears the template layout, and enters build", async () => {
    setupProject(["head", "tail"]);
    // Seed a stale template layout to prove it gets cleared.
    useAppStore.setState({
      skeletonTemplateLayout: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    });

    const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
    render(<SkeletonPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /delete & start new/i }),
    );

    expect(useAppStore.getState().skeleton?.nodes.length).toBe(0);
    expect(useAppStore.getState().skeletonTemplateLayout).toBe(null);
    expect(useAppStore.getState().skeletonBuildMode).toBe(true);
  });
});
