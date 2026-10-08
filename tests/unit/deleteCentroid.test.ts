/**
 * Tests for the DeleteCentroid command — removing an accidental first-class
 * centroid annotation (frame.centroids), which is never a selectable pose
 * instance and so can't go through DeleteSelectedInstance.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { DeleteCentroid } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  LabeledFrame,
  Skeleton,
  Video,
  UserCentroid,
} from "@talmolab/sleap-io.js";

/** Project with one frame carrying two user centroids. */
function setup() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  lf.centroids = [
    new UserCentroid({ x: 10, y: 20 }),
    new UserCentroid({ x: 30, y: 40 }),
  ];
  labels.labeledFrames.push(lf);
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setFrameIdx(0);
  useAppStore.getState().setLabeledFrame(lf);
  return { labels, video, lf };
}

/** Re-read the (possibly snapshot-restored) frame 0 from the store. */
function frame0() {
  const s = useAppStore.getState();
  return s.labels!.find({ video: s.video!, frameIdx: 0 })[0];
}

describe("DeleteCentroid", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("removes the centroid at the given index, keeping the rest", async () => {
    setup();
    await ctx.execute(DeleteCentroid, { centroidIdx: 0 });
    const lf = frame0();
    expect(lf.centroids.length).toBe(1);
    expect(lf.centroids[0].x).toBe(30);
  });

  it("undo restores the deleted centroid", async () => {
    setup();
    await ctx.execute(DeleteCentroid, { centroidIdx: 0 });
    ctx.undo();
    const lf = frame0();
    expect(lf.centroids.length).toBe(2);
    expect(lf.centroids.map((c) => c.x)).toEqual([10, 30]);
  });

  it("is a no-op for an out-of-range index", async () => {
    const { lf } = setup();
    await ctx.execute(DeleteCentroid, { centroidIdx: 5 });
    expect(lf.centroids.length).toBe(2);
  });

  it("is a no-op when no centroidIdx is given", async () => {
    const { lf } = setup();
    await ctx.execute(DeleteCentroid);
    expect(lf.centroids.length).toBe(2);
  });
});
