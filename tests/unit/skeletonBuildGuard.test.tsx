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
  act,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands/CommandContext";
import {
  AddNodeCommand,
  DeleteSkeletonCommand,
} from "@/commands/skeletonCommands";
import { nextBuilderNodeName } from "@/components/video/VideoPlayer";
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

describe("SkeletonPanel — node numbering restarts after delete-and-restart (#builder)", () => {
  beforeEach(() => {
    resetStore();
  });

  // Command-level baseline: the delete command itself truly empties the skeleton
  // (so the namer, which scans `skeleton.nodes`, restarts at node_0). Proves the
  // regression is NOT in the command core — it's the panel's stale view.
  it("DeleteSkeletonCommand empties nodes so the namer restarts at node_0", async () => {
    const { skeleton } = setupProject([]);
    for (let i = 0; i < 6; i++) {
      await commandContext.execute(AddNodeCommand, {
        name: nextBuilderNodeName(skeleton.nodes),
      });
    }
    expect(skeleton.nodes.map((n) => n.name)).toEqual([
      "node_0",
      "node_1",
      "node_2",
      "node_3",
      "node_4",
      "node_5",
    ]);

    await commandContext.execute(DeleteSkeletonCommand);
    expect(skeleton.nodes.length).toBe(0);
    expect(nextBuilderNodeName(skeleton.nodes)).toBe("node_0");
  });

  // Root-cause regression: the on-canvas builder adds nodes by mutating the SAME
  // skeleton object in place (stable ref) + a store bump. The panel must re-read
  // and reflect that — otherwise its `nodes` snapshot stays stale, the launch
  // guard is skipped, and re-launching keeps numbering node_6, node_7, ….
  it("panel reflects builder-added nodes (not a stale count)", async () => {
    setupProject([]);
    const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
    render(<SkeletonPanel />);

    // Initially empty: launching enters build directly, no guard.
    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );
    expect(useAppStore.getState().skeletonBuildMode).toBe(true);

    // Simulate the on-canvas builder placing 6 nodes (commands only — no panel
    // interaction, exactly like clicks on the VideoPlayer canvas).
    await act(async () => {
      for (let i = 0; i < 6; i++) {
        await commandContext.execute(AddNodeCommand, {
          name: nextBuilderNodeName(useAppStore.getState().skeleton!.nodes),
        });
      }
    });

    // The panel now REFLECTS 6 nodes (was "Nodes (0)" + disabled delete before
    // the fix), and the Delete Skeleton button is enabled.
    expect(
      screen.getByRole("tab", { name: /nodes/i }).textContent,
    ).toContain("6");
    expect(
      (
        screen.getByRole("button", {
          name: /^delete skeleton$/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  // End-to-end: build via the builder, exit, then re-launch → the guard sees the
  // live count and offers "Delete & start new", which empties the skeleton so the
  // very next builder node restarts at node_0.
  it("delete-and-restart from the guard restarts numbering at node_0", async () => {
    setupProject([]);
    const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");
    render(<SkeletonPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );
    await act(async () => {
      for (let i = 0; i < 6; i++) {
        await commandContext.execute(AddNodeCommand, {
          name: nextBuilderNodeName(useAppStore.getState().skeleton!.nodes),
        });
      }
    });
    // Finish the build (exit build mode), like the SkeletonBuildBar's Done.
    act(() => useAppStore.getState().exitSkeletonBuild());

    // Re-launch: the guard must appear now that the panel sees 6 live nodes.
    fireEvent.click(
      screen.getByRole("button", { name: /draw skeleton on frame/i }),
    );
    expect(
      screen.getByText(/skeleton already defined/i),
    ).toBeInTheDocument();

    // Delete & start new → empties the skeleton → numbering restarts at node_0.
    fireEvent.click(
      screen.getByRole("button", { name: /delete & start new/i }),
    );
    expect(useAppStore.getState().skeleton!.nodes.length).toBe(0);
    expect(
      nextBuilderNodeName(useAppStore.getState().skeleton!.nodes),
    ).toBe("node_0");
  });
});
