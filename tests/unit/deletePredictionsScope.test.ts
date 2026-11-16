/**
 * Delete Predictions commands match PyQt SLEAP's scope (#463).
 *
 * Every project here has two videos with predictions on the same frame
 * numbers, plus user instances and a negative frame, so each test can check
 * that a command touches only the video it should, never deletes a user
 * instance, and keeps negative frames.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import {
  DeletePredictionsByArea,
  DeletePredictionsByMaxCount,
  DeletePredictionsByRange,
  DeletePredictionsByScore,
  DeletePredictionsFromClip,
  DeletePredictionsOnLabeledFrames,
} from "@/commands/fileCommands";
import {
  predictionsBeyondMaxInstances,
  predictionsInArea,
  predictionsOnUserLabeledFrames,
} from "@/lib/predictionDeletion";
import {
  Instance,
  Labels,
  LabeledFrame,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });

function pred(points: number[][], score: number): PredictedInstance {
  const p = PredictedInstance.fromArray(points, skeleton);
  p.score = score;
  return p;
}

function user(points: number[][], fromPredicted?: PredictedInstance): Instance {
  const u = Instance.fromArray(points, skeleton);
  if (fromPredicted) u.fromPredicted = fromPredicted;
  return u;
}

function makeVideo(name: string): Video {
  return new Video({
    filename: name,
    backendMetadata: { shape: [10, 100, 100, 1] },
    openBackend: false,
  });
}

const NEG = 9; // the negative frame's index, in both videos

/**
 * Two videos laid out the same way, each with:
 * - frames 0..4: one prediction (score 0.1 * (frame + 1)) at (10,10)-(20,20)
 * - frame 5: two predictions (0.9 and 0.2) and a user instance
 * - frame 9: a negative frame (no instances)
 */
function setup() {
  const v1 = makeVideo("v1.mp4");
  const v2 = makeVideo("v2.mp4");
  const framesFor = (video: Video) => {
    const frames: LabeledFrame[] = [];
    for (let f = 0; f < 5; f++) {
      frames.push(
        new LabeledFrame({
          video,
          frameIdx: f,
          instances: [pred([[10, 10], [20, 20]], 0.1 * (f + 1))],
        }),
      );
    }
    frames.push(
      new LabeledFrame({
        video,
        frameIdx: 5,
        instances: [
          user([[50, 50], [60, 60]]),
          pred([[50, 50], [60, 60]], 0.9),
          pred([[70, 70], [80, 80]], 0.2),
        ],
      }),
    );
    frames.push(new LabeledFrame({ video, frameIdx: NEG, isNegative: true }));
    return frames;
  };
  const labels = new Labels({
    videos: [v1, v2],
    skeletons: [skeleton],
    labeledFrames: [...framesFor(v1), ...framesFor(v2)],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  // setLabels makes the first video current; that is the video under test.
  return { labels, v1, v2 };
}

const countPreds = (labels: Labels, video: Video) =>
  labels.labeledFrames
    .filter((lf) => lf.video === video)
    .reduce((n, lf) => n + lf.instances.filter((i) => i instanceof PredictedInstance).length, 0);

const countUsers = (labels: Labels) =>
  labels.labeledFrames.reduce(
    (n, lf) => n + lf.instances.filter((i) => !(i instanceof PredictedInstance)).length,
    0,
  );

const hasNegative = (labels: Labels, video: Video) =>
  labels.labeledFrames.some((lf) => lf.video === video && lf.frameIdx === NEG && lf.isNegative);

const predFrames = (labels: Labels, video: Video) =>
  labels.labeledFrames
    .filter((lf) => lf.video === video && lf.instances.some((i) => i instanceof PredictedInstance))
    .map((lf) => lf.frameIdx);

describe("Delete Predictions scope (#463)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  // Each video starts with 7 predictions (5 single + 2 on frame 5).
  const START = 7;

  describe("with low score", () => {
    // PyQt deletes low-score predictions in the current video only.
    it("deletes low scores in the current video only", async () => {
      const { labels, v1, v2 } = setup();
      await ctx.execute(DeletePredictionsByScore, { threshold: 0.35 });
      // v1: scores 0.1, 0.2, 0.3 (frames 0-2) and 0.2 (frame 5) go.
      expect(countPreds(labels, v1)).toBe(START - 4);
      expect(countPreds(labels, v2)).toBe(START);
    });

    // User instances and negative frames must survive any prediction delete.
    it("keeps user instances and negative frames", async () => {
      const { labels, v1 } = setup();
      await ctx.execute(DeletePredictionsByScore, { threshold: 2 });
      expect(countPreds(labels, v1)).toBe(0);
      expect(countUsers(labels)).toBe(2);
      expect(hasNegative(labels, v1)).toBe(true);
    });

    // Frames emptied by the delete are dropped, and undo brings them back.
    it("drops emptied frames, as one undo step", async () => {
      const { labels, v1 } = setup();
      const before = labels.labeledFrames.length;
      await ctx.execute(DeletePredictionsByScore, { threshold: 2 });
      expect(labels.labeledFrames.length).toBe(before - 5);
      ctx.undo();
      const restored = useAppStore.getState().labels!;
      expect(restored.labeledFrames.length).toBe(before);
      expect(countPreds(restored, v1)).toBe(START);
    });
  });

  describe("outside a frame range", () => {
    // PyQt's range is what to KEEP: predictions outside it go, current video only.
    it("keeps the range and deletes the rest of the current video", async () => {
      const { labels, v1, v2 } = setup();
      await ctx.execute(DeletePredictionsByRange, { startFrame: 1, endFrame: 3 });
      expect(predFrames(labels, v1)).toEqual([1, 2, 3]);
      expect(predFrames(labels, v2)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    // Frame 5 is outside the range: its predictions go, its user instance stays.
    it("keeps user instances and negative frames outside the range", async () => {
      const { labels, v1 } = setup();
      await ctx.execute(DeletePredictionsByRange, { startFrame: 0, endFrame: 2 });
      const f5 = labels.labeledFrames.find((lf) => lf.video === v1 && lf.frameIdx === 5);
      expect(f5?.instances.length).toBe(1);
      expect(f5?.instances[0] instanceof PredictedInstance).toBe(false);
      expect(hasNegative(labels, v1)).toBe(true);
    });

    // A range covering the whole video deletes nothing (and adds no undo step).
    it("deletes nothing when the range covers every frame", async () => {
      const { labels, v1 } = setup();
      await ctx.execute(DeletePredictionsByRange, { startFrame: 0, endFrame: 9 });
      expect(countPreds(labels, v1)).toBe(START);
      expect(ctx.canUndo).toBe(false);
    });
  });

  describe("from clip", () => {
    // PyQt's "Delete Predictions from Clip..." uses the seekbar selection, current video.
    it("deletes predictions in the selected clip of the current video", async () => {
      const { labels, v1, v2 } = setup();
      useAppStore.getState().set("frameRange", [2, 5]);
      await ctx.execute(DeletePredictionsFromClip);
      expect(predFrames(labels, v1)).toEqual([0, 1]);
      expect(predFrames(labels, v2)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(countUsers(labels)).toBe(2);
      expect(hasNegative(labels, v1)).toBe(true);
    });

    // Without a selection there is nothing to delete.
    it("does nothing without a clip selected", async () => {
      const { labels, v1 } = setup();
      await ctx.execute(DeletePredictionsFromClip);
      expect(countPreds(labels, v1)).toBe(START);
      expect(ctx.canUndo).toBe(false);
    });
  });

  describe("beyond max instances", () => {
    // PyQt keeps the top-N by score on each frame of the current video.
    it("keeps the top N per frame in the current video only", async () => {
      const { labels, v1, v2 } = setup();
      await ctx.execute(DeletePredictionsByMaxCount, { maxInstances: 1 });
      const f5 = labels.labeledFrames.find((lf) => lf.video === v1 && lf.frameIdx === 5)!;
      const left = f5.instances.filter((i) => i instanceof PredictedInstance) as PredictedInstance[];
      expect(left.map((p) => p.score)).toEqual([0.9]);
      expect(countPreds(labels, v1)).toBe(START - 1);
      expect(countPreds(labels, v2)).toBe(START);
    });

    // User instances don't count toward the maximum and are never removed.
    it("ignores user instances", async () => {
      const { labels } = setup();
      await ctx.execute(DeletePredictionsByMaxCount, { maxInstances: 1 });
      expect(countUsers(labels)).toBe(2);
    });

    // Equal scores: PyQt's stable ascending sort deletes the earlier one.
    it("breaks ties like PyQt", () => {
      const v = makeVideo("t.mp4");
      const first = pred([[1, 1], [2, 2]], 0.5);
      const second = pred([[3, 3], [4, 4]], 0.5);
      const labels = new Labels({
        videos: [v],
        skeletons: [skeleton],
        labeledFrames: [new LabeledFrame({ video: v, frameIdx: 0, instances: [first, second] })],
      });
      const pairs = predictionsBeyondMaxInstances(labels, v, 1);
      expect(pairs.map(([, p]) => p)).toEqual([first]);
    });
  });

  describe("from area", () => {
    // PyQt applies the box to every frame of the current video, not just this one.
    it("deletes matching predictions on every frame of the current video", async () => {
      const { labels, v1, v2 } = setup();
      await ctx.execute(DeletePredictionsByArea, { x1: 5, y1: 5, x2: 25, y2: 25 });
      expect(predFrames(labels, v1)).toEqual([5]);
      expect(countPreds(labels, v2)).toBe(START);
    });

    // All points must be inside: a box around only one node keeps the prediction.
    it("keeps predictions with a point outside the box", async () => {
      const { labels, v1 } = setup();
      await ctx.execute(DeletePredictionsByArea, { x1: 5, y1: 5, x2: 15, y2: 15 });
      expect(countPreds(labels, v1)).toBe(START);
    });

    // A user instance inside the box stays; so does the negative frame.
    it("keeps user instances and negative frames", async () => {
      const { labels, v1 } = setup();
      await ctx.execute(DeletePredictionsByArea, { x1: 0, y1: 0, x2: 100, y2: 100 });
      expect(countPreds(labels, v1)).toBe(0);
      expect(countUsers(labels)).toBe(2);
      expect(hasNegative(labels, v1)).toBe(true);
    });

    // Hidden (NaN) points are ignored, as PyQt drops NaN rows before testing.
    it("ignores points that are not visible", () => {
      const v = makeVideo("t.mp4");
      const p = pred([[10, 10], [NaN, NaN]], 0.5);
      const labels = new Labels({
        videos: [v],
        skeletons: [skeleton],
        labeledFrames: [new LabeledFrame({ video: v, frameIdx: 0, instances: [p] })],
      });
      expect(predictionsInArea(labels, v, { x1: 0, y1: 0, x2: 20, y2: 20 }).length).toBe(1);
    });
  });

  describe("on user-labeled frames", () => {
    /** v1 and v2 frame 5 gain a user instance made from the 0.9 prediction. */
    function linkFrame5(labels: Labels, video: Video) {
      const lf = labels.labeledFrames.find((f) => f.video === video && f.frameIdx === 5)!;
      const linked = lf.instances.find(
        (i) => i instanceof PredictedInstance && i.score === 0.9,
      ) as PredictedInstance;
      lf.instances.push(user([[50, 50], [60, 60]], linked));
      return linked;
    }

    // PyQt's defaults: current video only, unlinked predictions only.
    it("defaults to the current video and unlinked predictions", async () => {
      const { labels, v1, v2 } = setup();
      linkFrame5(labels, v1);
      await ctx.execute(DeletePredictionsOnLabeledFrames);
      const f5 = labels.labeledFrames.find((lf) => lf.video === v1 && lf.frameIdx === 5)!;
      const left = f5.instances.filter((i) => i instanceof PredictedInstance) as PredictedInstance[];
      expect(left.map((p) => p.score)).toEqual([0.9]); // the linked one stays
      expect(countPreds(labels, v2)).toBe(START);
    });

    // "All predictions" also removes the linked one; user instances stay.
    it("deletes linked predictions too when asked", async () => {
      const { labels, v1 } = setup();
      linkFrame5(labels, v1);
      await ctx.execute(DeletePredictionsOnLabeledFrames, { unlinkedOnly: false });
      const f5 = labels.labeledFrames.find((lf) => lf.video === v1 && lf.frameIdx === 5)!;
      expect(f5.instances.some((i) => i instanceof PredictedInstance)).toBe(false);
      expect(f5.instances.length).toBe(2);
    });

    // "All videos" reaches the other video's user-labeled frames as well.
    it("acts on all videos when asked", async () => {
      const { labels, v1, v2 } = setup();
      await ctx.execute(DeletePredictionsOnLabeledFrames, { allVideos: true, unlinkedOnly: false });
      expect(countPreds(labels, v1)).toBe(START - 2);
      expect(countPreds(labels, v2)).toBe(START - 2);
      expect(countUsers(labels)).toBe(2);
    });

    // Frames without user instances, and negative frames, are not touched.
    it("leaves prediction-only and negative frames alone", () => {
      const { labels, v1 } = setup();
      const pairs = predictionsOnUserLabeledFrames(labels, v1, false);
      expect(pairs.every(([lf]) => lf.frameIdx === 5)).toBe(true);
      expect(hasNegative(labels, v1)).toBe(true);
    });
  });

  // The selected instance is cleared only if it was one of the deleted ones.
  it("keeps the selection when the selected prediction survives", async () => {
    const { labels, v1 } = setup();
    const kept = labels.labeledFrames.find((lf) => lf.video === v1 && lf.frameIdx === 4)!
      .instances[0];
    useAppStore.getState().setInstance(kept);
    await ctx.execute(DeletePredictionsByScore, { threshold: 0.35 });
    expect(useAppStore.getState().instance).toBe(kept);
  });
});
