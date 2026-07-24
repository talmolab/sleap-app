/**
 * Tests for the Phase-3 correction review queue (active-learning loop).
 *
 * Covers the pure queue build: worst-single-keypoint ordering, tie-breaks,
 * limit + threshold filtering, skipping of user/unscored instances, the score
 * reducers, and index-based instance resolution.
 */

import { describe, it, expect } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import {
  buildReviewQueue,
  resolveReviewInstance,
  pointScoresOf,
  scoreStats,
} from "@/lib/activeLearning/reviewQueue";

const NODE_NAMES = ["head", "body", "tail"];

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
}

function stubVideo(name: string): Video {
  const shape: [number, number, number, number] = [10, 480, 640, 1];
  const backend = { shape, getFrame: async () => null } as unknown as NonNullable<Video["backend"]>;
  return new Video({ filename: name, backend });
}

/** A predicted instance with per-node scores (nodes absent from `scores` get 0.99). */
function makePredicted(
  skeleton: Skeleton,
  scores: Record<string, number>,
  instanceScore = 0.9,
): PredictedInstance {
  return new PredictedInstance({
    skeleton,
    points: skeleton.nodes.map((n) => ({
      xy: [10, 20] as [number, number],
      visible: true,
      complete: true,
      name: n.name,
      score: n.name in scores ? scores[n.name] : 0.99,
    })),
    score: instanceScore,
  });
}

/** A plain user instance (no scores). */
function makeUser(skeleton: Skeleton): Instance {
  const inst = Instance.empty({ skeleton });
  for (let i = 0; i < skeleton.nodes.length; i++) {
    inst.points[i].xy = [5, 5];
    inst.points[i].visible = true;
    inst.points[i].complete = true;
  }
  return inst;
}

function makeLabels(
  skeleton: Skeleton,
  frames: { video: Video; frameIdx: number; instances: Instance[] }[],
): Labels {
  const videos = [...new Set(frames.map((f) => f.video))];
  return new Labels({
    videos,
    skeletons: [skeleton],
    labeledFrames: frames.map(
      (f) => new LabeledFrame({ video: f.video, frameIdx: f.frameIdx, instances: f.instances }),
    ),
  });
}

describe("pointScoresOf / scoreStats", () => {
  it("reads per-node scores aligned to node order", () => {
    const sk = makeSkeleton();
    const pred = makePredicted(sk, { head: 0.8, body: 0.2, tail: 0.5 });
    expect(pointScoresOf(pred)).toEqual([0.8, 0.2, 0.5]);
  });

  it("returns null for nodes without a finite score (user instance)", () => {
    const sk = makeSkeleton();
    expect(pointScoresOf(makeUser(sk))).toEqual([null, null, null]);
  });

  it("ignores invisible / off-canvas predicted points (can't be seen or fixed)", () => {
    const sk = makeSkeleton();
    const inst = new PredictedInstance({
      skeleton: sk,
      points: [
        { xy: [10, 10], visible: true, complete: true, name: "head", score: 0.7 },
        { xy: [NaN, NaN], visible: false, complete: true, name: "body", score: 0.05 },
        { xy: [20, 20], visible: true, complete: true, name: "tail", score: 0.4 },
      ],
      score: 0.6,
    });
    // The 0.05 point is invisible + off-canvas → excluded from scores entirely.
    expect(pointScoresOf(inst)).toEqual([0.7, null, 0.4]);
  });

  it("reduces to worst node, worst score, and mean", () => {
    const stats = scoreStats([0.8, 0.2, 0.5]);
    expect(stats).not.toBeNull();
    expect(stats!.worstScore).toBeCloseTo(0.2);
    expect(stats!.worstNodeIdx).toBe(1);
    expect(stats!.meanScore).toBeCloseTo(0.5);
  });

  it("returns null when no node has a score", () => {
    expect(scoreStats([null, null])).toBeNull();
  });
});

describe("buildReviewQueue", () => {
  it("orders instances by worst single keypoint, ascending", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    // frame 0: worst 0.5 ; frame 1: worst 0.1 ; frame 2: worst 0.3
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.5 })] },
      { video: v, frameIdx: 1, instances: [makePredicted(sk, { tail: 0.1 })] },
      { video: v, frameIdx: 2, instances: [makePredicted(sk, { head: 0.3 })] },
    ]);
    const queue = buildReviewQueue(labels);
    expect(queue.map((q) => q.frameIdx)).toEqual([1, 2, 0]);
    expect(queue[0].worstScore).toBeCloseTo(0.1);
    expect(queue[0].worstNodeIdx).toBe(2); // tail
  });

  it("breaks ties by mean confidence, then frame order", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    // Both worst 0.2, but frame 5 has a lower mean than frame 3.
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 3, instances: [makePredicted(sk, { body: 0.2, tail: 0.9 })] },
      { video: v, frameIdx: 5, instances: [makePredicted(sk, { body: 0.2, tail: 0.3 })] },
    ]);
    const queue = buildReviewQueue(labels);
    expect(queue.map((q) => q.frameIdx)).toEqual([5, 3]);
  });

  it("caps the queue to the N worst with `limit`", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.5 })] },
      { video: v, frameIdx: 1, instances: [makePredicted(sk, { body: 0.1 })] },
      { video: v, frameIdx: 2, instances: [makePredicted(sk, { body: 0.3 })] },
    ]);
    const queue = buildReviewQueue(labels, { limit: 2 });
    expect(queue.map((q) => q.frameIdx)).toEqual([1, 2]);
  });

  it("keeps only instances at/below scoreThreshold", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.5 })] },
      { video: v, frameIdx: 1, instances: [makePredicted(sk, { body: 0.2 })] },
    ]);
    const queue = buildReviewQueue(labels, { scoreThreshold: 0.3 });
    expect(queue.map((q) => q.frameIdx)).toEqual([1]);
  });

  it("skips user instances and unscored predictions", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const unscored = makePredicted(sk, { head: NaN, body: NaN, tail: NaN });
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makeUser(sk), unscored, makePredicted(sk, { body: 0.4 })] },
    ]);
    const queue = buildReviewQueue(labels);
    expect(queue.length).toBe(1);
    expect(queue[0].instanceIdx).toBe(2);
    expect(queue[0].worstScore).toBeCloseTo(0.4);
  });

  it("ranks on the worst VISIBLE keypoint, not a low-score occluded one", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    // Worst raw score (0.05) is on an invisible point; the worst correctable
    // (visible) keypoint is tail at 0.4, which is what should drive ranking.
    const inst = new PredictedInstance({
      skeleton: sk,
      points: [
        { xy: [10, 10], visible: true, complete: true, name: "head", score: 0.7 },
        { xy: [NaN, NaN], visible: false, complete: true, name: "body", score: 0.05 },
        { xy: [20, 20], visible: true, complete: true, name: "tail", score: 0.4 },
      ],
      score: 0.6,
    });
    const [item] = buildReviewQueue(makeLabels(sk, [{ video: v, frameIdx: 0, instances: [inst] }]));
    expect(item.worstScore).toBeCloseTo(0.4);
    expect(item.worstNodeIdx).toBe(2);
  });

  it("includes an instance whose worst keypoint EQUALS the threshold (inclusive)", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.3 })] },
    ]);
    expect(buildReviewQueue(labels, { scoreThreshold: 0.3 }).length).toBe(1);
  });

  it("treats limit <= 0 as no cap", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.5 })] },
      { video: v, frameIdx: 1, instances: [makePredicted(sk, { body: 0.1 })] },
    ]);
    expect(buildReviewQueue(labels, { limit: 0 }).length).toBe(2);
    expect(buildReviewQueue(labels, { limit: -5 }).length).toBe(2);
  });

  it("records a finite zoom anchor and the instance score", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const labels = makeLabels(sk, [
      { video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.4 }, 0.77)] },
    ]);
    const [item] = buildReviewQueue(labels);
    expect(Number.isFinite(item.centroidXY[0])).toBe(true);
    expect(Number.isFinite(item.centroidXY[1])).toBe(true);
    expect(item.instanceScore).toBeCloseTo(0.77);
    expect(item.pointScores).toEqual([0.99, 0.4, 0.99]);
  });
});

describe("resolveReviewInstance", () => {
  it("resolves the live instance by index (survives adopt-in-place)", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const pred = makePredicted(sk, { body: 0.2 });
    const labels = makeLabels(sk, [{ video: v, frameIdx: 4, instances: [makeUser(sk), pred] }]);
    const [item] = buildReviewQueue(labels);
    expect(resolveReviewInstance(labels, item)).toBe(pred);

    // Swap a user instance in at the same index (the adopt-on-touch pattern).
    const adopted = makeUser(sk);
    labels.labeledFrames[0].instances.splice(item.instanceIdx, 1, adopted);
    expect(resolveReviewInstance(labels, item)).toBe(adopted);
  });

  it("returns null when the frame is gone", () => {
    const sk = makeSkeleton();
    const v = stubVideo("a.mp4");
    const labels = makeLabels(sk, [{ video: v, frameIdx: 0, instances: [makePredicted(sk, { body: 0.2 })] }]);
    const [item] = buildReviewQueue(labels);
    labels.labeledFrames.length = 0;
    expect(resolveReviewInstance(labels, item)).toBeNull();
  });
});
