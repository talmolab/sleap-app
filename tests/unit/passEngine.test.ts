/**
 * Tests for the Phase-2 pass engine (issue #212).
 *
 * Covers the pure work-list build + cursor transitions: ordering, node→item→
 * pass overflow, empty-pass skipping, step-back symmetry, and progress math.
 */

import { describe, it, expect } from "../bun-test";
import { Labels, LabeledFrame, Instance, PredictedInstance, Skeleton, Video } from "@talmolab/sleap-io.js";
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
    labelKeypoints: { passes: passes.map((p) => ({ ...p, guide: "none" })) },
  });
}

describe("nodeIndicesForPass", () => {
  it("maps node names to skeleton indices in click order", () => {
    expect(
      nodeIndicesForPass({ name: "p", nodes: ["nose", "head"], guide: "none" }, NODE_NAMES),
    ).toEqual([2, 1]);
  });

  it("drops names not in the skeleton", () => {
    expect(
      nodeIndicesForPass({ name: "p", nodes: ["head", "ghost", "tail"], guide: "none" }, NODE_NAMES),
    ).toEqual([1, 5]);
  });

  it("dedupes repeated names, preserving first position", () => {
    expect(
      nodeIndicesForPass({ name: "p", nodes: ["head", "head", "nose"], guide: "none" }, NODE_NAMES),
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
