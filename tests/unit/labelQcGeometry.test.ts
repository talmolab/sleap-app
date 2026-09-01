import { describe, it, expect } from "../bun-test";
import {
  turningAngle,
  segmentsProperlyIntersect,
  chainOrderStats,
  longestSkeletonChain,
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

describe("longestSkeletonChain", () => {
  it("returns the path through a linear skeleton", () => {
    const chain = longestSkeletonChain([[0, 1], [1, 2], [2, 3]], 4);
    expect(chain).toEqual([0, 1, 2, 3]);
  });
  it("returns the diameter of a star (through the hub)", () => {
    const chain = longestSkeletonChain([[0, 1], [0, 2], [0, 3]], 4);
    expect(chain).toHaveLength(3); // leaf - hub - leaf
    expect(chain).toContain(0); // hub is in the middle
  });
  it("returns [] when there are no edges", () => {
    expect(longestSkeletonChain([], 3)).toEqual([]);
  });
});
