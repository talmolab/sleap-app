/**
 * Bounding boxes, part 3: reviewing predicted boxes and making boxes from
 * poses (#488). Each command is one undo step.
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
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import {
  AcceptAllBboxes,
  AcceptBbox,
  AcceptFrameBboxes,
  BboxesFromPoses,
  DeletePredictedBboxes,
  posesToBboxes,
  toUserBbox,
} from "@/commands/bboxCommands";
import { useAppStore } from "@/stores/appStore";
import { classifyDirty } from "@/lib/autosaveDirty";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const pbox = (x: number, score: number, extra: Record<string, unknown> = {}) =>
  new PredictedBoundingBox({ x1: x, y1: 0, x2: x + 10, y2: 10, score, ...extra });

/**
 * Frame 0: a user instance (track A), a prediction, and predicted boxes
 * scoring 0.9 / 0.4. Frame 5: one predicted box (0.2) and nothing else.
 */
function setup() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [10, 480, 640, 3] },
    openBackend: false,
  });
  const track = new Track("A");
  const user = Instance.fromArray([[10, 20], [30, 60]], sk);
  user.track = track;
  const pred = PredictedInstance.fromArray([[100, 100], [120, 130]], sk, 0.7);
  const lf0 = new LabeledFrame({
    video,
    frameIdx: 0,
    instances: [user, pred],
    bboxes: [pbox(0, 0.9, { category: "fly", track, instance: user }), pbox(50, 0.4)],
  });
  const lf5 = new LabeledFrame({ video, frameIdx: 5, bboxes: [pbox(0, 0.2)] });
  const labels = new Labels({
    labeledFrames: [lf0, lf5],
    skeletons: [sk],
    videos: [video],
    tracks: [track],
  });
  const store = useAppStore.getState();
  store.setLabels(labels, "t.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setLabeledFrame(lf0);
  return { labels, lf0, lf5, video, user, pred, track };
}

const kinds = (lf: LabeledFrame) => lf.bboxes.map((b) => (b instanceof PredictedBoundingBox ? "pred" : "user"));

describe("toUserBbox", () => {
  it("keeps geometry, angle and metadata, drops the score", () => {
    const track = new Track("t");
    const p = new PredictedBoundingBox({
      x1: 1, y1: 2, x2: 3, y2: 4, angle: 0.2, score: 0.5, track, trackingScore: 0.8,
      category: "c", name: "n", source: "s",
    });
    const u = toUserBbox(p);
    expect(u).toBeInstanceOf(UserBoundingBox);
    expect([u.x1, u.y1, u.x2, u.y2, u.angle]).toEqual([1, 2, 3, 4, 0.2]);
    expect(u.track).toBe(track);
    expect(u.trackingScore).toBe(0.8);
    expect([u.category, u.name, u.source]).toEqual(["c", "n", "s"]);
    expect("score" in u).toBe(false);
  });
});

describe("accepting predicted boxes", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("AcceptBbox turns one predicted box into a user box, keeping its link; undo reverts", async () => {
    const { lf0, user } = setup();
    await ctx.execute(AcceptBbox, { index: 0 });
    expect(kinds(lf0)).toEqual(["user", "pred"]);
    expect(lf0.bboxes[0].instance).toBe(user);
    expect(lf0.bboxes[0].category).toBe("fly");
    expect(ctx.undo()).toBe(true);
    expect(kinds(lf0)).toEqual(["pred", "pred"]);
  });

  it("AcceptFrameBboxes accepts boxes on this frame at or above the score", async () => {
    const { lf0, lf5 } = setup();
    await ctx.execute(AcceptFrameBboxes, { minScore: 0.5 });
    expect(kinds(lf0)).toEqual(["user", "pred"]);
    expect(kinds(lf5)).toEqual(["pred"]);
    await ctx.execute(AcceptFrameBboxes);
    expect(kinds(lf0)).toEqual(["user", "user"]);
  });

  it("AcceptAllBboxes works across frames as one undo step", async () => {
    const { labels, lf5 } = setup();
    await ctx.execute(AcceptAllBboxes, { minScore: 0.3 });
    const all = labels.labeledFrames.flatMap(kinds);
    expect(all).toEqual(["user", "user", "pred"]);
    expect(kinds(lf5)).toEqual(["pred"]);
    expect(ctx.undoCommandName).toBe("AcceptAllBboxes");
    expect(ctx.undo()).toBe(true);
    expect(labels.labeledFrames.flatMap(kinds)).toEqual(["pred", "pred", "pred"]);
  });

  it("AcceptAllBboxes with nothing to accept adds no undo step", async () => {
    setup();
    await ctx.execute(AcceptAllBboxes, { minScore: 2 });
    expect(ctx.undoCommandName).toBeNull();
  });
});

describe("DeletePredictedBboxes", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("deletes predicted boxes below the score, drops emptied frames, undo restores", async () => {
    const { labels, lf0, video } = setup();
    lf0.bboxes.push(new UserBoundingBox({ x1: 0, y1: 0, x2: 1, y2: 1 }));
    await ctx.execute(DeletePredictedBboxes, { maxScore: 0.5 });
    expect(kinds(lf0)).toEqual(["pred", "user"]);
    expect((lf0.bboxes[0] as PredictedBoundingBox).score).toBe(0.9);
    // Frame 5 held only a 0.2 box → gone.
    expect(labels.find({ video, frameIdx: 5 })).toHaveLength(0);
    expect(ctx.undo()).toBe(true);
    expect(labels.find({ video, frameIdx: 5 })[0].bboxes).toHaveLength(1);
  });

  it("with no score deletes every predicted box but never user boxes", async () => {
    const { lf0 } = setup();
    lf0.bboxes.push(new UserBoundingBox({ x1: 0, y1: 0, x2: 1, y2: 1 }));
    await ctx.execute(DeletePredictedBboxes, {});
    expect(kinds(lf0)).toEqual(["user"]);
  });
});

describe("Boxes from Poses", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("posesToBboxes pads each user instance, skips predictions and instances with a user box", () => {
    const { lf0, user, track } = setup();
    const add = posesToBboxes(lf0, 5);
    expect(add).toHaveLength(1);
    expect(add[0].xyxy).toEqual([5, 15, 35, 65]);
    expect(add[0].instance).toBe(user);
    expect(add[0].track).toBe(track);
    // Once the user has a linked *user* box, nothing more is added.
    lf0.bboxes.push(toUserBbox(lf0.bboxes[0]));
    expect(posesToBboxes(lf0, 5)).toHaveLength(0);
  });

  it("adds boxes on the current frame as one undo step (a frame-level edit)", async () => {
    const { lf0 } = setup();
    await ctx.execute(BboxesFromPoses, { padding: 2 });
    expect(lf0.bboxes).toHaveLength(3);
    expect(lf0.bboxes[2]).toBeInstanceOf(UserBoundingBox);
    expect(lf0.bboxes[2].xyxy).toEqual([8, 18, 32, 62]);
    expect(classifyDirty(ctx.takeSnapshot("BboxesFromPoses")).kind).toBe("frames");
    expect(ctx.undo()).toBe(true);
    expect(lf0.bboxes).toHaveLength(2);
  });

  it("project scope covers every frame", async () => {
    const { labels, video } = setup();
    const sk = labels.skeletons[0];
    const lf2 = new LabeledFrame({
      video,
      frameIdx: 2,
      instances: [Instance.fromArray([[0, 0], [4, 4]], sk)],
    });
    labels.append(lf2);
    await ctx.execute(BboxesFromPoses, { padding: 0, scope: "project" });
    expect(lf2.bboxes).toHaveLength(1);
    expect(lf2.bboxes[0].xyxy).toEqual([0, 0, 4, 4]);
    expect(ctx.undo()).toBe(true);
    expect(labels.find({ video, frameIdx: 2 })[0].bboxes).toHaveLength(0);
  });
});
