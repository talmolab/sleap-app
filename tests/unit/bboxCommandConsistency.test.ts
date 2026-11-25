/**
 * Commands that delete predictions, remove or convert instances, or change
 * tracks also handle bounding boxes: predicted boxes are deleted with the same
 * scope as predictions, box→instance links follow converted instances or are
 * cleared, and box tracks follow their instances and deleted tracks.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Instance,
  Labels,
  LabeledFrame,
  PredictedBoundingBox,
  PredictedInstance,
  Skeleton,
  Track,
  UserBoundingBox,
  Video,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import {
  ConvertPredictionToInstance,
  DeleteAllPredictions,
  DeleteFramePredictions,
  DeleteSelectedInstance,
} from "@/commands/editCommands";
import {
  DeleteInstancesByType,
  DeletePredictionsByScore,
  DeletePredictionsByTrack,
  DeletePredictionsFromClip,
} from "@/commands/fileCommands";
import {
  DeleteAllTracks,
  DeleteTrack,
  DeleteUnusedTracks,
  SetInstanceTrack,
  TransposeInstances,
} from "@/commands/trackCommands";
import { AcceptBbox } from "@/commands/bboxCommands";
import { boxesInArea, boxesOnUserLabeledFrames } from "@/lib/predictionDeletion";
import { useAppStore } from "@/stores/appStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const skeleton = new Skeleton({ nodes: ["a", "b"] });

function pred(x: number, score = 0.9, track: Track | null = null): PredictedInstance {
  const p = new PredictedInstance({ points: { a: [x, 0], b: [x + 5, 5] }, skeleton, score });
  p.track = track;
  return p;
}
function user(x: number, track: Track | null = null): Instance {
  const u = Instance.fromArray([[x, 0], [x + 5, 5]], skeleton);
  u.track = track;
  return u;
}
const pbox = (x: number, score = 0.9, extra: Record<string, unknown> = {}) =>
  new PredictedBoundingBox({ x1: x, y1: 0, x2: x + 10, y2: 10, score, ...extra });
const ubox = (x: number, extra: Record<string, unknown> = {}) =>
  new UserBoundingBox({ x1: x, y1: 0, x2: x + 10, y2: 10, ...extra });

function setup(frames: LabeledFrame[], video: Video, tracks: Track[] = []) {
  const labels = new Labels({ labeledFrames: frames, skeletons: [skeleton], videos: [video], tracks });
  const store = useAppStore.getState();
  store.setLabels(labels, "t.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setLabeledFrame(labels.find({ video, frameIdx: 0 })[0] ?? null);
  return labels;
}

function newVideo(): Video {
  return new Video({ filename: "/v/a.mp4", backendMetadata: { shape: [100, 64, 64, 1] }, openBackend: false });
}

let ctx: CommandContext;
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  ctx = new CommandContext();
});

describe("deleting predictions also deletes predicted boxes", () => {
  it("Delete All Predictions removes predicted boxes (a box detector's output) and keeps user boxes; undo restores", async () => {
    const video = newVideo();
    const lf0 = new LabeledFrame({ video, frameIdx: 0, bboxes: [pbox(0), ubox(20)] });
    const lf1 = new LabeledFrame({ video, frameIdx: 1, bboxes: [pbox(0)] });
    const labels = setup([lf0, lf1], video);
    await ctx.execute(DeleteAllPredictions);
    expect(labels.find({ video, frameIdx: 0 })[0].bboxes.map((b) => b.isPredicted)).toEqual([false]);
    expect(labels.find({ video, frameIdx: 1 })).toHaveLength(0);
    expect(ctx.undo()).toBe(true);
    expect(labels.find({ video, frameIdx: 1 })[0].bboxes).toHaveLength(1);
  });

  it("Delete Frame Predictions removes the frame's predicted boxes and keeps showing its user boxes", async () => {
    const video = newVideo();
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [pred(0)], bboxes: [pbox(0), ubox(20)] });
    setup([lf], video);
    await ctx.execute(DeleteFramePredictions);
    expect(lf.instances).toHaveLength(0);
    expect(lf.bboxes.map((b) => b.isPredicted)).toEqual([false]);
    expect(useAppStore.getState().labeledFrame).toBe(lf);
  });

  it("scoped deletes use the same scope for boxes: score, clip, track", async () => {
    const video = newVideo();
    const t = new Track("A");
    const frames = [0, 1, 2, 3].map(
      (i) => new LabeledFrame({ video, frameIdx: i, bboxes: [pbox(0, i === 0 ? 0.1 : 0.9, { track: i === 3 ? t : null })] }),
    );
    const labels = setup(frames, video, [t]);
    await ctx.execute(DeletePredictionsByScore, { threshold: 0.5 });
    expect(labels.find({ video, frameIdx: 0 })).toHaveLength(0);
    expect(labels.find({ video, frameIdx: 1 })).toHaveLength(1);
    await ctx.execute(DeletePredictionsFromClip, { startFrame: 1, endFrame: 1 });
    expect(labels.find({ video, frameIdx: 1 })).toHaveLength(0);
    await ctx.execute(DeletePredictionsByTrack, { trackName: "A" });
    expect(labels.find({ video, frameIdx: 3 })).toHaveLength(0);
    expect(labels.find({ video, frameIdx: 2 })).toHaveLength(1);
  });

  it("Delete by type: predicted removes predicted boxes; user keeps every box", async () => {
    const video = newVideo();
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [user(0), pred(10)], bboxes: [pbox(0), ubox(20)] });
    setup([lf], video);
    await ctx.execute(DeleteInstancesByType, { instanceType: "user" });
    expect(lf.bboxes).toHaveLength(2);
    await ctx.execute(DeleteInstancesByType, { instanceType: "predicted" });
    expect(lf.bboxes.map((b) => b.isPredicted)).toEqual([false]);
  });

  it("area and user-labeled-frame box selectors", () => {
    const video = newVideo();
    const u = user(0);
    const p = pred(0);
    u.fromPredicted = p;
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [u],
      bboxes: [pbox(0, 0.9, { instance: p }), pbox(40)],
    });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [skeleton], videos: [video] });
    expect(boxesInArea(labels, video, { x1: -1, y1: -1, x2: 11, y2: 11 }).map(([, b]) => b.x1)).toEqual([0]);
    // unlinkedOnly keeps the box of the labeled animal.
    expect(boxesOnUserLabeledFrames(labels, video, true).map(([, b]) => b.x1)).toEqual([40]);
    expect(boxesOnUserLabeledFrames(labels, video, false)).toHaveLength(2);
  });
});

describe("box → instance links", () => {
  it("converting a prediction moves its box's link to the new user instance; accepting the box keeps it", async () => {
    const video = newVideo();
    const p = pred(0);
    const box = pbox(0, 0.9, { instance: p });
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [p], bboxes: [box] });
    setup([lf], video);
    await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });
    const converted = lf.instances[0];
    expect(converted).not.toBeInstanceOf(PredictedInstance);
    expect(lf.bboxes[0].instance).toBe(converted);
    await ctx.execute(AcceptBbox, { index: 0 });
    expect(lf.bboxes[0].isPredicted).toBe(false);
    expect(lf.bboxes[0].instance).toBe(converted);
  });

  it("deleting an instance clears links to it", async () => {
    const video = newVideo();
    const u = user(0);
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [u], bboxes: [ubox(0, { instance: u })] });
    setup([lf], video);
    useAppStore.getState().setInstance(u);
    await ctx.execute(DeleteSelectedInstance);
    expect(lf.bboxes[0].instance).toBeNull();
    expect(useAppStore.getState().labeledFrame).toBe(lf); // still shows the box
  });
});

describe("box tracks", () => {
  it("Delete Track / Delete All Tracks clear box tracks; Delete Unused Tracks keeps tracks boxes use", async () => {
    const video = newVideo();
    const a = new Track("A");
    const b = new Track("B");
    const c = new Track("C");
    const lf = new LabeledFrame({ video, frameIdx: 0, bboxes: [ubox(0, { track: a }), ubox(20, { track: b })] });
    const labels = setup([lf], video, [a, b, c]);
    await ctx.execute(DeleteUnusedTracks);
    expect(labels.tracks.map((t) => t.name)).toEqual(["A", "B"]);
    await ctx.execute(DeleteTrack, { track: a });
    expect(lf.bboxes[0].track).toBeNull();
    expect(lf.bboxes[1].track).toBe(b);
    await ctx.execute(DeleteAllTracks);
    expect(lf.bboxes[1].track).toBeNull();
  });

  it("Set Instance Track and Transpose move linked boxes with their instances", async () => {
    const video = newVideo();
    const a = new Track("A");
    const b = new Track("B");
    const u1 = user(0, a);
    const u2 = user(20, b);
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [u1, u2],
      bboxes: [ubox(0, { instance: u1, track: a }), ubox(20, { instance: u2, track: b })],
    });
    setup([lf], video, [a, b]);
    await ctx.execute(TransposeInstances);
    expect([lf.bboxes[0].track, lf.bboxes[1].track]).toEqual([b, a]);
    useAppStore.getState().setInstance(u1);
    // Mutual exclusivity: u2 (on A) loses A, and so does its box.
    await ctx.execute(SetInstanceTrack, { trackIdx: 0 });
    expect([lf.bboxes[0].track, lf.bboxes[1].track]).toEqual([a, null]);
  });
});
