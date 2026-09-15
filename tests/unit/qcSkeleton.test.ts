/**
 * Unit tests for SkeletonAnalyzer (skeleton topology → spine/chains/degree).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp (the SkeletonAnalyzer cases
 * in src/lib/qc/checks/checks.test.js), a lab JS port of Python `sleap.qc`
 * intended for integration into sleap-app. This is the pure-numeric analyzer;
 * the io adapter (analyzerFromSkeleton) is ported in the io-adapter step.
 */
import { describe, it, expect } from "../bun-test";
import { SkeletonAnalyzer } from "@/lib/analyze/qc/skeleton";

describe("SkeletonAnalyzer", () => {
  it("finds the spine of a linear chain", () => {
    const a = new SkeletonAnalyzer(4, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(a.maxChainLength).toBe(4);
    expect(a.getCurvatureChains()[0]).toEqual([0, 1, 2, 3]);
  });

  it("computes per-node degree from edges for any topology", () => {
    // 0=nose(hub) 1=trunk 2=ear_right 3=ear_left 4=tti 5=t1 6=t2
    const a = new SkeletonAnalyzer(7, [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 4],
      [5, 4],
      [6, 5],
    ]);
    expect(a.degree).toEqual([3, 2, 1, 1, 2, 2, 1]);
  });

  it("identifies endpoints (degree 1) and branch points (degree > 2)", () => {
    const a = new SkeletonAnalyzer(4, [
      [0, 1],
      [1, 2],
      [1, 3],
    ]);
    expect([...a.endpoints].sort((x, y) => x - y)).toEqual([0, 2, 3]);
    expect(a.branchPoints).toEqual([1]);
  });

  it("getCurvatureChains: spine first, longest-first, no chain fully inside the spine", () => {
    const a = new SkeletonAnalyzer(7, [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 4],
      [5, 4],
      [6, 5],
    ]);
    const chains = a.getCurvatureChains();
    expect(chains.length).toBeGreaterThan(0);
    // sorted longest-first
    for (let i = 1; i < chains.length; i++)
      expect(chains[i - 1].length).toBeGreaterThanOrEqual(chains[i].length);
    // every chain has at least the min length (3)
    for (const c of chains) expect(c.length).toBeGreaterThanOrEqual(3);
  });
});
