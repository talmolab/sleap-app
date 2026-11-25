/**
 * Segmentation masks, part 2 (#155): the polygon tool — polygon geometry
 * (filling into a mask's own grid, add / cut, hit-testing, closing, linking
 * to the pose it encloses) and the mask commands (each one undo step, each a
 * frame-level autosave edit).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
  Track,
  UserSegmentationMask,
  PredictedSegmentationMask,
  encodeRle,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { AddMaskPolygon, DeleteMask, EditMaskPolygon } from "@/commands/maskCommands";
import { useAppStore } from "@/stores/appStore";
import { classifyDirty } from "@/lib/autosaveDirty";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import {
  closesPolygon,
  combineRasters,
  polygonAction,
  dedupePolygon,
  instanceInsidePolygon,
  isEmptyRaster,
  maskContains,
  maskIndexAt,
  pointInPolygon,
  polygonRaster,
  type Pt,
} from "@/lib/maskPolygon";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const N = Number.NaN;

/** A square with corners (x0, y0) and (x1, y1). */
const square = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Foreground pixels of a raster as "col,row" strings. */
function pixels(raster: ArrayLike<number>, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < raster.length; i++) if (raster[i]) out.push(`${i % width},${Math.floor(i / width)}`);
  return out;
}

const GRID = { height: 10, width: 10, scale: [1, 1] as [number, number], offset: [0, 0] as [number, number] };

describe("polygonRaster", () => {
  it("fills pixels whose centers are inside the polygon", () => {
    const r = polygonRaster(square(2, 3, 5, 5), GRID);
    expect(pixels(r, 10).sort()).toEqual(
      ["2,3", "3,3", "4,3", "2,4", "3,4", "4,4"].sort(),
    );
  });

  it("maps the polygon into a scaled, offset mask grid", () => {
    // Half-resolution grid placed at (100, 50): source (104, 54)-(108, 58)
    // is mask pixels (2, 2)-(4, 4).
    const grid = { height: 10, width: 10, scale: [0.5, 0.5] as [number, number], offset: [100, 50] as [number, number] };
    const r = polygonRaster(square(104, 54, 108, 58), grid);
    expect(pixels(r, 10).sort()).toEqual(["2,2", "3,2", "2,3", "3,3"].sort());
  });

  it("clips to the grid and is empty when entirely outside it", () => {
    expect(isEmptyRaster(polygonRaster(square(20, 20, 30, 30), GRID))).toBe(true);
    expect(pixels(polygonRaster(square(-5, -5, 1, 1), GRID), 10)).toEqual(["0,0"]);
  });
});

describe("combineRasters", () => {
  const a = Uint8Array.from([1, 1, 0, 0]);
  const b = Uint8Array.from([0, 1, 1, 0]);
  it("adds (union) and cuts (difference) into a new array", () => {
    expect(Array.from(combineRasters(a, b, "add"))).toEqual([1, 1, 1, 0]);
    const cut = combineRasters(a, b, "cut");
    expect(Array.from(cut)).toEqual([1, 0, 0, 0]);
    expect(cut).not.toBe(a);
  });
});

describe("hit-testing masks", () => {
  const lower = UserSegmentationMask.fromArray(polygonRaster(square(0, 0, 6, 6), GRID), 10, 10);
  const upper = UserSegmentationMask.fromArray(polygonRaster(square(4, 4, 10, 10), GRID), 10, 10);
  const half = UserSegmentationMask.fromArray(Uint8Array.from([0, 0, 0, 1]), 2, 2, {
    scale: [0.5, 0.5],
    offset: [20, 20],
  });

  it("maskContains honors scale and offset", () => {
    expect(maskContains(half, 22.5, 22.5)).toBe(true);
    expect(maskContains(half, 21, 21)).toBe(false);
    expect(maskContains(half, 30, 30)).toBe(false);
  });

  it("the topmost (last) mask wins where masks overlap, unless the selected one covers the point", () => {
    expect(maskIndexAt([lower, upper], 5, 5)).toBe(1);
    expect(maskIndexAt([lower, upper], 5, 5, 0)).toBe(0);
    expect(maskIndexAt([lower, upper], 1, 1, 1)).toBe(0);
    expect(maskIndexAt([lower, upper], 9.5, 0.5)).toBeNull();
  });
});

describe("drawing helpers", () => {
  it("pointInPolygon", () => {
    const tri: Pt[] = [[0, 0], [10, 0], [0, 10]];
    expect(pointInPolygon(2, 2, tri)).toBe(true);
    expect(pointInPolygon(8, 8, tri)).toBe(false);
  });

  it("closes only near the first point, once there are three points", () => {
    expect(closesPolygon([[0, 0], [10, 0]], [0, 1], 5)).toBe(false);
    expect(closesPolygon([[0, 0], [10, 0], [10, 10]], [1, 1], 5)).toBe(true);
    expect(closesPolygon([[0, 0], [10, 0], [10, 10]], [9, 9], 5)).toBe(false);
  });

  it("dedupePolygon drops the extra point a double-click adds", () => {
    expect(dedupePolygon([[0, 0], [5, 5], [5.1, 5], [9, 0]], 0.5)).toEqual([[0, 0], [5, 5], [9, 0]]);
  });

  it("links to an instance when most of its visible points are inside", () => {
    const sk = new Skeleton({ nodes: ["a", "b", "c", "d", "e"], name: "s" });
    const poly = square(0, 0, 10, 10);
    expect(instanceInsidePolygon(Instance.fromArray([[1, 1], [2, 2], [3, 3], [4, 4], [50, 50]], sk), poly)).toBe(true);
    expect(instanceInsidePolygon(Instance.fromArray([[1, 1], [2, 2], [50, 50], [50, 50], [N, N]], sk), poly)).toBe(false);
  });
});

describe("polygonAction (follows labelroi: each polygon its own mask)", () => {
  it("is a new mask by default, whether or not a mask is selected", () => {
    expect(polygonAction({ cut: false, add: false }, null)).toEqual({ kind: "new" });
    expect(polygonAction({ cut: false, add: false }, 2)).toEqual({ kind: "new" });
  });
  it("Shift adds to the selected mask (a new mask with nothing selected)", () => {
    expect(polygonAction({ cut: false, add: true }, 2)).toEqual({ kind: "edit", op: "add", index: 2 });
    expect(polygonAction({ cut: false, add: true }, null)).toEqual({ kind: "new" });
  });
  it("Alt cuts from the selected mask, and needs one", () => {
    expect(polygonAction({ cut: true, add: false }, 1)).toEqual({ kind: "edit", op: "cut", index: 1 });
    expect(polygonAction({ cut: true, add: true }, 1)).toEqual({ kind: "edit", op: "cut", index: 1 });
    expect(polygonAction({ cut: true, add: false }, null)).toEqual({ kind: "needsSelection" });
  });
});

describe("mask commands", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  function setup(withFrame = true) {
    const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = new Video({
      filename: "/v/main.mp4",
      backendMetadata: { shape: [10, 40, 50, 3] },
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

  it("AddMaskPolygon adds a user mask on the frame's grid, links the instance and its track, leaves nothing selected", async () => {
    const { lf, inst, track } = setup();
    await ctx.execute(AddMaskPolygon, { points: square(5, 5, 25, 25), height: 40, width: 50, instance: inst });
    expect(lf.masks).toHaveLength(1);
    const m = lf.masks[0];
    expect(m).toBeInstanceOf(UserSegmentationMask);
    expect([m.height, m.width]).toEqual([40, 50]);
    expect(m.area).toBe(400);
    expect(m.instance).toBe(inst);
    expect(m.track).toBe(track);
    expect(m.source).toBe("polygon");
    expect(useAppStore.getState().selectedMaskIdx).toBeNull();
    expect(useAppStore.getState().hasChanges).toBe(true);
    expect(ctx.undo()).toBe(true);
    expect(lf.masks).toHaveLength(0);
  });

  it("AddMaskPolygon places the grid at the given offset (a cropped video's origin)", async () => {
    const { lf } = setup();
    await ctx.execute(AddMaskPolygon, { points: square(105, 205, 115, 215), height: 40, width: 50, offset: [100, 200] });
    const m = lf.masks[0];
    expect(m.offset).toEqual([100, 200]);
    expect(m.bbox).toEqual({ x: 105, y: 205, width: 10, height: 10 });
  });

  it("AddMaskPolygon creates the frame on an unlabeled frame, and ignores a polygon that fills nothing", async () => {
    const { labels } = setup(false);
    await ctx.execute(AddMaskPolygon, { points: [[1, 1], [1.2, 1], [1.1, 1.05]], height: 40, width: 50 });
    expect(labels.labeledFrames).toHaveLength(0);
    await ctx.execute(AddMaskPolygon, { points: square(0, 0, 4, 4), height: 40, width: 50 });
    expect(labels.labeledFrames).toHaveLength(1);
    expect(labels.labeledFrames[0].masks).toHaveLength(1);
  });

  it("EditMaskPolygon adds and cuts with a new rleCounts array; undo restores the old raster", async () => {
    const { lf } = setup();
    await ctx.execute(AddMaskPolygon, { points: square(0, 0, 10, 10), height: 40, width: 50 });
    const before = lf.masks[0].rleCounts;
    await ctx.execute(EditMaskPolygon, { index: 0, points: square(10, 0, 20, 10), op: "add" });
    expect(lf.masks[0].area).toBe(200);
    expect(lf.masks[0].rleCounts).not.toBe(before);
    await ctx.execute(EditMaskPolygon, { index: 0, points: square(0, 0, 5, 10), op: "cut" });
    expect(lf.masks[0].area).toBe(150);
    expect(ctx.undo()).toBe(true);
    expect(lf.masks[0].area).toBe(200);
    expect(ctx.undo()).toBe(true);
    expect(lf.masks[0].area).toBe(100);
  });

  it("cutting a mask down to nothing deletes it", async () => {
    const { lf } = setup();
    await ctx.execute(AddMaskPolygon, { points: square(0, 0, 10, 10), height: 40, width: 50 });
    await ctx.execute(EditMaskPolygon, { index: 0, points: square(-1, -1, 11, 11), op: "cut" });
    expect(lf.masks).toHaveLength(0);
    expect(useAppStore.getState().selectedMaskIdx).toBeNull();
  });

  it("editing a predicted mask replaces it with a user mask", async () => {
    const { lf, track } = setup();
    lf.masks.push(
      new PredictedSegmentationMask({
        rleCounts: encodeRle(polygonRaster(square(0, 0, 10, 10), { ...GRID, height: 40, width: 50 }), 40, 50),
        height: 40,
        width: 50,
        score: 0.7,
        track,
      }),
    );
    await ctx.execute(EditMaskPolygon, { index: 0, points: square(10, 0, 20, 10), op: "add" });
    const m = lf.masks[0];
    expect(m).toBeInstanceOf(UserSegmentationMask);
    expect(m.track).toBe(track);
    expect(m.area).toBe(200);
  });

  it("DeleteMask removes the mask and undo brings it back", async () => {
    const { lf } = setup();
    await ctx.execute(AddMaskPolygon, { points: square(0, 0, 10, 10), height: 40, width: 50 });
    await ctx.execute(DeleteMask, { index: 0 });
    expect(lf.masks).toHaveLength(0);
    expect(ctx.undo()).toBe(true);
    expect(lf.masks).toHaveLength(1);
    expect(lf.masks[0].area).toBe(100);
  });

  it("bad params are no-ops", async () => {
    const { lf } = setup();
    await ctx.execute(AddMaskPolygon, { points: [[0, 0], [1, 1]], height: 40, width: 50 });
    await ctx.execute(EditMaskPolygon, { index: 3, points: square(0, 0, 5, 5), op: "add" });
    await ctx.execute(DeleteMask, { index: 0 });
    expect(lf.masks).toHaveLength(0);
  });

  it("mask commands are frame-level edits for the incremental autosave", async () => {
    setup();
    for (const name of ["AddMaskPolygon", "EditMaskPolygon", "DeleteMask"]) {
      const snap = ctx.takeSnapshot(name);
      expect(classifyDirty(snap).kind).toBe("frames");
    }
  });
});

describe("polygon tool shortcut", () => {
  it("L toggles the polygon tool", () => {
    expect(DEFAULT_SHORTCUTS["polygon tool"]).toBe("KeyL");
  });
});
