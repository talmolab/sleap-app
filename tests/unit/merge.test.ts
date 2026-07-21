/**
 * Tests for the Labels merge function.
 *
 * Uses TDD approach - tests written before implementation.
 *
 * NOTE: sleap-io.js v0.2.x has a known bug in LabeledFrame.userInstances:
 * it uses `instanceof Instance` which also matches PredictedInstance (since
 * PredictedInstance extends Instance). Therefore, tests use
 * `predictedInstances` (which works correctly) and
 * `instances.filter(i => !(i instanceof PredictedInstance))` for non-predicted
 * instance checks.
 */

import { describe, it, expect } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
  UserCentroid,
  PredictedCentroid,
} from "@talmolab/sleap-io.js";
import { merge, centroid, centroidDistance } from "@/lib/merge";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeSkeleton(nodeNames: string[], name?: string): Skeleton {
  return new Skeleton({ nodes: nodeNames, name });
}

function makeVideo(filename: string): Video {
  return new Video({ filename, openBackend: false });
}

function makeInstance(
  skeleton: Skeleton,
  coords: number[][] = [[10, 20]]
): Instance {
  return Instance.fromArray(coords, skeleton);
}

function makePredictedInstance(
  skeleton: Skeleton,
  coords: number[][] = [[10, 20]],
  score = 0.9
): PredictedInstance {
  return PredictedInstance.fromArray(coords, skeleton, score);
}

function makeLabels(
  frames: LabeledFrame[] = [],
  skeletons: Skeleton[] = [],
  videos: Video[] = [],
  tracks: Track[] = []
): Labels {
  return new Labels({ labeledFrames: frames, skeletons, videos, tracks });
}

/** Get only non-predicted instances (working around the userInstances bug). */
function getUserInstances(
  frame: LabeledFrame
): Instance[] {
  return frame.instances.filter(
    (i) => !(i instanceof PredictedInstance)
  ) as Instance[];
}

// ---------------------------------------------------------------------------
// centroid() tests
// ---------------------------------------------------------------------------

describe("centroid", () => {
  it("returns null when no visible points", () => {
    const skel = makeSkeleton(["a", "b"]);
    const inst = Instance.fromArray(
      [
        [NaN, NaN],
        [NaN, NaN],
      ],
      skel
    );
    expect(centroid(inst)).toBeNull();
  });

  it("returns the centroid of a single visible point", () => {
    const skel = makeSkeleton(["a"]);
    const inst = Instance.fromArray([[30, 50]], skel);
    expect(centroid(inst)).toEqual([30, 50]);
  });

  it("returns the mean of multiple visible points", () => {
    const skel = makeSkeleton(["a", "b"]);
    const inst = Instance.fromArray(
      [
        [10, 20],
        [30, 40],
      ],
      skel
    );
    const c = centroid(inst);
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(20);
    expect(c![1]).toBeCloseTo(30);
  });

  it("ignores invisible points (NaN coords)", () => {
    const skel = makeSkeleton(["a", "b", "c"]);
    const inst = Instance.fromArray(
      [
        [10, 10],
        [NaN, NaN],
        [30, 10],
      ],
      skel
    );
    // Only points[0] and points[2] are visible; centroid = ([10+30]/2, [10+10]/2)
    const c = centroid(inst);
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(20);
    expect(c![1]).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// centroidDistance() tests
// ---------------------------------------------------------------------------

describe("centroidDistance", () => {
  it("returns Infinity when either instance has no visible points", () => {
    const skel = makeSkeleton(["a"]);
    const empty = Instance.fromArray([[NaN, NaN]], skel);
    const good = Instance.fromArray([[10, 10]], skel);
    expect(centroidDistance(empty, good)).toBe(Infinity);
    expect(centroidDistance(good, empty)).toBe(Infinity);
  });

  it("returns 0 for identical positions", () => {
    const skel = makeSkeleton(["a"]);
    const a = Instance.fromArray([[5, 5]], skel);
    const b = Instance.fromArray([[5, 5]], skel);
    expect(centroidDistance(a, b)).toBe(0);
  });

  it("returns Euclidean distance between centroids", () => {
    const skel = makeSkeleton(["a"]);
    const a = Instance.fromArray([[0, 0]], skel);
    const b = Instance.fromArray([[3, 4]], skel);
    expect(centroidDistance(a, b)).toBeCloseTo(5);
  });
});

// ---------------------------------------------------------------------------
// Skeleton matching
// ---------------------------------------------------------------------------

describe("Skeleton matching", () => {
  it("maps identical skeletons without adding duplicates", () => {
    const skel = makeSkeleton(["head", "neck"], "Fly");
    const source = makeLabels([], [skel]);
    const target = makeLabels([], [makeSkeleton(["head", "neck"], "Fly")]);

    merge(target, source);

    // Still only one skeleton in target
    expect(target.skeletons).toHaveLength(1);
  });

  it("adds unmatched skeleton from source to target", () => {
    const sourceSkel = makeSkeleton(["a", "b", "c"], "SourceSkeleton");
    const targetSkel = makeSkeleton(["x", "y"], "TargetSkeleton");
    const source = makeLabels([], [sourceSkel]);
    const target = makeLabels([], [targetSkel]);

    merge(target, source);

    expect(target.skeletons).toHaveLength(2);
    expect(target.skeletons).toContain(sourceSkel);
  });

  it("maps multiple source skeletons correctly", () => {
    const skel1 = makeSkeleton(["a", "b"]);
    const skel2 = makeSkeleton(["x", "y", "z"]);
    const source = makeLabels([], [skel1, skel2]);
    const target = makeLabels(
      [],
      [makeSkeleton(["a", "b"]), makeSkeleton(["x", "y", "z"])]
    );

    merge(target, source);

    // No new skeletons added
    expect(target.skeletons).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Video matching
// ---------------------------------------------------------------------------

describe("Video matching", () => {
  it("maps videos by basename (non-strict)", () => {
    const sourceVideo = makeVideo("/some/path/video.mp4");
    const targetVideo = makeVideo("/different/path/video.mp4");
    const source = makeLabels([], [], [sourceVideo]);
    const target = makeLabels([], [], [targetVideo]);

    merge(target, source);

    // Same basename → no new video added
    expect(target.videos).toHaveLength(1);
  });

  it("adds unmatched video from source to target", () => {
    const sourceVideo = makeVideo("/path/source_video.mp4");
    const targetVideo = makeVideo("/path/target_video.mp4");
    const source = makeLabels([], [], [sourceVideo]);
    const target = makeLabels([], [], [targetVideo]);

    merge(target, source);

    expect(target.videos).toHaveLength(2);
    expect(target.videos).toContain(sourceVideo);
  });

  it("handles source video with no match in target (adds it)", () => {
    const sourceVideo = makeVideo("new_video.mp4");
    const source = makeLabels([], [], [sourceVideo]);
    const target = makeLabels([], [], []);

    merge(target, source);

    expect(target.videos).toHaveLength(1);
    expect(target.videos).toContain(sourceVideo);
  });
});

// ---------------------------------------------------------------------------
// Track matching
// ---------------------------------------------------------------------------

describe("Track matching", () => {
  it("maps tracks by name without adding duplicates", () => {
    const sourceTrack = new Track("track1");
    const targetTrack = new Track("track1");
    const source = makeLabels([], [], [], [sourceTrack]);
    const target = makeLabels([], [], [], [targetTrack]);

    merge(target, source);

    expect(target.tracks).toHaveLength(1);
  });

  it("adds unmatched track from source to target", () => {
    const sourceTrack = new Track("new_track");
    const targetTrack = new Track("existing_track");
    const source = makeLabels([], [], [], [sourceTrack]);
    const target = makeLabels([], [], [], [targetTrack]);

    merge(target, source);

    expect(target.tracks).toHaveLength(2);
    expect(target.tracks).toContain(sourceTrack);
  });

  it("maps multiple tracks correctly", () => {
    const t1 = new Track("animal_0");
    const t2 = new Track("animal_1");
    const source = makeLabels([], [], [], [t1, t2]);
    const target = makeLabels(
      [],
      [],
      [],
      [new Track("animal_0"), new Track("animal_1")]
    );

    merge(target, source);

    expect(target.tracks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Auto strategy
// ---------------------------------------------------------------------------

describe("Auto strategy", () => {
  it("adds source frame to empty target", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [makePredictedInstance(skel, [[10, 10]])],
    });
    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([], [skel], [makeVideo("video.mp4")]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    expect(frames).toHaveLength(1);
    expect(frames[0].instances).toHaveLength(1);
  });

  it("keeps user instances over incoming predictions (user wins)", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const userInst = makeInstance(skel, [[10, 10]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst],
    });

    // Incoming prediction at nearly the same location
    const pred = makePredictedInstance(skel, [[12, 12]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [pred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    expect(frames[0].instances).toHaveLength(1);
    // User instance is preserved
    expect(getUserInstances(frames[0])).toHaveLength(1);
    expect(getUserInstances(frames[0])[0]).toBe(userInst);
    // Prediction was skipped
    expect(frames[0].predictedInstances).toHaveLength(0);
  });

  it("replaces old prediction with new prediction (newer wins)", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const oldPred = makePredictedInstance(skel, [[10, 10]], 0.5);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [oldPred],
    });

    const newPred = makePredictedInstance(skel, [[11, 11]], 0.9);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [newPred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    expect(frames[0].instances).toHaveLength(1);
    expect(frames[0].predictedInstances[0]).toBe(newPred);
    expect(frames[0].predictedInstances[0].score).toBe(0.9);
  });

  it("adds non-overlapping source instances", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const existingPred = makePredictedInstance(skel, [[10, 10]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [existingPred],
    });

    // New prediction far away (no spatial overlap)
    const newPred = makePredictedInstance(skel, [[500, 500]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [newPred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    // Both predictions remain (one old, one new from different location)
    expect(frames[0].predictedInstances).toHaveLength(2);
  });

  it("keeps unmatched target predictions not overlapping with source", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const unrelated = makePredictedInstance(skel, [[200, 200]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [unrelated],
    });

    // Source has prediction at a totally different location
    const newPred = makePredictedInstance(skel, [[10, 10]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [newPred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    expect(frames[0].predictedInstances).toHaveLength(2);
    // Original unrelated prediction is still there
    expect(frames[0].predictedInstances).toContain(unrelated);
  });

  it("uses default threshold of 5 pixels", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    // Target has a user instance at origin
    const userInst = makeInstance(skel, [[0, 0]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst],
    });

    // Source prediction is exactly 4 pixels away (within threshold=5)
    const pred = makePredictedInstance(skel, [[4, 0]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [pred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    // Prediction within 5px of user instance → skipped (user wins)
    expect(frames[0].predictedInstances).toHaveLength(0);
    expect(getUserInstances(frames[0])).toHaveLength(1);
  });

  it("adds prediction beyond threshold as new instance", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const userInst = makeInstance(skel, [[0, 0]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst],
    });

    // 10 pixels away, beyond threshold=5
    const pred = makePredictedInstance(skel, [[10, 0]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [pred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source);

    const frames = target.find({ frameIdx: 0 });
    expect(frames[0].instances).toHaveLength(2);
    expect(getUserInstances(frames[0])).toHaveLength(1);
    expect(frames[0].predictedInstances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// replace_predictions strategy
// ---------------------------------------------------------------------------

describe("replace_predictions strategy", () => {
  it("replaces all target predictions with source predictions", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const userInst = makeInstance(skel, [[10, 10]]);
    const oldPred = makePredictedInstance(skel, [[20, 20]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst, oldPred],
    });

    const newPred = makePredictedInstance(skel, [[30, 30]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [newPred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source, { frameStrategy: "replace_predictions" });

    const frames = target.find({ frameIdx: 0 });
    expect(getUserInstances(frames[0])).toHaveLength(1);
    expect(getUserInstances(frames[0])[0]).toBe(userInst);
    expect(frames[0].predictedInstances).toHaveLength(1);
    expect(frames[0].predictedInstances[0]).toBe(newPred);
  });

  it("keeps user instances from target frame", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const u1 = makeInstance(skel, [[1, 1]]);
    const u2 = makeInstance(skel, [[2, 2]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [u1, u2],
    });

    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [makePredictedInstance(skel, [[100, 100]])],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    merge(target, source, { frameStrategy: "replace_predictions" });

    const frames = target.find({ frameIdx: 0 });
    expect(getUserInstances(frames[0])).toHaveLength(2);
    expect(getUserInstances(frames[0])).toContain(u1);
    expect(getUserInstances(frames[0])).toContain(u2);
  });

  it("adds frames from source that don't exist in target", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 42,
      instances: [makePredictedInstance(skel, [[10, 10]])],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([], [skel], [targetVideo]);

    merge(target, source, { frameStrategy: "replace_predictions" });

    const frames = target.find({ frameIdx: 42 });
    expect(frames).toHaveLength(1);
    expect(frames[0].predictedInstances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MergeResult counts
// ---------------------------------------------------------------------------

describe("MergeResult counts", () => {
  it("counts framesAdded for new frames", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const frames = [0, 1, 2].map(
      (i) =>
        new LabeledFrame({
          video,
          frameIdx: i,
          instances: [makePredictedInstance(skel, [[10, 10]])],
        })
    );

    const source = makeLabels(frames, [skel], [video]);
    const target = makeLabels([], [skel], [targetVideo]);

    const result = merge(target, source);
    expect(result.framesAdded).toBe(3);
  });

  it("does not count existing frames as added", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [],
    });
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [makePredictedInstance(skel, [[10, 10]])],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    const result = merge(target, source);
    expect(result.framesAdded).toBe(0);
  });

  it("counts instancesAdded", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [
        makePredictedInstance(skel, [[10, 10]]),
        makePredictedInstance(skel, [[100, 100]]),
      ],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([], [skel], [targetVideo]);

    const result = merge(target, source);
    expect(result.instancesAdded).toBe(2);
  });

  it("counts instancesSkipped when prediction overlaps user instance", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const userInst = makeInstance(skel, [[10, 10]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst],
    });

    // Close to user instance → will be skipped
    const pred = makePredictedInstance(skel, [[11, 11]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [pred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    const result = merge(target, source);
    expect(result.instancesSkipped).toBe(1);
  });

  it("counts conflicts when user instance blocks incoming prediction", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const userInst = makeInstance(skel, [[10, 10]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst],
    });

    const pred = makePredictedInstance(skel, [[11, 11]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [pred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    const result = merge(target, source);
    expect(result.conflicts).toBe(1);
  });

  it("returns zero counts when nothing to merge", () => {
    const source = makeLabels();
    const target = makeLabels();

    const result = merge(target, source);
    expect(result.framesAdded).toBe(0);
    expect(result.instancesAdded).toBe(0);
    expect(result.instancesSkipped).toBe(0);
    expect(result.conflicts).toBe(0);
  });

  it("counts instancesAdded when replacing prediction with newer prediction", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const oldPred = makePredictedInstance(skel, [[10, 10]], 0.5);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [oldPred],
    });

    const newPred = makePredictedInstance(skel, [[11, 11]], 0.9);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [newPred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    const result = merge(target, source);
    // The new prediction replaced the old one → 1 added
    expect(result.instancesAdded).toBe(1);
    // The old prediction was replaced, not skipped
    expect(result.instancesSkipped).toBe(0);
  });

  it("custom threshold works", () => {
    const skel = makeSkeleton(["a"]);
    const video = makeVideo("video.mp4");
    const targetVideo = makeVideo("video.mp4");

    const userInst = makeInstance(skel, [[0, 0]]);
    const targetFrame = new LabeledFrame({
      video: targetVideo,
      frameIdx: 0,
      instances: [userInst],
    });

    // 8px away: within threshold=10, beyond default threshold=5
    const pred = makePredictedInstance(skel, [[8, 0]]);
    const sourceFrame = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [pred],
    });

    const source = makeLabels([sourceFrame], [skel], [video]);
    const target = makeLabels([targetFrame], [skel], [targetVideo]);

    // With threshold=10, the prediction at 8px should be skipped (user wins)
    const result = merge(target, source, { instanceMatchThreshold: 10 });
    expect(result.instancesSkipped).toBe(1);
    expect(result.conflicts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// First-class centroid annotations (`frame.centroids`)
//
// Regression: the AL locator predicts centroid-only SLPs (`--centroid_output
// centroid`) — frames carrying `PredictedCentroid`s and NO instances. merge()
// previously only ever touched `frame.instances`, so every predicted centroid
// was silently dropped and the locator scale-up loop was a no-op.
// ---------------------------------------------------------------------------

describe("merge — centroids", () => {
  it("carries predicted centroids onto a NEW frame (centroid-only source)", () => {
    const skel = makeSkeleton(["a", "b"]);
    const video = makeVideo("v.mp4");
    // A centroid-only prediction frame: no instances, one PredictedCentroid.
    const srcFrame = new LabeledFrame({ video, frameIdx: 7, instances: [] });
    srcFrame.centroids = [new PredictedCentroid({ x: 40, y: 50, score: 0.9 })];
    const source = makeLabels([srcFrame], [skel], [video]);
    const target = makeLabels([], [skel], [makeVideo("v.mp4")]);

    const result = merge(target, source);

    expect(result.centroidsAdded).toBe(1);
    expect(result.framesAdded).toBe(1);
    const merged = target.labeledFrames[0];
    expect(merged.centroids.length).toBe(1);
    expect(merged.centroids[0].isPredicted).toBe(true);
    expect(merged.centroids[0].xy).toEqual([40, 50]);
  });

  it("keeps user centroids and replaces predicted ones on an EXISTING frame", () => {
    const skel = makeSkeleton(["a", "b"]);
    const video = makeVideo("v.mp4");

    const tgtFrame = new LabeledFrame({ video, frameIdx: 3, instances: [] });
    tgtFrame.centroids = [
      new UserCentroid({ x: 10, y: 10 }), // must survive
      new PredictedCentroid({ x: 11, y: 11, score: 0.5 }), // stale — must go
    ];
    const target = makeLabels([tgtFrame], [skel], [video]);

    const srcFrame = new LabeledFrame({
      video: makeVideo("v.mp4"),
      frameIdx: 3,
      instances: [],
    });
    srcFrame.centroids = [new PredictedCentroid({ x: 80, y: 80, score: 0.95 })];
    const source = makeLabels([srcFrame], [skel], [srcFrame.video]);

    const result = merge(target, source);

    expect(result.centroidsAdded).toBe(1);
    expect(result.framesAdded).toBe(0);
    const merged = target.labeledFrames[0];
    const users = merged.centroids.filter((c) => !c.isPredicted);
    const preds = merged.centroids.filter((c) => c.isPredicted);
    expect(users.length).toBe(1);
    expect(users[0].xy).toEqual([10, 10]);
    // The stale prediction was replaced, not accumulated.
    expect(preds.length).toBe(1);
    expect(preds[0].xy).toEqual([80, 80]);
  });

  it("does not touch existing centroids when the source frame has none", () => {
    const skel = makeSkeleton(["a", "b"]);
    const video = makeVideo("v.mp4");

    const tgtFrame = new LabeledFrame({ video, frameIdx: 1, instances: [] });
    tgtFrame.centroids = [new PredictedCentroid({ x: 5, y: 5, score: 0.4 })];
    const target = makeLabels([tgtFrame], [skel], [video]);

    // Instance-only source frame (no centroids) for the same frame index.
    const srcFrame = new LabeledFrame({
      video: makeVideo("v.mp4"),
      frameIdx: 1,
      instances: [makePredictedInstance(skel, [[9, 9]])],
    });
    const source = makeLabels([srcFrame], [skel], [srcFrame.video]);

    const result = merge(target, source);

    expect(result.centroidsAdded).toBe(0);
    // Existing predicted centroid is left intact when the merge carries none.
    expect(target.labeledFrames[0].centroids.length).toBe(1);
    expect(target.labeledFrames[0].centroids[0].xy).toEqual([5, 5]);
  });
});
