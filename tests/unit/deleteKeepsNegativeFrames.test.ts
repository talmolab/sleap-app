/**
 * Deleting instances must not erase negative-frame marks.
 *
 * A negative (background) frame is a LabeledFrame with `isNegative` and no
 * instances. Every delete command ends by dropping frames left with nothing in
 * them; it used to test only `instances.length > 0`, which also dropped every
 * negative frame in the project. Legacy SLEAP's deletes go through sleap-io's
 * `Labels.clean(frames=True)`, which keeps negative and otherwise-annotated
 * frames, so these commands now match it (`frameHasContent`).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import type { Command } from "@/commands/types";
import { useAppStore } from "@/stores/appStore";
import { DeleteAllPredictions, MergePredictions } from "@/commands/editCommands";
import {
  DeletePredictionsByScore,
  DeletePredictionsByRange,
  DeletePredictionsOnLabeledFrames,
  DeletePredictionsByMaxCount,
  DeletePredictionsByTrack,
  DeleteInstancesByType,
} from "@/commands/fileCommands";
import { frameHasContent } from "@/lib/frameLabeling";
import {
  Labels,
  LabeledFrame,
  PredictedInstance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

const NEGATIVE = 0;
const PREDICTION_ONLY = 1;

function setup() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "v.mp4",
    backendMetadata: { shape: [10, 64, 64, 1] },
    openBackend: false,
  });
  const track = new Track("t1");
  const prediction = PredictedInstance.fromArray(
    [
      [1, 2],
      [3, 4],
    ],
    skeleton,
  );
  prediction.score = 0.1;
  prediction.track = track;
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    tracks: [track],
    labeledFrames: [
      new LabeledFrame({ video, frameIdx: NEGATIVE, isNegative: true }),
      new LabeledFrame({ video, frameIdx: PREDICTION_ONLY, instances: [prediction] }),
    ],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, video };
}

const frameIdxs = (labels: Labels) => labels.labeledFrames.map((lf) => lf.frameIdx);

describe("delete commands keep negative frames", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  const cases: [string, Command, (video: Video) => Record<string, unknown> | undefined][] = [
    ["Delete All Predictions", DeleteAllPredictions, () => undefined],
    ["by score", DeletePredictionsByScore, () => ({ threshold: 0.5 })],
    ["by frame range", DeletePredictionsByRange, () => ({ startFrame: 0, endFrame: 5 })],
    ["beyond max instances", DeletePredictionsByMaxCount, () => ({ maxInstances: 0 })],
    ["by track", DeletePredictionsByTrack, () => ({ trackName: "t1" })],
    ["by instance type", DeleteInstancesByType, () => ({ instanceType: "predicted" })],
    [
      "merging inference results with Clear all",
      MergePredictions,
      (video) => ({
        predictions: new Labels({ videos: [video], skeletons: [], labeledFrames: [] }),
        mode: "clear_all",
      }),
    ],
  ];

  for (const [label, command, params] of cases) {
    it(`${label}: keeps the negative frame, drops the emptied one`, async () => {
      const { labels, video } = setup();
      await ctx.execute(command, params(video));
      expect(frameIdxs(labels)).toEqual([NEGATIVE]);
      expect(labels.labeledFrames[0].isNegative).toBe(true);
    });
  }

  it("on user-labeled frames: keeps the negative frame (it counts as user-labeled)", async () => {
    const { labels } = setup();
    await ctx.execute(DeletePredictionsOnLabeledFrames);
    expect(frameIdxs(labels)).toContain(NEGATIVE);
    expect(labels.labeledFrames.find((lf) => lf.frameIdx === NEGATIVE)?.isNegative).toBe(true);
  });
});

describe("frameHasContent", () => {
  const video = new Video({ filename: "v.mp4", openBackend: false });

  it("is false only for a frame with nothing in it", () => {
    expect(frameHasContent(new LabeledFrame({ video, frameIdx: 0 }))).toBe(false);
  });

  it("is true for a negative frame with no instances", () => {
    expect(frameHasContent(new LabeledFrame({ video, frameIdx: 0, isNegative: true }))).toBe(true);
  });

  it("is true for a frame that only has a centroid", () => {
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.centroids.push({} as never);
    expect(frameHasContent(lf)).toBe(true);
  });
});
