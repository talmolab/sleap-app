/**
 * Unit tests for the 12 baseline (v2) per-instance QC features.
 *
 * The `attribute()` cases are a faithful port of the reference suite
 * github.com/alexwu-z/sleap-qc-webapp (src/lib/qc/checks/features/baseline.test.js),
 * a lab JS port of Python `sleap.qc`, intended for integration into sleap-app.
 * The `extract()` / feature-name cases are added here to lock the 12-length
 * feature vector's shape and the two whole-instance features (visibility_rate,
 * has_isolated_invisible) that the reference suite leaves uncovered.
 */
import { describe, it, expect } from "../bun-test";
import {
  BaselineFeatureExtractor,
  BASELINE_FEATURE_NAMES,
} from "@/lib/analyze/qc/baseline";
import type { Pose } from "@/lib/analyze/qc/util";

// 5-node chain skeleton 0-1-2-3-4; stats learned from ~30 clean ~10-spaced poses.
const NAN: [number, number] = [Number.NaN, Number.NaN];
const N = 5;
const edges: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
];
const cleanInstances = (): Pose[] =>
  Array.from({ length: 30 }, (_, t) =>
    Array.from({ length: N }, (_, i) => [
      i * 10 + Math.sin(t * 7 + i) * 0.3,
      Math.cos(t * 3 + i) * 0.3,
    ]),
  );
const fitted = () =>
  new BaselineFeatureExtractor(edges, N, []).fit(cleanInstances());
const chainPose = (): Pose => Array.from({ length: N }, (_, i) => [i * 10, 0]);

describe("baseline extract() — the 12-feature vector", () => {
  it("BASELINE_FEATURE_NAMES has 12 entries", () => {
    expect(BASELINE_FEATURE_NAMES).toHaveLength(12);
  });

  it("extract() returns 12 finite numbers for a clean pose", () => {
    const v = fitted().extract(chainPose());
    expect(v).toHaveLength(12);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
  });

  it("visibility_rate + has_isolated_invisible track the pose", () => {
    const clean = fitted().extract(chainPose());
    // indices 10 (visibility_rate) and 11 (has_isolated_invisible)
    expect(clean[10]).toBeCloseTo(1);
    expect(clean[11]).toBe(0);

    const holed = chainPose();
    holed[2] = NAN; // 4/5 visible; neighbors 1 & 3 visible -> isolated
    const v = fitted().extract(holed);
    expect(v[10]).toBeCloseTo(0.8);
    expect(v[11]).toBe(1);
  });

  it("a stretched edge lifts max_edge_zscore well above a clean pose", () => {
    const clean = fitted().extract(chainPose())[0]; // max_edge_zscore
    const pose = chainPose();
    pose[0] = [-1000, 0]; // edge (0,1) hugely longer than learned
    expect(fitted().extract(pose)[0]).toBeGreaterThan(clean + 10);
  });

  it("extract() before fit() throws", () => {
    const ext = new BaselineFeatureExtractor(edges, N, []);
    expect(() => ext.extract(chainPose())).toThrow();
  });
});

describe("baseline attribute() — node-level anomaly culprits", () => {
  it("has_isolated_invisible -> the invisible node whose neighbors are all visible", () => {
    const pose = chainPose();
    pose[2] = NAN; // neighbors 1 and 3 visible -> isolated invisible
    expect(fitted().attribute(pose).has_isolated_invisible?.nodes).toEqual([2]);
  });

  it("does not flag an invisible node when a neighbor is also invisible", () => {
    const pose = chainPose();
    pose[3] = NAN;
    pose[4] = NAN; // node 3's neighbor 4 invisible; node 4's only neighbor 3 invisible
    expect(fitted().attribute(pose).has_isolated_invisible).toBeUndefined();
  });

  it("max_centroid_distance -> the node yanked far from the body", () => {
    const pose = chainPose();
    pose[4] = [1000, 1000];
    expect(fitted().attribute(pose).max_centroid_distance?.nodes).toEqual([4]);
  });

  it("max_edge_zscore -> both endpoints + dir=+1 when the edge is stretched", () => {
    const pose = chainPose();
    pose[0] = [-1000, 0]; // edge (0,1) is much longer than learned
    const e = fitted().attribute(pose).max_edge_zscore;
    expect(e?.nodes).toEqual([0, 1]);
    expect(e?.dir).toBe(1);
  });

  it("max_edge_zscore -> dir=-1 when the edge is compressed", () => {
    const pose = chainPose();
    pose[0] = [9, 0]; // edge (0,1) length ~1 vs learned ~10 -> shorter
    const e = fitted().attribute(pose).max_edge_zscore;
    expect(e?.nodes).toEqual([0, 1]);
    expect(e?.dir).toBe(-1);
  });

  it("omits whole-instance features (no spurious single-node culprit)", () => {
    const a = fitted().attribute(chainPose());
    expect(a.visibility_rate).toBeUndefined();
    expect(a.bbox_area_zscore).toBeUndefined();
    expect(a.nn_distance).toBeUndefined();
  });
});

// Which SHAPE a feature blames: `kind` lets the canvas draw the thing the check
// actually measured (an angle arc vs. an edge ring).
describe("attribute() names the shape, not just the nodes", () => {
  it('max_edge_zscore is an "edge": exactly the two endpoints it measured', () => {
    const pose = chainPose();
    pose[3] = [60, 0]; // edge 2-3 stretched from ~10 to 40
    const a = fitted().attribute(pose).max_edge_zscore;
    expect(a?.kind).toBe("edge");
    expect([...(a?.nodes ?? [])].sort((x, y) => x - y)).toEqual([2, 3]);
    expect(a?.dir).toBe(1); // longer than the norm
  });

  it('max_angle_zscore is an "angle": vertex FIRST, then the two arms', () => {
    const pose = chainPose();
    pose[2] = [20, 25]; // buckles the 1-2-3 joint
    const a = fitted().attribute(pose).max_angle_zscore;
    expect(a?.kind).toBe("angle");
    expect(a?.nodes).toHaveLength(3);
    // Drawing depends on this order: nodes[0] is where the arc goes, [1]/[2] are arms.
    expect(a?.nodes[0]).toBe(2);
    expect([a?.nodes[1], a?.nodes[2]].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([
      1, 3,
    ]);
  });

  it("a length-based feature never claims to be an angle (they draw differently)", () => {
    const pose = chainPose();
    pose[4] = [1000, 1000];
    const out = fitted().attribute(pose);
    for (const f of ["max_edge_zscore", "max_pairwise_zscore"] as const) {
      if (out[f]) expect(out[f]?.kind).toBe("edge");
    }
  });
});
