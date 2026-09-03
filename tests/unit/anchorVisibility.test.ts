/**
 * Unit tests for the top-down anchor-part visibility stats (mirrors sleap-nn's
 * config-picker: % of training instances where each node is visible).
 */

import { describe, it, expect } from "../bun-test";
import {
  Skeleton,
  Video,
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
} from "@talmolab/sleap-io.js";
import { computeNodeVisibility, visibilityTier } from "@/lib/anchorVisibility";

function makeInstance(skeleton: Skeleton, visibleFlags: boolean[]): Instance {
  const inst = Instance.empty({ skeleton });
  for (let i = 0; i < visibleFlags.length; i++) {
    inst.points[i].xy = [i, i];
    inst.points[i].visible = visibleFlags[i];
    inst.points[i].complete = true;
  }
  return inst;
}

describe("computeNodeVisibility", () => {
  it("returns a zeroed entry per node for a null/empty labels project", () => {
    const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "s" });
    const stats = computeNodeVisibility(null, skeleton);
    expect(stats.get("head")).toEqual({ visible: 0, total: 0, pct: 0 });
    expect(stats.get("tail")).toEqual({ visible: 0, total: 0, pct: 0 });
  });

  it("returns an empty map for a null skeleton", () => {
    expect(computeNodeVisibility(null, null).size).toBe(0);
  });

  it("computes % visible per node across all user instances, all videos", () => {
    const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "s" });
    const video1 = new Video({
      filename: "v1.mp4",
      backendMetadata: { shape: [10, 100, 100, 3] },
      openBackend: false,
    });
    const video2 = new Video({
      filename: "v2.mp4",
      backendMetadata: { shape: [10, 100, 100, 3] },
      openBackend: false,
    });

    const lf1 = new LabeledFrame({ video: video1, frameIdx: 0 });
    lf1.instances.push(makeInstance(skeleton, [true, true]));
    lf1.instances.push(makeInstance(skeleton, [true, false]));

    const lf2 = new LabeledFrame({ video: video2, frameIdx: 0 });
    lf2.instances.push(makeInstance(skeleton, [false, false]));

    const labels = new Labels({
      videos: [video1, video2],
      skeletons: [skeleton],
      labeledFrames: [lf1, lf2],
    });

    const stats = computeNodeVisibility(labels, skeleton);
    // head: visible in 2 of 3 instances (67%); tail: visible in 1 of 3 (33%)
    expect(stats.get("head")).toEqual({ visible: 2, total: 3, pct: 67 });
    expect(stats.get("tail")).toEqual({ visible: 1, total: 3, pct: 33 });
  });

  it("reads the allocating points getter once per instance, not O(n) times", () => {
    // Regression guard for the ~2s freeze on densely-labeled projects: the loop
    // used `inst.points.length` (condition) AND `inst.points[i]` (body), each
    // re-invoking the allocating sleap-io proxy getter → ~2n+1 PointView[]
    // allocations per instance (O(n²) overall). The fix hoists it to one read.
    const skeleton = new Skeleton({ nodes: ["a", "b", "c", "d", "e"], name: "s" });
    const video = new Video({
      filename: "v.mp4",
      backendMetadata: { shape: [10, 100, 100, 3] },
      openBackend: false,
    });
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    const inst = makeInstance(skeleton, [true, true, false, true, false]);
    lf.instances.push(inst);

    let accesses = 0;
    const realPoints = inst.points;
    Object.defineProperty(inst, "points", {
      configurable: true,
      get() {
        accesses++;
        return realPoints;
      },
    });

    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    const stats = computeNodeVisibility(labels, skeleton);

    expect(accesses).toBe(1); // one read per instance (was ~2·5+1 = 11)
    // behavior unchanged
    expect(stats.get("a")).toEqual({ visible: 1, total: 1, pct: 100 });
    expect(stats.get("c")).toEqual({ visible: 0, total: 1, pct: 0 });
  });

  it("caches by (labels, skeleton) reference so repeated calls reuse one scan", () => {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = new Video({
      filename: "v.mp4",
      backendMetadata: { shape: [10, 100, 100, 3] },
      openBackend: false,
    });
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makeInstance(skeleton, [true, false]));
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });

    const a = computeNodeVisibility(labels, skeleton);
    const b = computeNodeVisibility(labels, skeleton);
    expect(b).toBe(a); // same Map object → second call served from cache
  });

  it("excludes predicted instances (not part of the training set)", () => {
    const skeleton = new Skeleton({ nodes: ["head"], name: "s" });
    const video = new Video({
      filename: "v.mp4",
      backendMetadata: { shape: [10, 100, 100, 3] },
      openBackend: false,
    });
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makeInstance(skeleton, [true]));
    lf.instances.push(
      new PredictedInstance({
        skeleton,
        points: [{ xy: [0, 0], visible: true, complete: true, name: "head", score: 0.9 }],
        score: 0.9,
      })
    );

    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    const stats = computeNodeVisibility(labels, skeleton);
    expect(stats.get("head")).toEqual({ visible: 1, total: 1, pct: 100 });
  });
});

describe("visibilityTier", () => {
  it("matches sleap-nn's config-picker thresholds", () => {
    expect(visibilityTier(100)).toBe("high");
    expect(visibilityTier(81)).toBe("high");
    expect(visibilityTier(80)).toBe("medium");
    expect(visibilityTier(51)).toBe("medium");
    expect(visibilityTier(50)).toBe("low");
    expect(visibilityTier(0)).toBe("low");
  });
});
