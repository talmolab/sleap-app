/**
 * WS3 Phase 1: first-class centroid seeding (issue #212).
 *
 * In centroid-annotation mode (`seedCentroidAnnotation`), a seed click creates a
 * `UserCentroid` on `frame.centroids` instead of a single-node Instance — a
 * separate (non-keypoint) centroid anchor. Undo must remove it (the frame
 * snapshot now captures centroids), and the dashboard count reads
 * `frame.centroids`.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { SeedCentroid } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { countSeededCentroids } from "@/lib/activeLearning/passEngine";
import { normalizeActiveLearningConfig } from "@/lib/activeLearning/config";
import {
  Labels,
  LabeledFrame,
  Skeleton,
  Video,
  UserCentroid,
} from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** Single-skeleton pose project with a real (backend-less) video, no frames. */
function setup() {
  const pose = new Skeleton({ nodes: ["head", "nose", "tail"], name: "pose" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [pose], labeledFrames: [] });
  useAppStore.getState().setLabels(labels, "test.slp");
  return { labels, pose, video };
}

const centroidConfig = () =>
  normalizeActiveLearningConfig({
    localize: { centroidNode: "centroid", separateCentroid: true },
    labelKeypoints: { passes: [{ name: "P1", nodes: ["head"], axis: false }] },
  });

describe("centroid-annotation seeding", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("SeedCentroid appends a UserCentroid to frame.centroids, not an instance", async () => {
    const { labels, video } = setup();
    useAppStore.getState().enterSeedMode(undefined, true);

    await ctx.execute(SeedCentroid, { x: 10, y: 20 });

    const lf = labels.find({ video, frameIdx: 0 })[0];
    expect(lf.centroids.length).toBe(1);
    expect(lf.centroids[0]).toBeInstanceOf(UserCentroid);
    expect(lf.centroids[0].xy).toEqual([10, 20]);
    // No pose instance is created in centroid-annotation mode.
    expect(lf.instances.length).toBe(0);
  });

  it("undo removes the last seeded UserCentroid (frame snapshot restores centroids)", async () => {
    const { labels, video } = setup();
    useAppStore.getState().enterSeedMode(undefined, true);

    await ctx.execute(SeedCentroid, { x: 10, y: 20 });
    await ctx.execute(SeedCentroid, { x: 30, y: 40 });
    expect(labels.find({ video, frameIdx: 0 })[0].centroids.length).toBe(2);

    expect(ctx.undo()).toBe(true);
    const lf = labels.find({ video, frameIdx: 0 })[0];
    expect(lf.centroids.length).toBe(1);
    expect(lf.centroids[0].xy).toEqual([10, 20]);

    // Undoing the first seed removes the (now centroid-only) frame entirely.
    expect(ctx.undo()).toBe(true);
    expect(labels.labeledFrames.reduce((n, f) => n + f.centroids.length, 0)).toBe(0);
  });

  it("legacy instance seeding is unaffected when the flag is off", async () => {
    const { labels, video } = setup();
    // No centroid-annotation flag: seeds a one-node instance on the pose skeleton.
    useAppStore.getState().enterSeedMode(0, false);

    await ctx.execute(SeedCentroid, { x: 5, y: 6 });

    const lf = labels.find({ video, frameIdx: 0 })[0];
    expect(lf.centroids.length).toBe(0);
    expect(lf.instances.length).toBe(1);
    expect(lf.instances[0].points[0].xy).toEqual([5, 6]);
  });

  it("countSeededCentroids counts user centroids on frame.centroids", () => {
    const { labels, video } = setup();
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.centroids = [new UserCentroid({ x: 1, y: 1 }), new UserCentroid({ x: 2, y: 2 })];
    labels.labeledFrames.push(lf);

    expect(countSeededCentroids(labels, centroidConfig())).toEqual({
      frames: 1,
      centroids: 2,
    });
  });
});
