import { describe, it, expect } from "../bun-test";
import {
  instanceIoU,
  nodeOverlap,
  detectDuplicates,
  isNegativeFrameWithInstances,
  medianCount,
  isIncompleteFrame,
  visibleNodeCount,
  isSparseInstance,
  isEmptyInstance,
  hasOutOfRangePoints,
  labeledNodeCount,
  hasNoLabeledNodes,
} from "@/lib/analyze/labelQcRules";
import { withUnlabeledNodes } from "@/lib/analyze/qc/util";

describe("instanceIoU", () => {
  it("is 1 for identical boxes, 0 for disjoint", () => {
    const a = [[0, 0], [10, 10]];
    expect(instanceIoU(a, a)).toBeCloseTo(1, 6);
    expect(instanceIoU(a, [[100, 100], [110, 110]])).toBe(0);
  });
  it("computes partial overlap (inter/union)", () => {
    // A [0,0]-[10,10] area100; B [5,5]-[15,15] area100; inter 25; union 175
    expect(instanceIoU([[0, 0], [10, 10]], [[5, 5], [15, 15]])).toBeCloseTo(25 / 175, 6);
  });
  it("returns 0 when an instance has <2 visible points", () => {
    expect(instanceIoU([[0, 0]], [[0, 0], [10, 10]])).toBe(0);
    expect(instanceIoU([[Number.NaN, Number.NaN], [Number.NaN, Number.NaN]], [[0, 0], [10, 10]])).toBe(0);
  });
});

describe("nodeOverlap", () => {
  it("counts common + overlapping nodes and the ratio", () => {
    const a = [[0, 0], [10, 10], [20, 20]];
    const b = [[0, 1], [10, 10], [100, 100]]; // node0 dist1 (<10), node1 dist0, node2 far
    const o = nodeOverlap(a, b, 10);
    expect(o.commonNodes).toBe(3);
    expect(o.overlappingNodes).toBe(2);
    expect(o.overlapRatio).toBeCloseTo(2 / 3, 6);
  });
  it("handles no commonly-visible nodes", () => {
    const o = nodeOverlap([[0, 0], [Number.NaN, Number.NaN]], [[Number.NaN, Number.NaN], [1, 1]]);
    expect(o.commonNodes).toBe(0);
    expect(o.overlapRatio).toBe(0);
  });
});

describe("detectDuplicates", () => {
  it("flags an IoU duplicate and ignores a far instance", () => {
    const dups = detectDuplicates([
      [[0, 0], [10, 10]],
      [[0, 0], [10, 10]],
      [[100, 100], [110, 110]],
    ]);
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ indexA: 0, indexB: 1, reason: "iou" });
  });
  it("flags a node-overlap duplicate below the IoU threshold", () => {
    // 5 coincident nodes + 1 far-apart node each -> low IoU but overlapRatio 5/6 > 0.8
    const a = [[0, 0], [0, 10], [0, 20], [0, 30], [0, 40], [50, 0]];
    const b = [[0, 0], [0, 10], [0, 20], [0, 30], [0, 40], [0, -50]];
    const dups = detectDuplicates([a, b]);
    expect(dups).toHaveLength(1);
    expect(dups[0].reason).toBe("node_overlap");
  });
  it("returns nothing when instances are distinct", () => {
    expect(
      detectDuplicates([[[0, 0], [10, 10]], [[100, 100], [110, 110]]]),
    ).toEqual([]);
  });
});

describe("frame-level rules", () => {
  it("flags a negative frame that still has instances", () => {
    expect(isNegativeFrameWithInstances(true, 2)).toBe(true);
    expect(isNegativeFrameWithInstances(true, 0)).toBe(false);
    expect(isNegativeFrameWithInstances(false, 2)).toBe(false);
  });
  it("medianCount + isIncompleteFrame (fewer than the per-video median)", () => {
    expect(medianCount([2, 2, 2, 1])).toBe(2);
    expect(isIncompleteFrame(1, 2)).toBe(true);
    expect(isIncompleteFrame(2, 2)).toBe(false);
    expect(isIncompleteFrame(3, 2)).toBe(false);
  });
});

describe("instance-level rules", () => {
  it("visibleNodeCount ignores NaN rows", () => {
    expect(visibleNodeCount([[0, 0], [Number.NaN, Number.NaN], [1, 1]])).toBe(2);
  });
  it("isSparseInstance flags fewer than minVisible visible nodes", () => {
    expect(isSparseInstance([[0, 0]], 2)).toBe(true);
    expect(isSparseInstance([[0, 0], [1, 1]], 2)).toBe(false);
  });
  it("isEmptyInstance flags all-NaN / no visible points", () => {
    expect(isEmptyInstance([[Number.NaN, Number.NaN]])).toBe(true);
    expect(isEmptyInstance([[0, 0]])).toBe(false);
  });
  it("hasOutOfRangePoints flags a visible point outside [0,w]x[0,h]", () => {
    expect(hasOutOfRangePoints([[5, 5], [200, 5]], 100, 100)).toBe(true);
    expect(hasOutOfRangePoints([[5, 5], [-1, 5]], 100, 100)).toBe(true);
    expect(hasOutOfRangePoints([[5, 5], [50, 50]], 100, 100)).toBe(false);
    // NaN (invisible) points never count as out of range
    expect(hasOutOfRangePoints([[Number.NaN, Number.NaN]], 100, 100)).toBe(false);
  });
});

describe("instance-level rules with nodes not labeled", () => {
  const N = Number.NaN;
  /** A pose whose nodes flagged `true` were not annotated (SLP format 3.0). */
  const pose = (rows: number[][], unlabeled: boolean[]) => withUnlabeledNodes(rows, unlabeled);

  it("labeledNodeCount leaves out nodes not labeled; all count without a record", () => {
    expect(labeledNodeCount([[0, 0], [N, N], [N, N]])).toBe(3);
    expect(labeledNodeCount(pose([[0, 0], [N, N], [N, N]], [false, false, true]))).toBe(2);
  });

  it("a node not labeled does not make an instance sparse", () => {
    // One visible node, the other three never annotated: nothing is missing.
    const p = pose([[0, 0], [N, N], [N, N], [N, N]], [false, true, true, true]);
    expect(isSparseInstance(p, 2)).toBe(false);
    expect(isEmptyInstance(p)).toBe(false);
    // The same rows with every node labeled (three hidden) are sparse.
    expect(isSparseInstance([[0, 0], [N, N], [N, N], [N, N]], 2)).toBe(true);
  });

  it("hidden labeled nodes still count as missing", () => {
    // 1 visible + 1 hidden labeled + 2 not labeled: 1 of 2 labeled visible.
    const p = pose([[0, 0], [N, N], [N, N], [N, N]], [false, false, true, true]);
    expect(isSparseInstance(p, 2)).toBe(true);
    // A higher setting is capped at the labeled count (3 labeled, all visible).
    const q = pose([[0, 0], [1, 1], [2, 2], [N, N]], [false, false, false, true]);
    expect(isSparseInstance(q, 5)).toBe(false);
    expect(isSparseInstance(pose([[0, 0], [1, 1], [N, N], [N, N]], [false, false, false, true]), 5)).toBe(
      true,
    );
  });

  it("an instance with no labeled node is empty, and says so", () => {
    const p = pose([[N, N], [N, N]], [true, true]);
    expect(isEmptyInstance(p)).toBe(true);
    expect(hasNoLabeledNodes(p)).toBe(true);
    expect(isSparseInstance(p, 2)).toBe(false);
    // All hidden but labeled: empty in the usual sense.
    expect(hasNoLabeledNodes([[N, N], [N, N]])).toBe(false);
    expect(hasNoLabeledNodes(pose([[N, N], [N, N]], [true, false]))).toBe(false);
  });

  it("with every node labeled the rules are unchanged", () => {
    const allLabeled = (rows: number[][]) => pose(rows, rows.map(() => false));
    for (const rows of [[[0, 0]], [[0, 0], [1, 1]], [[0, 0], [N, N], [N, N]], [[N, N]]]) {
      for (const m of [1, 2, 3]) {
        expect(isSparseInstance(allLabeled(rows), m)).toBe(isSparseInstance(rows, m));
      }
      expect(isEmptyInstance(allLabeled(rows))).toBe(isEmptyInstance(rows));
      expect(hasNoLabeledNodes(allLabeled(rows))).toBe(false);
    }
    // A one-node instance stays sparse at the default setting, as before.
    expect(isSparseInstance(allLabeled([[0, 0]]), 2)).toBe(true);
  });
});
