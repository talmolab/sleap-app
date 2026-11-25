/**
 * Segmentation masks, part 1 (#155): drawing placement and colors, and keeping
 * `LabeledFrame.masks` through the autosave journal.
 */
import { describe, it, expect } from "../bun-test";
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
import {
  buildRenderedMasks,
  maskCaption,
  maskColor,
  rasterBounds,
} from "@/canvas/MaskRenderer";
import { UNCOLORED_PREDICTED_NODE_COLOR } from "@/canvas/SkeletonRenderer";
import { getPaletteColor, getTrackColor } from "@/lib/colorPalettes";
import {
  applyDeltas,
  buildBaseIndex,
  encodeFrameDelta,
  type FrameDelta,
} from "@/lib/autosaveJournal";
import { frameHasAdvancedInstanceFields } from "@/lib/incrementalAutosave";

const RED: [number, number, number] = [255, 0, 0];

/** An 8x8 raster with a 3x2 block at rows 2-3, cols 4-6. */
function blockRaster(): Uint8Array {
  const r = new Uint8Array(64);
  for (let y = 2; y <= 3; y++) for (let x = 4; x <= 6; x++) r[y * 8 + x] = 1;
  return r;
}

function predictedMask(score = 0.8): PredictedSegmentationMask {
  return new PredictedSegmentationMask({
    rleCounts: encodeRle(blockRaster(), 8, 8),
    height: 8,
    width: 8,
    score,
  });
}

/**
 * Frame 0: a tracked instance; a predicted mask; its accepted user copy linked
 * to the instance, at half resolution with an offset, with a category.
 */
function setup() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [10, 480, 640, 3] },
    openBackend: false,
  });
  const track = new Track("mouse");
  const inst = Instance.fromArray([[10, 20], [30, 60]], sk);
  inst.track = track;
  const pred = predictedMask(0.75);
  const user = UserSegmentationMask.fromArray(blockRaster(), 8, 8, {
    category: "mouse",
    name: "m1",
    source: "brush",
    track,
    instance: inst,
    scale: [0.5, 0.5],
    offset: [100, 50],
  });
  user.fromPredicted = pred;
  const lf0 = new LabeledFrame({ video, frameIdx: 0, instances: [inst], masks: [pred, user] });
  const labels = new Labels({
    labeledFrames: [lf0],
    skeletons: [sk],
    videos: [video],
    tracks: [track],
  });
  return { labels, lf0, inst, pred, user, track };
}

describe("buildRenderedMasks", () => {
  it("places each mask by offset (through toImage) and scale, and reads label and score", () => {
    const { pred, user } = setup();
    const out = buildRenderedMasks([pred, user], {
      toImage: (x, y) => [x - 10, y - 20],
      colorFor: () => RED,
      selected: user,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      index: 0,
      isPredicted: true,
      score: 0.75,
      label: null,
      origin: [-10, -20],
      pixelSize: [1, 1],
      isSelected: false,
    });
    expect(out[1]).toMatchObject({
      index: 1,
      isPredicted: false,
      score: undefined,
      label: "mouse",
      origin: [90, 30],
      pixelSize: [2, 2],
      isSelected: true,
    });
  });

  it("skips masks with no foreground pixels", () => {
    const empty = UserSegmentationMask.fromArray(new Uint8Array(16), 4, 4);
    const { user } = setup();
    const out = buildRenderedMasks([empty, user], { toImage: (x, y) => [x, y], colorFor: () => RED });
    expect(out.map((m) => m.index)).toEqual([1]);
  });

  it("labels fall back from category to name to track", () => {
    const { track } = setup();
    const named = UserSegmentationMask.fromArray(blockRaster(), 8, 8, { name: "blob" });
    const tracked = UserSegmentationMask.fromArray(blockRaster(), 8, 8, { track });
    const out = buildRenderedMasks([named, tracked], { toImage: (x, y) => [x, y], colorFor: () => RED });
    expect(out.map((m) => m.label)).toEqual(["blob", "mouse"]);
  });

  it("captions combine label and score", () => {
    expect(maskCaption({ label: "mouse", score: 0.756 })).toBe("mouse 0.76");
    expect(maskCaption({ label: null, score: 0.5 })).toBe("0.50");
    expect(maskCaption({ label: "mouse", score: undefined })).toBe("mouse");
    expect(maskCaption({ label: null, score: undefined })).toBeNull();
  });
});

describe("maskColor", () => {
  const base = {
    index: 2,
    isPredicted: false,
    colorPredicted: true,
    colorTarget: "track",
    linkedInstanceColor: null,
    track: null,
    tracks: [] as unknown[],
    palette: "standard",
    trackColorOverrides: null,
  };

  it("uses the palette color for the mask's position when untracked", () => {
    expect(maskColor(base)).toEqual(getPaletteColor("standard", 2));
  });

  it("uses the track color when tracked", () => {
    const t = new Track("a");
    const other = new Track("b");
    expect(maskColor({ ...base, track: t, tracks: [other, t] })).toEqual(
      getTrackColor("standard", 1, "a", null),
    );
  });

  it("uses the linked instance color when coloring by instance", () => {
    expect(maskColor({ ...base, colorTarget: "instance", linkedInstanceColor: RED })).toEqual(RED);
  });

  it("is yellow for a predicted mask with Color predicted off", () => {
    expect(maskColor({ ...base, isPredicted: true, colorPredicted: false })).toEqual(
      UNCOLORED_PREDICTED_NODE_COLOR,
    );
  });
});

describe("rasterBounds", () => {
  it("returns the inclusive foreground bounds, or null when empty", () => {
    expect(rasterBounds(blockRaster(), 8, 8)).toEqual([4, 2, 6, 3]);
    expect(rasterBounds(new Uint8Array(64), 8, 8)).toBeNull();
  });
});

describe("autosave journal keeps masks", () => {
  it("round-trips raster, links, metadata, scale/offset and fromPredicted", () => {
    const { labels, lf0 } = setup();
    const delta = JSON.parse(
      JSON.stringify(encodeFrameDelta(lf0, buildBaseIndex(labels))),
    ) as FrameDelta;
    expect(delta.mk).toHaveLength(2);

    // Replay onto a frame that lost its masks.
    lf0.masks = [];
    applyDeltas(labels, [delta]);
    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(lf.masks).toHaveLength(2);
    const [p, u] = lf.masks;
    expect(p).toBeInstanceOf(PredictedSegmentationMask);
    expect((p as PredictedSegmentationMask).score).toBe(0.75);
    expect(Array.from(p.data)).toEqual(Array.from(blockRaster()));
    expect(u).toBeInstanceOf(UserSegmentationMask);
    expect(Array.from(u.data)).toEqual(Array.from(blockRaster()));
    expect(u.track).toBe(labels.tracks[0]);
    expect(u.instance).toBe(lf.instances[0]);
    expect([u.category, u.name, u.source]).toEqual(["mouse", "m1", "brush"]);
    expect(u.scale).toEqual([0.5, 0.5]);
    expect(u.offset).toEqual([100, 50]);
    expect((u as UserSegmentationMask).fromPredicted).toBe(p as PredictedSegmentationMask);
  });

  it("re-links masks to the replayed instances, not the base frame's old ones", () => {
    const { labels, lf0, inst } = setup();
    const delta = encodeFrameDelta(lf0, buildBaseIndex(labels));
    applyDeltas(labels, [delta]);
    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(lf.instances[0]).not.toBe(inst); // instances are rebuilt on replay
    expect(lf.masks[1].instance).toBe(lf.instances[0]);
  });

  it("a delta written before masks were recorded leaves the masks alone", () => {
    const { labels, lf0, pred, user } = setup();
    const delta = encodeFrameDelta(lf0, buildBaseIndex(labels));
    delete delta.mk;
    applyDeltas(labels, [delta]);
    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(lf.masks).toEqual([pred, user]);
  });

  it("escalates to a full snapshot for mask fields the delta can't hold", () => {
    const { lf0, pred } = setup();
    expect(frameHasAdvancedInstanceFields(lf0)).toBe(false);
    pred.scoreMap = new Float32Array(64);
    expect(frameHasAdvancedInstanceFields(lf0)).toBe(true);
  });
});
