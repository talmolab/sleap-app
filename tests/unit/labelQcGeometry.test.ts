import { describe, it, expect } from "../bun-test";
import {
  turningAngle,
  segmentsProperlyIntersect,
  chainOrderStats,
  unbranchedSkeletonChains,
} from "@/lib/analyze/labelQcGeometry";

describe("turningAngle", () => {
  it("is 0 for a straight line", () => {
    expect(turningAngle([0, 0], [1, 0], [2, 0])).toBeCloseTo(0, 6);
  });
  it("is 90° for a right-angle turn", () => {
    expect(turningAngle([0, 0], [1, 0], [1, 1])).toBeCloseTo(Math.PI / 2, 6);
  });
  it("is 180° for a full reversal", () => {
    expect(turningAngle([0, 0], [1, 0], [0, 0])).toBeCloseTo(Math.PI, 6);
  });
  it("is 0 when a segment has zero length", () => {
    expect(turningAngle([0, 0], [0, 0], [1, 0])).toBe(0);
  });
});

describe("segmentsProperlyIntersect", () => {
  it("detects a crossing X", () => {
    expect(segmentsProperlyIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
  });
  it("returns false for non-crossing segments", () => {
    expect(segmentsProperlyIntersect([0, 0], [1, 0], [0, 1], [1, 1])).toBe(false);
  });
  it("returns false when they only share an endpoint (not proper)", () => {
    expect(segmentsProperlyIntersect([0, 0], [1, 1], [1, 1], [2, 0])).toBe(false);
  });
});

describe("chainOrderStats", () => {
  it("reports no inversions/intersections for a monotonic chain", () => {
    const pts = [[0, 0], [1, 0], [2, 0], [3, 0]];
    const s = chainOrderStats(pts, [0, 1, 2, 3], 60);
    expect(s.inversionRate).toBe(0);
    expect(s.intersectionCount).toBe(0);
  });
  it("flags a sharp turn (> maxTurn) as an inversion", () => {
    // node 2 doubles back sharply -> big turning angle at the interior node
    const pts = [[0, 0], [1, 0], [0.9, 0.1], [2, 0]];
    const s = chainOrderStats(pts, [0, 1, 2, 3], 60);
    expect(s.inversionRate).toBeGreaterThan(0);
  });
  it("counts a self-crossing chain", () => {
    // order 0->1->2->3 with coordinates that make segment(0,1) cross segment(2,3)
    const pts = [[0, 0], [2, 2], [2, 0], [0, 2]];
    const s = chainOrderStats(pts, [0, 1, 2, 3], 60);
    expect(s.intersectionCount).toBeGreaterThanOrEqual(1);
  });
  it("skips invisible (NaN) chain nodes", () => {
    const pts = [[0, 0], [Number.NaN, Number.NaN], [2, 0], [3, 0]];
    const s = chainOrderStats(pts, [0, 1, 2, 3], 60);
    expect(s.inversionRate).toBe(0);
    expect(s.interiorCount).toBe(1); // only node 2 is an interior of the visible sub-chain [0,2,3]
  });
});

describe("unbranchedSkeletonChains", () => {
  it("returns a linear skeleton as one chain", () => {
    expect(unbranchedSkeletonChains([[0, 1], [1, 2], [2, 3]], 4)).toEqual([[0, 1, 2, 3]]);
  });
  it("finds none in a star-shaped skeleton (a fly: everything hangs off the thorax)", () => {
    // thorax 0; head 1 -> eyes 2,3; abdomen 4; wings 5,6; six leg tips 7-12
    const fly = [[0, 1], [1, 2], [1, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9], [0, 10], [0, 11], [0, 12]];
    expect(unbranchedSkeletonChains(fly, 13)).toEqual([]);
  });
  it("keeps a mouse's tail but not the branchy head", () => {
    // nose 0 - head 1 (ears 2,3) - neck 4 - spine 5 - tail base 6 - tail mid 7 - tail tip 8
    const mouse = [[0, 1], [1, 2], [1, 3], [1, 4], [4, 5], [5, 6], [6, 7], [7, 8]];
    expect(unbranchedSkeletonChains(mouse, 9)).toEqual([[1, 4, 5, 6, 7, 8]]);
  });
  it("returns [] when there are no edges", () => {
    expect(unbranchedSkeletonChains([], 3)).toEqual([]);
  });
});
