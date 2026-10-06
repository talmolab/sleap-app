/**
 * Unit tests for the structural V3 QC features (curvature + convex hull).
 *
 * The curvature cases are a faithful port of the reference suite
 * github.com/alexwu-z/sleap-qc-webapp (src/lib/qc/checks/features/structural.test.js),
 * a lab JS port of Python `sleap.qc`, intended for integration into sleap-app.
 * The `computeConvexHull` cases are added here to lock the hull area /
 * compactness math the reference suite leaves uncovered.
 *
 * The off-by-one worstCurvatureVertex targets is silent: computeCurvature
 * indexes BENDS, and bend k is measured at chain[k+1], not chain[k].
 */
import { describe, it, expect } from "../bun-test";
import {
  computeCurvature,
  worstCurvatureVertex,
  computeConvexHull,
} from "@/lib/analyze/qc/structural";
import type { Pose } from "@/lib/analyze/qc/util";

const NAN: [number, number] = [Number.NaN, Number.NaN];
/** Straight 5-node chain along x, 10 apart — zero curvature everywhere. */
const straight = (): Pose => Array.from({ length: 5 }, (_, i) => [i * 10, 0]);
const CHAIN = [0, 1, 2, 3, 4];
const numAsc = (a: number, b: number) => a - b;

describe("worstCurvatureVertex", () => {
  it("blames the joint the bend is measured AT, not the bend's index", () => {
    const pose = straight();
    pose[3] = [30, 20]; // the sharp corner is at node 3
    const w = worstCurvatureVertex(pose, CHAIN);
    expect(w?.nodes[0]).toBe(3);
    // ...and its arms are the neighbours on either side.
    expect([w?.nodes[1], w?.nodes[2]].sort(numAsc as never)).toEqual([2, 4]);
  });

  it("agrees with computeCurvature about which bend is worst", () => {
    const pose = straight();
    pose[1] = [10, 6];
    pose[3] = [30, 18]; // bigger
    const { curvatures } = computeCurvature(pose, CHAIN);
    const worstK = curvatures.reduce(
      (b, v, k) => (Math.abs(v) > Math.abs(curvatures[b]) ? k : b),
      0,
    );
    expect(worstCurvatureVertex(pose, CHAIN)?.nodes[0]).toBe(CHAIN[worstK + 1]);
    expect(worstCurvatureVertex(pose, CHAIN)?.curvature).toBe(
      curvatures[worstK],
    );
  });

  it("compares by MAGNITUDE — a hard left is as bad as a hard right", () => {
    const pose = straight();
    pose[1] = [10, -25]; // sign-negative but the largest bend
    pose[3] = [30, 5];
    expect(worstCurvatureVertex(pose, CHAIN)?.nodes[0]).toBe(1);
  });

  it("skips joints it cannot measure instead of ranking NaN first", () => {
    const pose = straight();
    pose[1] = NAN; // makes bends at nodes 1 and 2 NaN
    pose[3] = [30, 12]; // the only measurable bend
    const w = worstCurvatureVertex(pose, CHAIN);
    expect(w?.nodes[0]).toBe(3);
    expect(Number.isNaN(w?.curvature ?? NaN)).toBe(false);
  });

  it("returns null when there is nothing to blame", () => {
    expect(worstCurvatureVertex(straight(), [0, 1])).toBeNull(); // too short
    expect(worstCurvatureVertex(straight(), null)).toBeNull();
    const allNan: Pose = Array.from({ length: 5 }, () => [...NAN]);
    expect(worstCurvatureVertex(allNan, CHAIN)).toBeNull();
  });
});

describe("computeCurvature", () => {
  it("a straight chain has zero curvature everywhere", () => {
    const c = computeCurvature(straight(), CHAIN);
    expect(c.maxCurvature).toBeCloseTo(0);
    expect(c.curvatureStd).toBeCloseTo(0);
    expect(c.signChanges).toBe(0);
    expect(c.curvatures).toHaveLength(3); // one bend per interior node
  });

  it("a right-angle bend measures ~pi/2 of curvature", () => {
    const pose: Pose = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const c = computeCurvature(pose, [0, 1, 2]);
    expect(c.maxCurvature).toBeCloseTo(Math.PI / 2);
  });

  it("degenerate chains (<3 nodes) return zeros", () => {
    const c = computeCurvature(straight(), [0, 1]);
    expect(c).toMatchObject({ maxCurvature: 0, curvatureStd: 0, signChanges: 0 });
    expect(c.curvatures).toEqual([]);
  });
});

describe("computeConvexHull", () => {
  it("a 10x10 square: area 100, compactness pi/4", () => {
    const square: Pose = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const h = computeConvexHull(square);
    expect(h.hullArea).toBeCloseTo(100);
    expect(h.hullPerimeter).toBeCloseTo(40);
    expect(h.hullAspectRatio).toBeCloseTo(1);
    expect(h.compactness).toBeCloseTo(Math.PI / 4);
  });

  it("fewer than 3 visible points is degenerate (zero area)", () => {
    const h = computeConvexHull([
      [0, 0],
      [1, 1],
      NAN,
    ]);
    expect(h.hullArea).toBe(0);
    expect(h.compactness).toBe(0);
  });
});
