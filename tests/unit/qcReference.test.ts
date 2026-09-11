/**
 * Unit tests for normalizePose + NearestNeighborScorer (the nn_distance feature).
 *
 * The normalizePose cases are ported from github.com/alexwu-z/sleap-qc-webapp
 * (the "reference / normalize_pose" cases in src/lib/qc/checks/checks.test.js),
 * a lab JS port of Python `sleap.qc` intended for integration into sleap-app.
 * The NearestNeighborScorer cases are added here to lock score()/looDistances()
 * which the reference suite exercises only via the full-pipeline .slp fixture.
 */
import { describe, it, expect } from "../bun-test";
import { normalizePose, NearestNeighborScorer } from "@/lib/analyze/qc/reference";
import type { Pose } from "@/lib/analyze/qc/util";

const NAN: [number, number] = [Number.NaN, Number.NaN];

describe("normalizePose", () => {
  it("is translation + scale invariant", () => {
    const pose: Pose = [
      [0, 0],
      [10, 0],
      [5, 8],
    ];
    const moved: Pose = pose.map(([x, y]) => [x * 3 + 100, y * 3 - 50]);
    const a = normalizePose(pose);
    const b = normalizePose(moved);
    a.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(b[i][0], 6);
      expect(p[1]).toBeCloseTo(b[i][1], 6);
    });
  });

  it("preserves invisible NaN", () => {
    const out = normalizePose([[0, 0], NAN, [5, 8]]);
    expect(Number.isNaN(out[1][0])).toBe(true);
    expect(Number.isNaN(out[0][0])).toBe(false);
  });
});

describe("NearestNeighborScorer", () => {
  const A: Pose = [
    [0, 0],
    [10, 0],
    [5, 8],
  ];
  const B: Pose = [
    [0, 0],
    [20, 0],
    [10, 30],
  ];

  it("nnDistance ~0 (and picks the index) for a pose equal to a reference", () => {
    const nn = new NearestNeighborScorer({ normalize: true }).fit([A, B]);
    const r = nn.score(A);
    expect(r.nnDistance).toBeCloseTo(0, 6);
    expect(r.nnIndex).toBe(0);
  });

  it("normalization makes a translated/scaled copy its own nearest neighbor", () => {
    const nn = new NearestNeighborScorer({ normalize: true }).fit([A, B]);
    const movedA: Pose = A.map(([x, y]) => [x * 5 + 300, y * 5 - 40]);
    const r = nn.score(movedA);
    expect(r.nnDistance).toBeCloseTo(0, 6);
    expect(r.nnIndex).toBe(0);
  });

  it("looDistances: length = count; identical references give 0", () => {
    const loo = new NearestNeighborScorer({ normalize: true })
      .fit([A, A, B])
      .looDistances();
    expect(loo).toHaveLength(3);
    expect(loo[0]).toBeCloseTo(0, 6); // A's twin is A
    expect(loo[1]).toBeCloseTo(0, 6);
    expect(loo[2]).toBeGreaterThan(0); // B's nearest is A
    for (const d of loo) expect(Number.isFinite(d)).toBe(true);
  });
});
