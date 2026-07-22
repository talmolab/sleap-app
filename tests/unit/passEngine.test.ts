/**
 * Tests for the Phase-2 pass engine (issue #212).
 *
 * Covers the pure work-list build + cursor transitions: ordering, node→item→
 * pass overflow, empty-pass skipping, step-back symmetry, and progress math.
 */

import { describe, it, expect } from "../bun-test";
import { Labels, LabeledFrame, Instance, PredictedInstance, Skeleton, Video, UserCentroid, PredictedCentroid } from "@talmolab/sleap-io.js";
import { normalizeActiveLearningConfig, type ActiveLearningConfig } from "@/lib/activeLearning/config";
import {
  nodeIndicesForPass,
  buildWorkList,
  passDims,
  initialCursor,
  advance,
  stepBack,
  finalCursor,
  totalSteps,
  linearIndex,
  resolveItemInstance,
  countSeededCentroids,
  type PassCursor,
  type PassDims,
} from "@/lib/activeLearning/passEngine";

const NODE_NAMES = ["body_center", "head", "nose", "left_ear", "right_ear", "tail"];

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
}

function stubVideo(name: string): Video {
  // Video in sleap-io.js 0.5.5 derives shape from its backend; the constructor
  // has no `shape` option. These tests only match videos by reference, so the
  // stub backend is enough.
  const shape: [number, number, number, number] = [10, 480, 640, 1];
  const backend = { shape, getFrame: async () => null } as unknown as NonNullable<Video["backend"]>;
  return new Video({ filename: name, backend });
}

/** An instance with the given named points placed (visible + complete). */
function makeInstance(skeleton: Skeleton, points: Record<string, [number, number]>): Instance {
  const inst = Instance.empty({ skeleton });
  for (const [name, xy] of Object.entries(points)) {
    const i = skeleton.nodes.findIndex((n) => n.name === name);
    inst.points[i].xy = xy;
    inst.points[i].visible = true;
    inst.points[i].complete = true;
  }
  return inst;
}

/** Config with the given passes and a body_center centroid. */
function makeConfig(passes: { name: string; nodes: string[] }[]): ActiveLearningConfig {
  return normalizeActiveLearningConfig({
    localize: { centroidNode: "body_center" },
    labelKeypoints: { passes: passes.map((p) => ({ ...p, axis: false })) },
  });
}

describe("nodeIndicesForPass", () => {
  it("maps node names to skeleton indices in click order", () => {
    expect(
      nodeIndicesForPass({ name: "p", nodes: ["nose", "head"], axis: false }, NODE_NAMES),
    ).toEqual([2, 1]);
  });

  it("drops names not in the skeleton", () => {
    expect(
      nodeIndicesForPass({ name: "p", nodes: ["head", "ghost", "tail"], axis: false }, NODE_NAMES),
    ).toEqual([1, 5]);
  });

  it("dedupes repeated names, preserving first position", () => {
    expect(
      nodeIndicesForPass({ name: "p", nodes: ["head", "head", "nose"], axis: false }, NODE_NAMES),
    ).toEqual([1, 2]);
  });
});

describe("buildWorkList", () => {
  it("orders items by video, then frame, then instance; uses the anchor as centroid", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const v1 = stubVideo("b.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);

    // Two instances on v0 frame 5, one on v0 frame 2, one on v1 frame 0 —
    // deliberately out of order to exercise the sort.
    const i_v0f5a = makeInstance(skeleton, { body_center: [10, 10] });
    const i_v0f5b = makeInstance(skeleton, { body_center: [20, 20] });
    const i_v0f2 = makeInstance(skeleton, { body_center: [30, 30] });
    const i_v1f0 = makeInstance(skeleton, { body_center: [40, 40] });

    const labels = new Labels({
      videos: [v0, v1],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: v0, frameIdx: 5, instances: [i_v0f5a, i_v0f5b] }),
        new LabeledFrame({ video: v1, frameIdx: 0, instances: [i_v1f0] }),
        new LabeledFrame({ video: v0, frameIdx: 2, instances: [i_v0f2] }),
      ],
    });

    const items = buildWorkList(labels, config);
    expect(items.map((it) => [it.videoIdx, it.frameIdx, it.instanceIdx])).toEqual([
      [0, 2, 0],
      [0, 5, 0],
      [0, 5, 1],
      [1, 0, 0],
    ]);
    // Centroid = the body_center anchor location.
    expect(items[0].centroidXY).toEqual([30, 30]);
    expect(items[2].centroidXY).toEqual([20, 20]);
  });

  it("falls back to the bbox midpoint when the anchor node is unplaced", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);
    const inst = makeInstance(skeleton, { head: [0, 0], tail: [40, 60] });
    const labels = new Labels({
      videos: [v0],
      skeletons: [skeleton],
      labeledFrames: [new LabeledFrame({ video: v0, frameIdx: 0, instances: [inst] })],
    });
    const items = buildWorkList(labels, config);
    expect(items).toHaveLength(1);
    expect(items[0].centroidXY).toEqual([20, 30]);
  });

  it("skips instances with no usable points", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);
    const empty = Instance.empty({ skeleton });
    const good = makeInstance(skeleton, { body_center: [5, 5] });
    const labels = new Labels({
      videos: [v0],
      skeletons: [skeleton],
      labeledFrames: [new LabeledFrame({ video: v0, frameIdx: 0, instances: [empty, good] })],
    });
    const items = buildWorkList(labels, config);
    // The empty instance is skipped; instanceIdx indexes the frame's full
    // `instances`, so the surviving instance keeps its index (1).
    expect(items).toHaveLength(1);
    expect(items[0].instanceIdx).toBe(1);
  });

  it("includes locator-predicted centroids alongside seeded ones", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);
    const seeded = makeInstance(skeleton, { body_center: [10, 10] });
    const predicted = new PredictedInstance({
      skeleton,
      points: skeleton.nodes.map((n) => ({
        xy: n.name === "body_center" ? ([50, 60] as [number, number]) : ([NaN, NaN] as [number, number]),
        visible: n.name === "body_center",
        complete: n.name === "body_center",
        name: n.name,
        score: 0.9,
      })),
      score: 0.9,
    });
    const labels = new Labels({
      videos: [v0],
      skeletons: [skeleton],
      labeledFrames: [new LabeledFrame({ video: v0, frameIdx: 0, instances: [seeded, predicted] })],
    });
    const items = buildWorkList(labels, config);
    // Both the user seed AND the predicted centroid become work items.
    expect(items.map((it) => it.instanceIdx)).toEqual([0, 1]);
    expect(items[1].centroidXY).toEqual([50, 60]);
    // The predicted instance resolves by index for adopt-on-touch.
    expect(resolveItemInstance(labels, items[1])).toBe(predicted);
  });
});

describe("resolveItemInstance", () => {
  it("resolves a work item back to its live instance", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);
    const inst = makeInstance(skeleton, { body_center: [5, 5] });
    const labels = new Labels({
      videos: [v0],
      skeletons: [skeleton],
      labeledFrames: [new LabeledFrame({ video: v0, frameIdx: 3, instances: [inst] })],
    });
    const [item] = buildWorkList(labels, config);
    expect(resolveItemInstance(labels, item)).toBe(inst);
  });

  it("returns null when the frame no longer exists", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const labels = new Labels({ videos: [v0], skeletons: [skeleton], labeledFrames: [] });
    expect(
      resolveItemInstance(labels, { videoIdx: 0, frameIdx: 9, instanceIdx: 0, centroidXY: [0, 0] }),
    ).toBeNull();
  });

  it("resolves the CURRENT instance after undo replaces the frame's instances", () => {
    // Undo (CommandContext.restoreSnapshot) swaps a frame's instances for fresh
    // clones. The click paths resolve by index every time precisely so they
    // track the new object rather than a stale reference — assert that here.
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);
    const orig = makeInstance(skeleton, { body_center: [5, 5] });
    const lf = new LabeledFrame({ video: v0, frameIdx: 3, instances: [orig] });
    const labels = new Labels({ videos: [v0], skeletons: [skeleton], labeledFrames: [lf] });
    const [item] = buildWorkList(labels, config);
    expect(resolveItemInstance(labels, item)).toBe(orig);

    // Simulate an undo restore: same index, brand-new instance object.
    const clone = makeInstance(skeleton, { body_center: [5, 5] });
    lf.instances = [clone];
    const resolved = resolveItemInstance(labels, item);
    expect(resolved).toBe(clone);
    expect(resolved).not.toBe(orig);
  });
});

describe("buildWorkList (first-class centroid annotations)", () => {
  function makeSeparateConfig(passes: { name: string; nodes: string[] }[]): ActiveLearningConfig {
    return normalizeActiveLearningConfig({
      localize: { centroidNode: "centroid", separateCentroid: true },
      labelKeypoints: { passes: passes.map((p) => ({ ...p, axis: false })) },
    });
  }

  it("pairs each frame.centroid with a pose instance (empty poses in frame order)", () => {
    const pose = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeSeparateConfig([{ name: "P1", nodes: ["head", "nose"] }]);

    const p0 = Instance.empty({ skeleton: pose });
    const p1 = Instance.empty({ skeleton: pose });
    const c0 = new UserCentroid({ x: 50, y: 60 });
    const c1 = new UserCentroid({ x: 70, y: 80 });

    // Empty poses carry no geometry, so they pair with the centroids in frame
    // order (c0↔p0, c1↔p1).
    const labels = new Labels({
      videos: [v0],
      skeletons: [pose],
      labeledFrames: [
        new LabeledFrame({ video: v0, frameIdx: 0, instances: [p0, p1], centroids: [c0, c1] }),
      ],
    });

    const items = buildWorkList(labels, config);
    expect(items.length).toBe(2);
    expect(items[0].centroidXY).toEqual([50, 60]);
    expect(items[1].centroidXY).toEqual([70, 80]);
    // instanceIdx points at the POSE instances (what the passes label).
    expect(resolveItemInstance(labels, items[0])).toBe(p0);
    expect(resolveItemInstance(labels, items[1])).toBe(p1);
    const names = pose.nodes.map((n) => n.name);
    expect(passDims(config, items, names).nodeCountForPass).toEqual([2]);
  });

  it("skips centroids with no paired pose instance", () => {
    const pose = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeSeparateConfig([{ name: "P1", nodes: ["head"] }]);
    // Two centroids but only one pose instance → only the first pairs.
    const p0 = Instance.empty({ skeleton: pose });
    const labels = new Labels({
      videos: [v0],
      skeletons: [pose],
      labeledFrames: [
        new LabeledFrame({
          video: v0,
          frameIdx: 0,
          instances: [p0],
          centroids: [new UserCentroid({ x: 1, y: 1 }), new UserCentroid({ x: 2, y: 2 })],
        }),
      ],
    });
    const items = buildWorkList(labels, config);
    expect(items.length).toBe(1);
    expect(items[0].centroidXY).toEqual([1, 1]);
  });

  it("keeps a partially-labeled pose glued to its NEAREST centroid, not its array slot", () => {
    const pose = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeSeparateConfig([{ name: "P1", nodes: ["head"] }]);

    const c0 = new UserCentroid({ x: 10, y: 10 });
    const c1 = new UserCentroid({ x: 100, y: 100 });
    // pA was labeled near c1 in an earlier sweep; pB is still empty. Array
    // order (pA first) would pair pA with c0 — the WRONG animal.
    const pA = makeInstance(pose, { head: [98, 102] });
    const pB = Instance.empty({ skeleton: pose });

    const labels = new Labels({
      videos: [v0],
      skeletons: [pose],
      labeledFrames: [
        new LabeledFrame({ video: v0, frameIdx: 0, instances: [pA, pB], centroids: [c0, c1] }),
      ],
    });

    const items = buildWorkList(labels, config);
    expect(items.length).toBe(2);
    // c0 takes the leftover empty pose; c1 keeps its labeled partner.
    expect(items[0].centroidXY).toEqual([10, 10]);
    expect(resolveItemInstance(labels, items[0])).toBe(pB);
    expect(items[1].centroidXY).toEqual([100, 100]);
    expect(resolveItemInstance(labels, items[1])).toBe(pA);
  });

  it("deleting a centroid doesn't shift the surviving pairings", () => {
    const pose = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeSeparateConfig([{ name: "P1", nodes: ["head"] }]);

    // Two labeled poses, but the first animal's centroid was deleted. Order
    // pairing would hand the surviving centroid (near pB) to pA.
    const pA = makeInstance(pose, { head: [10, 12] });
    const pB = makeInstance(pose, { head: [100, 98] });

    const labels = new Labels({
      videos: [v0],
      skeletons: [pose],
      labeledFrames: [
        new LabeledFrame({
          video: v0,
          frameIdx: 0,
          instances: [pA, pB],
          centroids: [new UserCentroid({ x: 100, y: 100 })],
        }),
      ],
    });

    const items = buildWorkList(labels, config);
    expect(items.length).toBe(1);
    expect(items[0].centroidXY).toEqual([100, 100]);
    expect(resolveItemInstance(labels, items[0])).toBe(pB);
  });
});

describe("countSeededCentroids", () => {
  it("separate centroid: counts user centroids on frame.centroids — not pose labels", () => {
    const pose = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = normalizeActiveLearningConfig({
      localize: { centroidNode: "centroid", separateCentroid: true },
      labelKeypoints: { passes: [{ name: "P1", nodes: ["head"], axis: false }] },
    });

    // A pre-existing full pose label on the frame must NOT count; only the
    // first-class UserCentroid annotations do. A predicted centroid is excluded.
    const pFull = makeInstance(pose, { head: [1, 1], nose: [2, 2] });
    const lf = new LabeledFrame({ video: v0, frameIdx: 0, instances: [pFull] });
    lf.centroids = [
      new UserCentroid({ x: 10, y: 10 }),
      new UserCentroid({ x: 50, y: 50 }),
      new PredictedCentroid({ x: 99, y: 99, score: 0.9 }),
    ];

    const labels = new Labels({
      videos: [v0],
      skeletons: [pose],
      labeledFrames: [lf],
    });

    expect(countSeededCentroids(labels, config)).toEqual({ frames: 1, centroids: 2 });
  });

  it("separate centroid: a frame with pose labels but no centroids counts zero", () => {
    const pose = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = normalizeActiveLearningConfig({
      localize: { centroidNode: "centroid", separateCentroid: true },
      labelKeypoints: { passes: [{ name: "P1", nodes: ["head"], axis: false }] },
    });
    const pFull = makeInstance(pose, { head: [1, 1] });
    const labels = new Labels({
      videos: [v0],
      skeletons: [pose],
      labeledFrames: [new LabeledFrame({ video: v0, frameIdx: 0, instances: [pFull] })],
    });
    expect(countSeededCentroids(labels, config)).toEqual({ frames: 0, centroids: 0 });
  });

  it("anchor-node mode: counts user instances with a usable crop center, skipping empties and predictions", () => {
    const skeleton = makeSkeleton();
    const v0 = stubVideo("a.mp4");
    const config = makeConfig([{ name: "P1", nodes: ["head"] }]);

    const seeded = makeInstance(skeleton, { body_center: [10, 10] });
    const empty = Instance.empty({ skeleton });
    const predicted = new PredictedInstance({
      skeleton,
      points: skeleton.nodes.map((n) => ({
        xy: n.name === "body_center" ? ([5, 5] as [number, number]) : ([NaN, NaN] as [number, number]),
        visible: n.name === "body_center",
        complete: false,
        name: n.name,
        score: 0.9,
      })),
      score: 0.9,
    });

    const labels = new Labels({
      videos: [v0],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: v0, frameIdx: 0, instances: [seeded, empty, predicted] }),
        new LabeledFrame({ video: v0, frameIdx: 1, instances: [Instance.empty({ skeleton })] }),
      ],
    });

    // Frame 1 holds only an empty instance → not a seeded frame.
    expect(countSeededCentroids(labels, config)).toEqual({ frames: 1, centroids: 1 });
  });
});

describe("cursor transitions (pass-major)", () => {
  // 2 passes (2 nodes, 3 nodes), 2 items → sweep of 2*(2+3)=10 placements.
  const dims: PassDims = {
    passCount: 2,
    itemCount: 2,
    nodeCountForPass: [2, 3],
    order: "pass-major",
  };

  it("starts at the first pass/item/node", () => {
    expect(initialCursor(dims)).toEqual({ passIdx: 0, itemIdx: 0, nodeIdx: 0 });
  });

  it("walks node → item → pass and completes with null", () => {
    const seen: PassCursor[] = [];
    let cur: PassCursor | null = initialCursor(dims);
    while (cur) {
      seen.push(cur);
      cur = advance(cur, dims);
    }
    expect(seen).toEqual([
      // Pass 0 (2 nodes) × 2 items
      { passIdx: 0, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 0, itemIdx: 0, nodeIdx: 1 },
      { passIdx: 0, itemIdx: 1, nodeIdx: 0 },
      { passIdx: 0, itemIdx: 1, nodeIdx: 1 },
      // Pass 1 (3 nodes) × 2 items
      { passIdx: 1, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 1, itemIdx: 0, nodeIdx: 1 },
      { passIdx: 1, itemIdx: 0, nodeIdx: 2 },
      { passIdx: 1, itemIdx: 1, nodeIdx: 0 },
      { passIdx: 1, itemIdx: 1, nodeIdx: 1 },
      { passIdx: 1, itemIdx: 1, nodeIdx: 2 },
    ]);
    expect(seen).toHaveLength(totalSteps(dims));
  });

  it("stepBack is the exact inverse of advance", () => {
    let cur: PassCursor | null = initialCursor(dims);
    const forward: PassCursor[] = [];
    while (cur) {
      forward.push(cur);
      cur = advance(cur, dims);
    }
    // Walk back from the last position and expect the reversed forward path.
    const back: PassCursor[] = [];
    let c: PassCursor | null = forward[forward.length - 1];
    while (c) {
      back.push(c);
      c = stepBack(c, dims);
    }
    expect(back).toEqual([...forward].reverse());
  });

  it("stepBack from the very start is a no-op (null)", () => {
    expect(stepBack({ passIdx: 0, itemIdx: 0, nodeIdx: 0 }, dims)).toBeNull();
  });

  it("finalCursor is the last position advance would visit", () => {
    let cur: PassCursor | null = initialCursor(dims);
    let last = cur;
    while (cur) {
      last = cur;
      cur = advance(cur, dims);
    }
    expect(finalCursor(dims)).toEqual(last);
  });

  it("linearIndex agrees with the advance sequence", () => {
    let cur: PassCursor | null = initialCursor(dims);
    let expected = 0;
    while (cur) {
      expect(linearIndex(cur, dims)).toBe(expected);
      expected += 1;
      cur = advance(cur, dims);
    }
    expect(expected).toBe(totalSteps(dims));
  });
});

describe("cursor transitions with empty passes", () => {
  // Middle pass has 0 placeable nodes (e.g. all its names were off-skeleton).
  const dims: PassDims = {
    passCount: 3,
    itemCount: 1,
    nodeCountForPass: [1, 0, 2],
    order: "pass-major",
  };

  it("initialCursor skips a leading empty pass", () => {
    expect(
      initialCursor({ passCount: 2, itemCount: 1, nodeCountForPass: [0, 1], order: "pass-major" }),
    ).toEqual({
      passIdx: 1,
      itemIdx: 0,
      nodeIdx: 0,
    });
  });

  it("advance skips the empty middle pass", () => {
    const seen: PassCursor[] = [];
    let cur: PassCursor | null = initialCursor(dims);
    while (cur) {
      seen.push(cur);
      cur = advance(cur, dims);
    }
    expect(seen).toEqual([
      { passIdx: 0, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 2, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 2, itemIdx: 0, nodeIdx: 1 },
    ]);
  });

  it("stepBack skips the empty middle pass in reverse", () => {
    expect(stepBack({ passIdx: 2, itemIdx: 0, nodeIdx: 0 }, dims)).toEqual({
      passIdx: 0,
      itemIdx: 0,
      nodeIdx: 0,
    });
  });

  it("initialCursor is null when every pass is empty or there are no items", () => {
    expect(
      initialCursor({ passCount: 2, itemCount: 1, nodeCountForPass: [0, 0], order: "pass-major" }),
    ).toBeNull();
    expect(
      initialCursor({ passCount: 1, itemCount: 0, nodeCountForPass: [3], order: "pass-major" }),
    ).toBeNull();
  });
});

describe("cursor transitions (crop-major)", () => {
  // Same shape as the pass-major block, but each item finishes ALL passes
  // before the next item: node → pass → item.
  const dims: PassDims = {
    passCount: 2,
    itemCount: 2,
    nodeCountForPass: [2, 3],
    order: "crop-major",
  };

  it("walks node → pass → item and completes with null", () => {
    const seen: PassCursor[] = [];
    let cur: PassCursor | null = initialCursor(dims);
    while (cur) {
      seen.push(cur);
      cur = advance(cur, dims);
    }
    expect(seen).toEqual([
      // Item 0: pass 0 (2 nodes) then pass 1 (3 nodes)
      { passIdx: 0, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 0, itemIdx: 0, nodeIdx: 1 },
      { passIdx: 1, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 1, itemIdx: 0, nodeIdx: 1 },
      { passIdx: 1, itemIdx: 0, nodeIdx: 2 },
      // Item 1: pass 0 then pass 1
      { passIdx: 0, itemIdx: 1, nodeIdx: 0 },
      { passIdx: 0, itemIdx: 1, nodeIdx: 1 },
      { passIdx: 1, itemIdx: 1, nodeIdx: 0 },
      { passIdx: 1, itemIdx: 1, nodeIdx: 1 },
      { passIdx: 1, itemIdx: 1, nodeIdx: 2 },
    ]);
    expect(seen).toHaveLength(totalSteps(dims));
  });

  it("stepBack is the exact inverse of advance", () => {
    const forward: PassCursor[] = [];
    let cur: PassCursor | null = initialCursor(dims);
    while (cur) {
      forward.push(cur);
      cur = advance(cur, dims);
    }
    const back: PassCursor[] = [];
    let c: PassCursor | null = forward[forward.length - 1];
    while (c) {
      back.push(c);
      c = stepBack(c, dims);
    }
    expect(back).toEqual([...forward].reverse());
  });

  it("linearIndex agrees with the advance sequence and finalCursor matches", () => {
    let cur: PassCursor | null = initialCursor(dims);
    let expected = 0;
    let last = cur;
    while (cur) {
      expect(linearIndex(cur, dims)).toBe(expected);
      expected += 1;
      last = cur;
      cur = advance(cur, dims);
    }
    expect(expected).toBe(totalSteps(dims));
    expect(finalCursor(dims)).toEqual(last);
  });

  it("skips an empty middle pass within an item", () => {
    const d: PassDims = {
      passCount: 3,
      itemCount: 2,
      nodeCountForPass: [1, 0, 1],
      order: "crop-major",
    };
    const seen: PassCursor[] = [];
    let cur: PassCursor | null = initialCursor(d);
    while (cur) {
      seen.push(cur);
      cur = advance(cur, d);
    }
    expect(seen).toEqual([
      { passIdx: 0, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 2, itemIdx: 0, nodeIdx: 0 },
      { passIdx: 0, itemIdx: 1, nodeIdx: 0 },
      { passIdx: 2, itemIdx: 1, nodeIdx: 0 },
    ]);
  });
});

describe("passDims", () => {
  it("derives pass/item/node counts from config + work list", () => {
    const config = makeConfig([
      { name: "P1", nodes: ["head", "nose"] },
      { name: "P2", nodes: ["left_ear", "right_ear", "ghost"] },
    ]);
    const workList = [
      { videoIdx: 0, frameIdx: 0, instanceIdx: 0, centroidXY: [0, 0] as [number, number] },
    ];
    // "ghost" is not in the skeleton → P2 has 2 placeable nodes, not 3.
    expect(passDims(config, workList, NODE_NAMES)).toEqual({
      passCount: 2,
      itemCount: 1,
      nodeCountForPass: [2, 2],
      order: "pass-major",
    });
  });
});
