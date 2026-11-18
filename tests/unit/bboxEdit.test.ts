/**
 * Bounding boxes, part 2: drawing and editing (#488) — hit-testing, drag
 * maths, linking a drawn box to the instance it encloses, and the box commands
 * (each one undo step, each a frame-level autosave edit).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
  Track,
  UserBoundingBox,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { AddBbox, DeleteBbox, SetBboxGeometry, SetBboxProps } from "@/commands/bboxCommands";
import { useAppStore } from "@/stores/appStore";
import { classifyDirty } from "@/lib/autosaveDirty";
import type { RenderedBbox } from "@/canvas/BboxRenderer";
import { dragRect, handleCursor, hitTestBbox, rectFromPoints } from "@/lib/bboxEditing";
import { instanceInsideRect } from "@/lib/bboxLinking";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const N = Number.NaN;

function rb(index: number, x1: number, y1: number, x2: number, y2: number, isRotated = false): RenderedBbox {
  return {
    index,
    corners: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
    color: [255, 0, 0],
    isPredicted: false,
    isRotated,
    label: null,
    isSelected: false,
  };
}

describe("hitTestBbox", () => {
  const boxes = [rb(0, 10, 10, 50, 50), rb(1, 40, 40, 90, 90)];

  it("grabs an unselected box by its border only", () => {
    expect(hitTestBbox(boxes, 10, 30, 2, null)).toEqual({ index: 0, handle: "move" });
    // Inside an unselected box: nothing (the pose underneath stays clickable).
    expect(hitTestBbox(boxes, 25, 25, 2, null)).toBeNull();
    // Far away.
    expect(hitTestBbox(boxes, 200, 200, 2, null)).toBeNull();
  });

  it("the top-most box wins on overlapping borders", () => {
    // (50, 45): right edge of box 0 and inside-ish of box 1's left... (40,45) is box 1's left edge.
    expect(hitTestBbox(boxes, 40, 45, 1, null)?.index).toBe(1);
  });

  it("the selected box offers resize handles and moves from inside", () => {
    expect(hitTestBbox(boxes, 10, 10, 2, 0)).toEqual({ index: 0, handle: "nw" });
    expect(hitTestBbox(boxes, 30, 50, 2, 0)).toEqual({ index: 0, handle: "s" });
    expect(hitTestBbox(boxes, 50, 30, 2, 0)).toEqual({ index: 0, handle: "e" });
    expect(hitTestBbox(boxes, 25, 25, 2, 0)).toEqual({ index: 0, handle: "move" });
  });

  it("a rotated selected box only moves", () => {
    const rot = [rb(0, 10, 10, 50, 50, true)];
    expect(hitTestBbox(rot, 10, 10, 2, 0)).toEqual({ index: 0, handle: "move" });
  });
});

describe("dragRect", () => {
  const r = { x1: 10, y1: 20, x2: 30, y2: 60 };
  it("moves without resizing", () => {
    expect(dragRect(r, "move", 5, -5)).toEqual({ x1: 15, y1: 15, x2: 35, y2: 55 });
  });
  it("resizes only the grabbed edges", () => {
    expect(dragRect(r, "se", 10, 10)).toEqual({ x1: 10, y1: 20, x2: 40, y2: 70 });
    expect(dragRect(r, "w", -4, 99)).toEqual({ x1: 6, y1: 20, x2: 30, y2: 60 });
    expect(dragRect(r, "n", 99, 5)).toEqual({ x1: 10, y1: 25, x2: 30, y2: 60 });
  });
  it("flips instead of inverting when dragged past the opposite edge", () => {
    expect(dragRect(r, "e", -30, 0)).toEqual({ x1: 0, y1: 20, x2: 10, y2: 60 });
  });
  it("rectFromPoints normalizes and cursors match handles", () => {
    expect(rectFromPoints({ x: 5, y: 9 }, { x: 1, y: 2 })).toEqual({ x1: 1, y1: 2, x2: 5, y2: 9 });
    expect(handleCursor("move")).toBe("move");
    expect(handleCursor("ne")).toBe("nesw-resize");
    expect(handleCursor("w")).toBe("ew-resize");
  });
});

describe("instanceInsideRect", () => {
  const sk = new Skeleton({ nodes: ["a", "b", "c", "d", "e"], name: "s" });
  it("needs most visible points inside", () => {
    const inst = Instance.fromArray([[1, 1], [2, 2], [3, 3], [4, 4], [100, 100]], sk);
    expect(instanceInsideRect(inst, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(true); // 4/5
    const half = Instance.fromArray([[1, 1], [2, 2], [100, 100], [100, 100], [N, N]], sk);
    expect(instanceInsideRect(half, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(false); // 2/4
    const none = Instance.fromArray([[N, N], [N, N], [N, N], [N, N], [N, N]], sk);
    expect(instanceInsideRect(none, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(false);
  });
});

describe("box commands", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  function setup(withFrame = true) {
    const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = new Video({
      filename: "/v/main.mp4",
      backendMetadata: { shape: [10, 480, 640, 3] },
      openBackend: false,
    });
    const track = new Track("A");
    const inst = Instance.fromArray([[10, 10], [20, 20]], sk);
    inst.track = track;
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [inst] });
    const labels = new Labels({
      labeledFrames: withFrame ? [lf] : [],
      skeletons: [sk],
      videos: [video],
      tracks: [track],
    });
    const store = useAppStore.getState();
    store.setLabels(labels, "t.slp");
    store.setVideo(video);
    store.setFrameIdx(0);
    store.setLabeledFrame(withFrame ? lf : null);
    return { labels, lf, inst, track, video };
  }

  it("AddBbox adds a normalized user box, links the instance and its track, selects it", async () => {
    const { lf, inst, track } = setup();
    await ctx.execute(AddBbox, { x1: 30, y1: 40, x2: 5, y2: 2, instance: inst });
    expect(lf.bboxes).toHaveLength(1);
    const b = lf.bboxes[0];
    expect(b).toBeInstanceOf(UserBoundingBox);
    expect(b.xyxy).toEqual([5, 2, 30, 40]);
    expect(b.instance).toBe(inst);
    expect(b.track).toBe(track);
    expect(useAppStore.getState().selectedBboxIdx).toBe(0);
    expect(useAppStore.getState().hasChanges).toBe(true);

    expect(ctx.undo()).toBe(true);
    expect(lf.bboxes).toHaveLength(0);
  });

  it("AddBbox on an unlabeled frame creates the frame, and undo removes it again", async () => {
    const { labels, video } = setup(false);
    await ctx.execute(AddBbox, { x1: 0, y1: 0, x2: 10, y2: 10 });
    const lf = labels.find({ video, frameIdx: 0 })[0];
    expect(lf.bboxes).toHaveLength(1);
    expect(useAppStore.getState().labeledFrame).toBe(lf);
    expect(ctx.undo()).toBe(true);
    expect(labels.find({ video, frameIdx: 0 })).toHaveLength(0);
  });

  it("AddBbox ignores non-finite coordinates", async () => {
    const { lf } = setup();
    await ctx.execute(AddBbox, { x1: 0, y1: N, x2: 1, y2: 1 });
    expect(lf.bboxes).toHaveLength(0);
  });

  it("SetBboxGeometry moves/resizes and keeps the angle; undo restores it", async () => {
    const { lf } = setup();
    lf.bboxes.push(new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10, angle: 0.3 }));
    await ctx.execute(SetBboxGeometry, { index: 0, x1: 5, y1: 6, x2: 25, y2: 36 });
    expect([lf.bboxes[0].x1, lf.bboxes[0].y1, lf.bboxes[0].x2, lf.bboxes[0].y2]).toEqual([5, 6, 25, 36]);
    expect(lf.bboxes[0].angle).toBe(0.3);
    expect(ctx.undo()).toBe(true);
    expect([lf.bboxes[0].x1, lf.bboxes[0].x2]).toEqual([0, 10]);
  });

  it("DeleteBbox removes the box, clears selection, and drops a now-empty frame", async () => {
    const { labels, lf, video } = setup();
    lf.instances = [];
    lf.bboxes.push(new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10 }));
    useAppStore.getState().set("selectedBboxIdx", 0);
    await ctx.execute(DeleteBbox, { index: 0 });
    expect(useAppStore.getState().selectedBboxIdx).toBeNull();
    expect(labels.find({ video, frameIdx: 0 })).toHaveLength(0);
    expect(ctx.undo()).toBe(true);
    expect(labels.find({ video, frameIdx: 0 })[0].bboxes).toHaveLength(1);
  });

  it("SetBboxProps sets category, track and instance link (link brings its track)", async () => {
    const { lf, inst, track } = setup();
    lf.bboxes.push(new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10 }));
    await ctx.execute(SetBboxProps, { index: 0, category: "  mouse " });
    expect(lf.bboxes[0].category).toBe("mouse");
    await ctx.execute(SetBboxProps, { index: 0, instance: inst });
    expect(lf.bboxes[0].instance).toBe(inst);
    expect(lf.bboxes[0].track).toBe(track);
    await ctx.execute(SetBboxProps, { index: 0, track: null });
    expect(lf.bboxes[0].track).toBeNull();
    expect(ctx.undo()).toBe(true);
    expect(lf.bboxes[0].track).toBe(track);
  });

  it("a bad index is a no-op", async () => {
    const { lf } = setup();
    await ctx.execute(DeleteBbox, { index: 3 });
    await ctx.execute(SetBboxGeometry, { index: -1, x1: 0, y1: 0, x2: 1, y2: 1 });
    expect(lf.bboxes).toHaveLength(0);
  });

  it("box commands are frame-level edits for the incremental autosave", async () => {
    setup();
    for (const name of ["AddBbox", "SetBboxGeometry", "DeleteBbox", "SetBboxProps"]) {
      const snap = ctx.takeSnapshot(name);
      expect(classifyDirty(snap).kind).toBe("frames");
    }
  });
});

describe("box tool shortcut", () => {
  it("B toggles the box tool", () => {
    expect(DEFAULT_SHORTCUTS["box tool"]).toBe("KeyB");
  });
});
