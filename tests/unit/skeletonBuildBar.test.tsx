/**
 * Render tests for the on-canvas visual-skeleton-builder control bar
 * (SkeletonBuildBar, Task 6).
 *
 * These cover the BAR's UI wiring, not the store actions or command core (those
 * are covered by the store + skeletonCommands tests). We assert:
 *   - Hidden when not in build mode (early-return null).
 *   - Place stage renders its label + Undo + Next; clicking Next advances the
 *     store stage to "connect".
 *   - Connect stage renders its label + Back/Undo/Clear/Done; clicking Done
 *     exits build mode and toasts a node/edge summary.
 *   - Escape (while mounted) runs the same Done path.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, Skeleton } from "@talmolab/sleap-io.js";

// Toast is fire-and-forget; stub it so the Done path doesn't depend on sonner.
const toastSuccess = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

function resetStore() {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
  toastSuccess.mockClear();
}

/** Seed a skeleton with the given node names into the store. */
function setupSkeleton(nodeNames: string[]) {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "s" });
  const labels = new Labels({ videos: [], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  return skeleton;
}

describe("SkeletonBuildBar (Task 6)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when not in build mode", async () => {
    setupSkeleton(["a", "b"]);
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    const { container } = render(<SkeletonBuildBar />);
    expect(container.firstChild).toBeNull();
  });

  it("place stage: shows label + Undo + Next; Next advances to connect", async () => {
    setupSkeleton(["a", "b"]);
    useAppStore.getState().enterSkeletonBuild();
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    expect(screen.getByText(/1 · Place nodes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo/i })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Next: Connect edges/i }),
    );
    expect(useAppStore.getState().skeletonBuildStage).toBe("connect");
  });

  it("connect stage: Done exits build mode and toasts a summary", async () => {
    const skeleton = setupSkeleton(["a", "b"]);
    // Give it an edge so the summary count is non-trivial.
    skeleton.edges = [
      { source: skeleton.nodes[0], destination: skeleton.nodes[1] },
    ] as unknown as typeof skeleton.edges;
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setSkeletonBuildStage("connect");
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    expect(screen.getByText(/2 · Connect edges/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /clear edges/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Skeleton defined — 2 node(s), 1 edge(s)",
    );
  });

  it("Escape runs the Done path (exits build mode)", async () => {
    setupSkeleton(["a", "b"]);
    useAppStore.getState().enterSkeletonBuild();
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
    expect(toastSuccess).toHaveBeenCalled();
  });
});
