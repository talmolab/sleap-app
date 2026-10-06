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

// --- Brute-force oracle for the exact-parity tests below -------------------
// Independent nearest-neighbor search (a full linear scan) that shares only the
// distance contract with production: flatten a normalized pose with NaN imputed
// to 0, then sum squared per-coordinate differences. Any spatial index used by
// NearestNeighborScorer must return byte-identical distances to this.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const flatNorm = (pose: Pose): number[] =>
  normalizePose(pose).flatMap((p) => [
    Number.isNaN(p[0]) ? 0 : p[0],
    Number.isNaN(p[1]) ? 0 : p[1],
  ]);

const sqDist = (a: number[], b: number[]): number => {
  let s = 0;
  for (let k = 0; k < a.length; k++) {
    const d = a[k] - b[k];
    s += d * d;
  }
  return s;
};

/** Oracle: nearest-neighbor distance of `q` against `refs` (linear scan). */
function bruteScore(refs: number[][], q: number[]): number {
  let best = Infinity;
  for (const r of refs) best = Math.min(best, sqDist(q, r));
  return Number.isFinite(best) ? Math.sqrt(best) : Infinity;
}

/** Oracle: leave-one-out NN distance for every reference (skip self by index). */
function bruteLoo(refs: number[][]): number[] {
  return refs.map((ri, i) => {
    let best = Infinity;
    refs.forEach((rj, j) => {
      if (j !== i) best = Math.min(best, sqDist(ri, rj));
    });
    return Number.isFinite(best) ? Math.sqrt(best) : 0;
  });
}

/** A structured, low-intrinsic-dimensional pose (ring + jitter), some invisible. */
function makePose(rnd: () => number, nNodes: number): Pose {
  const cx = rnd() * 1000;
  const cy = rnd() * 1000;
  const s = 20 + rnd() * 40;
  const pose: Pose = [];
  for (let n = 0; n < nNodes; n++) {
    if (rnd() < 0.08) {
      pose.push([Number.NaN, Number.NaN]);
      continue;
    }
    const t = (n / nNodes) * Math.PI * 2;
    pose.push([
      cx + Math.cos(t) * s + (rnd() - 0.5) * 4,
      cy + Math.sin(t) * s + (rnd() - 0.5) * 4,
    ]);
  }
  return pose;
}

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

  // Exact-parity safety net for the Phase-2 spatial-index optimization: the
  // scorer must return the SAME nearest-neighbor distances as a brute-force
  // linear scan — byte-for-byte, since the distance formula is shared — across
  // many randomized poses (with duplicates and invisible nodes) and skeleton
  // sizes. Guards against any pruning bug in the index.
  for (const nNodes of [2, 5, 24]) {
    it(`score() matches brute force exactly (nNodes=${nNodes})`, () => {
      const rnd = mulberry32(0x51ea9 + nNodes);
      const refs: Pose[] = Array.from({ length: 300 }, () =>
        makePose(rnd, nNodes),
      );
      // Sprinkle exact duplicates so ties + zero-distance are exercised.
      refs.push(refs[7], refs[42], refs[123]);
      const nn = new NearestNeighborScorer({ normalize: true }).fit(refs);
      const flatRefs = refs.map(flatNorm);
      for (let t = 0; t < 200; t++) {
        const q = makePose(rnd, nNodes);
        const got = nn.score(q).nnDistance;
        const want = bruteScore(flatRefs, flatNorm(q));
        expect(got).toBe(want);
      }
      // Queries that ARE references (distance exactly 0, index must be found).
      for (const i of [0, 7, 150, 299]) {
        const r = nn.score(refs[i]);
        expect(r.nnDistance).toBe(0);
        expect(refs[r.nnIndex]).toBe(refs[i]);
      }
    });

    it(`looDistances() matches brute force exactly (nNodes=${nNodes})`, () => {
      const rnd = mulberry32(0xb00b5 + nNodes);
      const refs: Pose[] = Array.from({ length: 400 }, () =>
        makePose(rnd, nNodes),
      );
      refs.push(refs[3], refs[3], refs[200]); // duplicates => LOO distance 0
      const loo = new NearestNeighborScorer({ normalize: true })
        .fit(refs)
        .looDistances();
      const want = bruteLoo(refs.map(flatNorm));
      expect(loo).toHaveLength(want.length);
      for (let i = 0; i < want.length; i++) expect(loo[i]).toBe(want[i]);
    });
  }

  it("normalize:false uses raw coordinates (no centering)", () => {
    const refs: Pose[] = [
      [[0, 0], [1, 1]],
      [[10, 10], [11, 11]],
    ];
    const nn = new NearestNeighborScorer({ normalize: false }).fit(refs);
    const q: Pose = [[0.1, 0], [1, 1]];
    const flat = (p: Pose) => p.flatMap((pt) => pt);
    expect(nn.score(q).nnDistance).toBe(
      bruteScore(refs.map(flat), flat(q)),
    );
  });
});
