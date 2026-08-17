/**
 * Render tests for the on-canvas visual-skeleton-builder control bar
 * (SkeletonBuildBar, Task 6).
 *
 * These cover the BAR's UI wiring, not the store actions or command core (those
 * are covered by the store + skeletonCommands tests). We assert:
 *   - Hidden when not in build mode (early-return null).
 *   - Place stage renders its label + Undo + Next; clicking Next advances the
 *     store stage to "connect".
 *   - Done captures the drawn layout as the session template and opens the
 *     create-instance confirmation WITHOUT exiting build mode.
 *   - "Not now" finalizes (exits + toasts) without adding an instance.
 *   - "Create instance" adds an instance on the current frame, then finalizes.
 *   - Escape quietly exits the MODE only — no capture, no toast.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { Labels, LabeledFrame, Skeleton, Video } from "@talmolab/sleap-io.js";

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

/** Seed a skeleton with the given node names into the store (no video). */
function setupSkeleton(nodeNames: string[]) {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "s" });
  const labels = new Labels({ videos: [], skeletons: [skeleton] });
  useAppStore.getState().setLabels(labels, "test.slp");
  return skeleton;
}

/**
 * Seed a full project (video + skeleton) so AddInstance can run: labels get a
 * video, the store is put in connect stage, and `builderPositions` is filled
 * with real coordinates for the drawn layout.
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
  useAppStore.getState().enterSkeletonBuild();
  useAppStore.getState().setSkeletonBuildStage("connect");
  // Drop real scratch positions so the captured template is meaningful.
  nodeNames.forEach((_, i) =>
    useAppStore.getState().setBuilderPosition(i, { x: 100 + i * 40, y: 120 }),
  );
  return { labels, skeleton, video };
}

/** Total instance count across all labeled frames. */
function totalInstances(labels: Labels) {
  return labels.labeledFrames.reduce((n, lf) => n + lf.instances.length, 0);
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

  it("Done captures the layout and opens the confirm dialog without exiting", async () => {
    const { skeleton } = setupProject(["a", "b"]);
    skeleton.edges = [
      { source: skeleton.nodes[0], destination: skeleton.nodes[1] },
    ] as unknown as typeof skeleton.edges;
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    // Still in build mode; the confirm dialog is up, and the template is captured.
    expect(useAppStore.getState().skeletonBuildMode).toBe(true);
    expect(useAppStore.getState().skeletonTemplateLayout).not.toBeNull();
    expect(
      screen.getByText(/Create a new instance on this frame/i),
    ).toBeInTheDocument();
    // No commit yet.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("Done → Not now: exits build mode + toasts, adds NO instance", async () => {
    const { labels, skeleton } = setupProject(["a", "b"]);
    skeleton.edges = [
      { source: skeleton.nodes[0], destination: skeleton.nodes[1] },
    ] as unknown as typeof skeleton.edges;
    const before = totalInstances(labels);
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Skeleton defined — 2 node(s), 1 edge(s)",
    );
    expect(totalInstances(labels)).toBe(before);
  });

  it("Done → Create instance: exits + toasts + adds an instance to the frame", async () => {
    const { labels } = setupProject(["a", "b"]);
    const before = totalInstances(labels);
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    fireEvent.click(screen.getByRole("button", { name: /create instance/i }));

    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Skeleton defined — 2 node(s), 0 edge(s) · instance added",
    );
    // AddInstance's synchronous body mutates the frame before its promise settles.
    expect(totalInstances(labels)).toBe(before + 1);
  });

  it("Escape quietly exits the MODE: no capture, no toast", async () => {
    setupSkeleton(["a", "b"]);
    useAppStore.getState().enterSkeletonBuild();
    const { SkeletonBuildBar } = await import(
      "@/components/video/SkeletonBuildBar"
    );
    render(<SkeletonBuildBar />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useAppStore.getState().skeletonBuildMode).toBe(false);
    // Escape does NOT capture a template …
    expect(useAppStore.getState().skeletonTemplateLayout).toBeNull();
    // … and does NOT toast a summary.
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
