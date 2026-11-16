/**
 * Bounding boxes, part 1: drawing geometry, and keeping `LabeledFrame.bboxes`
 * through undo/redo, the autosave journal, and save → reopen (#488).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
  UserBoundingBox,
  PredictedBoundingBox,
  UserCentroid,
  saveSlpToBytes,
  loadSlp,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { DeleteSelectedInstance } from "@/commands/editCommands";
import { DeletePredictionsOnLabeledFrames } from "@/commands/fileCommands";
import { useAppStore } from "@/stores/appStore";
import {
  buildRenderedBboxes,
  bboxCaption,
  isEmptyBbox,
} from "@/canvas/BboxRenderer";
import {
  applyDeltas,
  buildBaseIndex,
  encodeFrameDelta,
  type FrameDelta,
} from "@/lib/autosaveJournal";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const N = Number.NaN;
const RED: [number, number, number] = [255, 0, 0];

function makeVideo() {
  return new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [10, 480, 640, 3] },
    openBackend: false,
  });
}

/**
 * Frame 0: a user instance with a linked user box, a prediction with a
 * predicted box, and a user centroid. Frame 1: one more prediction.
 */
function setup() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = makeVideo();
  const track = new Track("mouse");
  const user = Instance.fromArray([[10, 20], [30, 60]], sk);
  user.track = track;
  const pred = PredictedInstance.fromArray([[100, 100], [140, 120]], sk, 0.8);
  const userBox = new UserBoundingBox({
    x1: 5, y1: 15, x2: 35, y2: 65, track, instance: user, category: "mouse",
  });
  const predBox = new PredictedBoundingBox({
    x1: 95, y1: 95, x2: 145, y2: 125, score: 0.9, instance: pred,
  });
  const centroid = new UserCentroid({ x: 20, y: 40, instance: user });
  const lf0 = new LabeledFrame({
    video,
    frameIdx: 0,
    instances: [user, pred],
    bboxes: [userBox, predBox],
    centroids: [centroid],
  });
  const lf1 = new LabeledFrame({
    video,
    frameIdx: 1,
    instances: [PredictedInstance.fromArray([[1, 1], [2, 2]], sk, 0.5)],
  });
  const labels = new Labels({
    labeledFrames: [lf0, lf1],
    skeletons: [sk],
    videos: [video],
    tracks: [track],
  });
  const store = useAppStore.getState();
  store.setLabels(labels, "test.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setLabeledFrame(lf0);
  return { labels, lf0, video, sk, track, user, pred, userBox, predBox };
}

describe("buildRenderedBboxes", () => {
  const color = () => RED;

  it("maps corners through toImage and reads class, score and label", () => {
    const { userBox, predBox, track } = setup();
    const out = buildRenderedBboxes([userBox, predBox], {
      toImage: (x, y) => [x - 5, y - 15],
      colorFor: color,
      selected: predBox,
    });
    expect(out.map((b) => b.index)).toEqual([0, 1]);
    expect(out[0].corners).toEqual([[0, 0], [30, 0], [30, 50], [0, 50]]);
    expect(out[0].isPredicted).toBe(false);
    expect(out[0].score).toBeUndefined();
    expect(out[0].label).toBe("mouse");
    expect(out[0].isSelected).toBe(false);
    expect(out[1].isPredicted).toBe(true);
    expect(out[1].score).toBe(0.9);
    expect(out[1].isSelected).toBe(true);
    // No category → falls back to the track name, else nothing.
    userBox.category = "";
    expect(
      buildRenderedBboxes([userBox], { toImage: (x, y) => [x, y], colorFor: color })[0].label,
    ).toBe(track.name);
  });

  it("skips empty boxes and keeps rotated corners", () => {
    const empty = new UserBoundingBox({ x1: N, y1: 0, x2: 1, y2: 1 });
    const rotated = new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10, angle: Math.PI / 4 });
    expect(isEmptyBbox(empty)).toBe(true);
    const out = buildRenderedBboxes([empty, rotated], {
      toImage: (x, y) => [x, y],
      colorFor: color,
    });
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(1);
    expect(out[0].isRotated).toBe(true);
    // A square rotated 45° about (5, 5): its top corner sits straight above the center.
    const top = out[0].corners.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(top[0]).toBeCloseTo(5);
    expect(top[1]).toBeCloseTo(5 - Math.SQRT2 * 5);
  });

  it("captions combine label and score", () => {
    const base = { index: 0, corners: [], color: RED, isPredicted: true, isRotated: false, isSelected: false };
    expect(bboxCaption({ ...base, label: "fly", score: 0.876 })).toBe("fly 0.88");
    expect(bboxCaption({ ...base, label: null, score: 0.5 })).toBe("0.50");
    expect(bboxCaption({ ...base, label: "fly" })).toBe("fly");
    expect(bboxCaption({ ...base, label: null })).toBeNull();
  });
});

describe("undo keeps bounding boxes", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("multi-frame undo (Delete Predictions on labeled frames) restores boxes and centroids", async () => {
    const { labels, video } = setup();
    await ctx.execute(DeletePredictionsOnLabeledFrames);
    expect(ctx.undo()).toBe(true);

    const lf = labels.find({ video, frameIdx: 0 })[0];
    expect(lf.instances).toHaveLength(2);
    expect(lf.bboxes).toHaveLength(2);
    expect(lf.centroids).toHaveLength(1);
    // Links follow the restored instances, not the pre-undo objects.
    expect(lf.bboxes[0].instance).toBe(lf.instances[0]);
    expect(lf.bboxes[1].instance).toBe(lf.instances[1]);
    expect(lf.centroids[0].instance).toBe(lf.instances[0]);
    expect(lf.bboxes[0]).toBeInstanceOf(UserBoundingBox);
    expect(lf.bboxes[1]).toBeInstanceOf(PredictedBoundingBox);
    expect((lf.bboxes[1] as PredictedBoundingBox).score).toBe(0.9);
    expect(lf.bboxes[0].xyxy).toEqual([5, 15, 35, 65]);
    expect(lf.bboxes[0].category).toBe("mouse");
  });

  it("single-frame undo and redo keep boxes", async () => {
    const { lf0, user } = setup();
    useAppStore.getState().setInstance(user);
    await ctx.execute(DeleteSelectedInstance);
    expect(lf0.instances).toHaveLength(1);
    expect(lf0.bboxes).toHaveLength(2);

    expect(ctx.undo()).toBe(true);
    expect(lf0.instances).toHaveLength(2);
    expect(lf0.bboxes).toHaveLength(2);
    expect(lf0.bboxes[0].instance).toBe(lf0.instances[0]);

    expect(ctx.redo()).toBe(true);
    expect(lf0.instances).toHaveLength(1);
    expect(lf0.bboxes).toHaveLength(2);
  });

  it("deleting the last instance keeps showing a frame that still has boxes", async () => {
    const { lf0, user, pred } = setup();
    lf0.instances = [user];
    void pred;
    useAppStore.getState().setInstance(user);
    await ctx.execute(DeleteSelectedInstance);
    expect(lf0.instances).toHaveLength(0);
    expect(useAppStore.getState().labeledFrame).toBe(lf0);
  });
});

describe("autosave journal keeps bounding boxes", () => {
  it("round-trips boxes with track, instance link, score and category", () => {
    const { labels, lf0 } = setup();
    const delta = JSON.parse(
      JSON.stringify(encodeFrameDelta(lf0, buildBaseIndex(labels))),
    ) as FrameDelta;
    expect(delta.bb).toHaveLength(2);

    // Replay onto a frame that lost its boxes.
    lf0.bboxes = [];
    applyDeltas(labels, [delta]);
    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(lf.bboxes).toHaveLength(2);
    const [u, p] = lf.bboxes;
    expect(u).toBeInstanceOf(UserBoundingBox);
    expect(u.xyxy).toEqual([5, 15, 35, 65]);
    expect(u.track).toBe(labels.tracks[0]);
    expect(u.instance).toBe(lf.instances[0]);
    expect(u.category).toBe("mouse");
    expect(p).toBeInstanceOf(PredictedBoundingBox);
    expect((p as PredictedBoundingBox).score).toBe(0.9);
    expect(p.instance).toBe(lf.instances[1]);
  });

  it("a delta written before boxes were recorded leaves the boxes alone", () => {
    const { labels, lf0 } = setup();
    const delta = encodeFrameDelta(lf0, buildBaseIndex(labels));
    delete delta.bb;
    applyDeltas(labels, [delta]);
    expect(labels.labeledFrames.find((f) => f.frameIdx === 0)!.bboxes).toHaveLength(2);
  });
});

describe("save → reopen keeps bounding boxes", () => {
  it("round-trips through the .slp writer", async () => {
    const { labels } = setup();
    const bytes = await saveSlpToBytes(labels);
    const reopened = await loadSlp(bytes, { openVideos: false });
    const lf = reopened.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(lf.bboxes).toHaveLength(2);
    expect(lf.bboxes[0].xyxy).toEqual([5, 15, 35, 65]);
    expect(lf.bboxes[0].instance).toBe(lf.instances[0]);
    expect((lf.bboxes[1] as PredictedBoundingBox).score).toBeCloseTo(0.9);
  });
});
