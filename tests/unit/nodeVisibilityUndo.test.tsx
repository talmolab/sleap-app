/**
 * Every node-visibility toggle must be undoable and mark the frame changed.
 * The context menu's "Mark Node (Non-)Visible" used to flip `point.visible`
 * without taking an undo snapshot, so Ctrl+Z could not revert it while the
 * V-key and right-click toggles could. All of them now go through the
 * ToggleNodeVisibility command.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Instance, LabeledFrame, Labels, Skeleton, Video } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext, ToggleNodeVisibility } from "@/commands";
import { ContextMenu } from "@/components/video/ContextMenu";
import { classifyDirty } from "@/lib/autosaveDirty";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** One frame with two user instances whose nodes are all visible. */
function setupFrame() {
  const skeleton = new Skeleton({ nodes: ["head", "thorax", "tail"], name: "s" });
  const video = new Video({
    filename: "v.mp4",
    backendMetadata: { shape: [10, 64, 64, 1] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  for (let i = 0; i < 2; i++) {
    const inst = Instance.empty({ skeleton });
    inst.points.forEach((p, n) => {
      p.xy = [10 * n + i, 20 * n + i];
      p.visible = true;
      p.complete = true;
    });
    lf.instances.push(inst);
  }
  labels.labeledFrames.push(lf);

  const store = useAppStore.getState();
  store.setLabels(labels, "v.slp");
  store.setLabeledFrame(lf);
  return { labels, lf, video };
}

describe("ToggleNodeVisibility", () => {
  beforeEach(() => {
    resetStore();
  });

  it("flips a single node, marks the frame changed, and undoes", async () => {
    const { lf } = setupFrame();
    const overlayBefore = useAppStore.getState().overlayVersion;

    await commandContext.execute(ToggleNodeVisibility, {
      nodes: [{ instanceIdx: 0, nodeIdx: 1 }],
    });

    expect(lf.instances[0].points[1].visible).toBe(false);
    const s = useAppStore.getState();
    expect(s.hasChanges).toBe(true);
    expect(s.overlayVersion).toBeGreaterThan(overlayBefore);
    expect(s.frameInteractionStack).toContain("0:0");
    expect(commandContext.undoCommandName).toBe("ToggleNodeVisibility");

    expect(commandContext.undo()).toBe(true);
    expect(lf.instances[0].points[1].visible).toBe(true);
  });

  it("moves several nodes to one state and undoes them together", async () => {
    const { lf } = setupFrame();
    // 1 of 3 visible -> at most half visible -> all become visible.
    lf.instances[0].points[0].visible = false;
    lf.instances[1].points[2].visible = false;
    const nodes = [
      { instanceIdx: 0, nodeIdx: 0 },
      { instanceIdx: 1, nodeIdx: 2 },
      { instanceIdx: 1, nodeIdx: 0 },
    ];

    await commandContext.execute(ToggleNodeVisibility, { nodes });
    expect(lf.instances[0].points[0].visible).toBe(true);
    expect(lf.instances[1].points[2].visible).toBe(true);
    expect(lf.instances[1].points[0].visible).toBe(true);

    // All 3 visible now -> more than half -> all hidden.
    await commandContext.execute(ToggleNodeVisibility, { nodes });
    expect(nodes.every(({ instanceIdx, nodeIdx }) => !lf.instances[instanceIdx].points[nodeIdx].visible)).toBe(true);

    commandContext.undo();
    commandContext.undo();
    expect(lf.instances[0].points[0].visible).toBe(false);
    expect(lf.instances[1].points[2].visible).toBe(false);
    expect(lf.instances[1].points[0].visible).toBe(true);
  });

  it("ignores nodes that don't exist on the current frame", async () => {
    const { lf } = setupFrame();

    await commandContext.execute(ToggleNodeVisibility, {
      nodes: [
        { instanceIdx: -1, nodeIdx: 0 },
        { instanceIdx: 5, nodeIdx: 0 },
        { instanceIdx: 0, nodeIdx: 99 },
      ],
    });

    expect(lf.instances.every((inst) => inst.points.every((p) => p.visible))).toBe(true);
    expect(useAppStore.getState().hasChanges).toBe(false);
  });

  it("keeps the incremental autosave's per-frame fast path", () => {
    const { video } = setupFrame();
    expect(
      classifyDirty({
        commandName: "ToggleNodeVisibility",
        frame: { videoRef: video, frameIdx: 0 },
        scopedFrames: null,
        allFrames: null,
        activeVideo: video,
        activeFrameIdx: 0,
      }),
    ).toEqual({ kind: "frames", frames: [{ video, frameIdx: 0 }] });
  });
});

describe("context menu node visibility", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  function openMenuOnNode(instanceIdx: number, nodeIdx: number) {
    const lf = useAppStore.getState().labeledFrame!;
    useAppStore.getState().setInstance(lf.instances[instanceIdx]);
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        sceneLocation={[0, 0]}
        instanceIdx={instanceIdx}
        nodeIdx={nodeIdx}
        onClose={onClose}
      />,
    );
    return onClose;
  }

  // Undo/redo update store state the mounted menu subscribes to.
  function undoInAct() {
    let done = false;
    act(() => {
      done = commandContext.undo();
    });
    return done;
  }

  function redoInAct() {
    let done = false;
    act(() => {
      done = commandContext.redo();
    });
    return done;
  }

  it("'Mark Node Non-Visible' is undoable and marks the frame changed", () => {
    const { lf } = setupFrame();
    const overlayBefore = useAppStore.getState().overlayVersion;
    const onClose = openMenuOnNode(1, 2);

    fireEvent.click(screen.getByText("Mark Node Non-Visible"));

    expect(onClose).toHaveBeenCalled();
    expect(lf.instances[1].points[2].visible).toBe(false);
    const s = useAppStore.getState();
    expect(s.hasChanges).toBe(true);
    expect(s.overlayVersion).toBeGreaterThan(overlayBefore);
    expect(s.frameInteractionStack).toContain("0:0");

    expect(commandContext.canUndo).toBe(true);
    expect(undoInAct()).toBe(true);
    expect(lf.instances[1].points[2].visible).toBe(true);
    // Only the clicked node was ever touched.
    expect(lf.instances[0].points.every((p) => p.visible)).toBe(true);

    expect(redoInAct()).toBe(true);
    expect(lf.instances[1].points[2].visible).toBe(false);
  });

  it("'Mark Node Visible' is undoable", () => {
    const { lf } = setupFrame();
    lf.instances[0].points[1].visible = false;
    openMenuOnNode(0, 1);

    fireEvent.click(screen.getByText("Mark Node Visible"));
    expect(lf.instances[0].points[1].visible).toBe(true);

    expect(undoInAct()).toBe(true);
    expect(lf.instances[0].points[1].visible).toBe(false);
  });
});
