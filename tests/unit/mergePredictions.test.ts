/**
 * Tests for the MergePredictions command (issue #226).
 *
 * MergePredictions routes prediction merge-back through sleap-io.js
 * `Labels.merge`. These are THIN-INTEGRATION tests: io's merge is
 * exhaustively tested upstream (Python sleap-io test_matching.py /
 * test_merging_integration.py + the sleap-io.js parity port), so we do NOT
 * re-test io's merge internals here. Instead we assert:
 *   1. WIRING — the command passes the right options (esp. `track:"name"`,
 *      so cross-file tracks collapse by name instead of duplicating under
 *      io's IDENTITY default) and awaits the async merge.
 *   2. MODALITY SURVIVAL — the annotation kinds the app depends on survive
 *      the merge. The load-bearing one is CENTROIDS: the active-learning
 *      locator predicts centroid-only SLPs (`--centroid_output centroid`);
 *      the retired hand-rolled `merge.ts` dropped `frame.centroids`, making
 *      AL scale-up a no-op. We also guard bounding boxes (#226 calls out
 *      bboxes/masks/rois explicitly; masks/rois travel the same
 *      `mergeAnnotations` path and are covered upstream).
 *   3. INSTANCE RESOLUTION — user-vs-predicted "auto" and
 *      "replace_predictions" behavior the app exposes.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { MergePredictions } from "@/commands/editCommands";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  PredictedCentroid,
  PredictedBoundingBox,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** Structurally-identical 2-node skeleton (same nodes + one edge). */
function makeSkeleton(name = "test"): Skeleton {
  const s = new Skeleton({ nodes: ["node_0", "node_1"], name });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}

/** Backend-less video; distinct objects with the SAME basename match by name. */
function makeVideo(filename = "/base/test.mp4"): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

function userInst(skeleton: Skeleton, x: number, y: number): Instance {
  return Instance.fromArray(
    [
      [x, y],
      [x + 1, y + 1],
    ],
    skeleton
  );
}

function predInst(
  skeleton: Skeleton,
  x: number,
  y: number,
  score = 0.9
): PredictedInstance {
  return PredictedInstance.fromArray(
    [
      [x, y],
      [x + 1, y + 1],
    ],
    skeleton,
    score
  );
}

/** Put a base project into the store and return its refs. */
function setupBase(opts: {
  skeleton: Skeleton;
  video: Video;
  frames: LabeledFrame[];
  tracks?: Track[];
}): Labels {
  const labels = new Labels({
    labeledFrames: opts.frames,
    skeletons: [opts.skeleton],
    videos: [opts.video],
    tracks: opts.tracks ?? [],
  });
  useAppStore.getState().setLabels(labels, "base.slp");
  return labels;
}

/** The current (mutated-in-place) labels from the store. */
function currentLabels(): Labels {
  return useAppStore.getState().labels as Labels;
}

/** Find a single frame by frame index on the base video. */
function frameAt(labels: Labels, video: Video, frameIdx: number): LabeledFrame {
  const found = labels.find({ video, frameIdx });
  expect(found.length).toBe(1);
  return found[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MergePredictions — centroid survival (active-learning locator fix)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("carries a predicted centroid into an existing target frame", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [userInst(skeleton, 10, 10)],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    // Centroid-only predictions frame on the SAME video + frame index.
    const predVideo = makeVideo("/compute-node/test.mp4"); // same basename
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      centroids: [new PredictedCentroid({ x: 42, y: 43, score: 0.8 })],
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
    });

    await ctx.execute(MergePredictions, { predictions });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    expect(merged.centroids.length).toBe(1);
    expect(merged.centroids[0].xy).toEqual([42, 43]);
    // The pre-existing user instance is untouched.
    expect(merged.userInstances.length).toBe(1);
  });

  it("adds a centroid-only predictions frame as a brand-new frame", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    setupBase({ skeleton, video: baseVideo, frames: [] });

    const predVideo = makeVideo("/compute-node/test.mp4");
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 5,
      centroids: [new PredictedCentroid({ x: 7, y: 8, score: 0.7 })],
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
    });

    await ctx.execute(MergePredictions, { predictions });

    const merged = frameAt(currentLabels(), baseVideo, 5);
    expect(merged.centroids.length).toBe(1);
    expect(merged.centroids[0].xy).toEqual([7, 8]);
  });
});

describe("MergePredictions — bounding-box survival", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("carries a predicted bounding box into the target frame", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [userInst(skeleton, 10, 10)],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    const predVideo = makeVideo("/compute-node/test.mp4");
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      bboxes: [
        new PredictedBoundingBox({ x1: 1, y1: 2, x2: 30, y2: 40, score: 0.9 }),
      ],
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
    });

    await ctx.execute(MergePredictions, { predictions });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    expect(merged.bboxes.length).toBe(1);
    expect(merged.bboxes[0].x1).toBe(1);
    expect(merged.bboxes[0].y2).toBe(40);
  });
});

describe("MergePredictions — instance resolution", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("keeps the user instance over an overlapping prediction (auto)", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [userInst(skeleton, 10, 10)],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    const predSkel = makeSkeleton(); // structurally identical
    const predVideo = makeVideo("/compute-node/test.mp4");
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      instances: [predInst(predSkel, 11, 11)], // ~1.4px away → overlaps
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
      skeletons: [predSkel],
    });

    await ctx.execute(MergePredictions, { predictions });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    expect(merged.userInstances.length).toBe(1);
    expect(merged.predictedInstances.length).toBe(0);
  });

  it("adds a non-overlapping prediction (auto)", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [userInst(skeleton, 10, 10)],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    const predSkel = makeSkeleton();
    const predVideo = makeVideo("/compute-node/test.mp4");
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      instances: [predInst(predSkel, 500, 500)], // far away
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
      skeletons: [predSkel],
    });

    await ctx.execute(MergePredictions, { predictions });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    expect(merged.userInstances.length).toBe(1);
    expect(merged.predictedInstances.length).toBe(1);
  });

  it("replace_predictions swaps predicted instances but keeps user ones", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [userInst(skeleton, 10, 10), predInst(skeleton, 20, 20, 0.5)],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    const predSkel = makeSkeleton();
    const predVideo = makeVideo("/compute-node/test.mp4");
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      instances: [predInst(predSkel, 300, 300, 0.99)],
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
      skeletons: [predSkel],
    });

    await ctx.execute(MergePredictions, {
      predictions,
      strategy: "replace_predictions",
    });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    expect(merged.userInstances.length).toBe(1);
    expect(merged.predictedInstances.length).toBe(1);
    // The old (0.5) prediction is gone; the fresh model output remains.
    expect(merged.predictedInstances[0].points[0].xy).toEqual([300, 300]);
  });
});

describe("MergePredictions — track wiring (track:'name')", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("collapses same-named tracks instead of duplicating them", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseTrack = new Track("animal_0");
    const baseInst = userInst(skeleton, 10, 10);
    baseInst.track = baseTrack;
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [baseInst],
    });
    setupBase({
      skeleton,
      video: baseVideo,
      frames: [baseFrame],
      tracks: [baseTrack],
    });

    // Predictions carry a DISTINCT Track object with the SAME name.
    const predSkel = makeSkeleton();
    const predVideo = makeVideo("/compute-node/test.mp4");
    const predTrack = new Track("animal_0");
    // Overlap the base instance so io's (upstream-tested) track-name divergence
    // guardrail stays quiet — this test only asserts track collapse, not the warning.
    const p = predInst(predSkel, 10, 10);
    p.track = predTrack;
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      instances: [p],
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
      skeletons: [predSkel],
      tracks: [predTrack],
    });

    await ctx.execute(MergePredictions, { predictions });

    const labels = currentLabels();
    // If the command forgot `track:"name"`, io's IDENTITY default would append
    // predTrack as a second "animal_0" → length 2. It must stay 1.
    const animalTracks = labels.tracks.filter((t) => t.name === "animal_0");
    expect(animalTracks.length).toBe(1);
  });
});

describe("MergePredictions — wiring & guards", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("reports a merge summary via toast", async () => {
    const spy = vi.spyOn(toast, "success");
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    setupBase({ skeleton, video: baseVideo, frames: [] });

    const predSkel = makeSkeleton();
    const predVideo = makeVideo("/compute-node/test.mp4");
    const predFrame = new LabeledFrame({
      video: predVideo,
      frameIdx: 0,
      instances: [predInst(predSkel, 10, 10)],
    });
    const predictions = new Labels({
      labeledFrames: [predFrame],
      videos: [predVideo],
      skeletons: [predSkel],
    });

    await ctx.execute(MergePredictions, { predictions });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/merg/i);
    spy.mockRestore();
  });

  it("is a no-op when no predictions are provided", async () => {
    const spy = vi.spyOn(toast, "success");
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    setupBase({ skeleton, video: baseVideo, frames: [] });

    await ctx.execute(MergePredictions, {}); // no predictions

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
