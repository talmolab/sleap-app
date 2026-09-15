/**
 * Unit tests for analyzerFromSkeleton — the io adapter that builds a
 * SkeletonAnalyzer from a sleap-io.js Skeleton.
 *
 * This is the first QC module to touch sleap-io.js. It replaces the reference's
 * name-based edge resolution (github.com/alexwu-z/sleap-qc-webapp, io 0.4.0)
 * with our io 0.5.13 `skeleton.edgeIndices` (mirroring labelQc.ts's access), and
 * resolves declared symmetry pairs via `skeleton.symmetries` + `skeleton.index`.
 */
import { describe, it, expect } from "../bun-test";
import { loadSlp } from "@talmolab/sleap-io.js";
import { analyzerFromSkeleton } from "@/lib/analyze/qc/skeletonIo";
import type { Skeleton } from "@/types";

describe("analyzerFromSkeleton", () => {
  it("builds an analyzer from a real .slp skeleton (edges from edgeIndices)", async () => {
    const buf = await Bun.file(
      "tests/fixtures/centered_pair.slp",
    ).arrayBuffer();
    const labels = await loadSlp(buf, { openVideos: false });
    const sk = labels.skeletons[0];
    const a = analyzerFromSkeleton(sk);
    expect(a.nNodes).toBe(24);
    expect(a.edges).toHaveLength(sk.edgeIndices.length);
    expect(a.edges).toEqual(sk.edgeIndices.map(([x, y]) => [x, y]));
    expect(a.maxChainLength).toBeGreaterThanOrEqual(3);
    expect(a.getCurvatureChains().length).toBeGreaterThan(0);
    expect(a.symmetryPairs).toEqual([]); // no declared symmetries in this fixture
  });

  it("resolves declared symmetry pairs, sorted ascending (deterministic)", () => {
    const L = {},
      R = {};
    const idx = new Map<object, number>([
      [L, 3],
      [R, 2],
    ]);
    const mock = {
      nodeNames: ["a", "b", "cR", "cL"],
      edgeIndices: [
        [0, 1],
        [1, 2],
        [1, 3],
      ],
      symmetries: [{ nodes: new Set([L, R]) }],
      index: (n: object) => idx.get(n) ?? -1,
    } as unknown as Skeleton;
    const a = analyzerFromSkeleton(mock);
    expect(a.symmetryPairs).toEqual([[2, 3]]); // (3,2) normalized to ascending
    expect(a.nNodes).toBe(4);
  });
});
