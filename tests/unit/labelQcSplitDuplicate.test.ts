import { describe, it, expect } from "../bun-test";
import { splitDuplicateScore, detectDuplicates } from "@/lib/analyze/labelQcRules";

// 6-node skeleton; A visible on nodes 0-2 (front), B on nodes 3-5 (back).
const NaNpt = [Number.NaN, Number.NaN];
const A = [[0, 0], [1, 0], [2, 0], NaNpt, NaNpt, NaNpt];
const backContiguous = [NaNpt, NaNpt, NaNpt, [3, 0], [4, 0], [5, 0]];
const backFar = [NaNpt, NaNpt, NaNpt, [20, 0], [21, 0], [22, 0]];
const sameAsA = [[0, 0], [1, 0], [2, 0], NaNpt, NaNpt, NaNpt];

describe("splitDuplicateScore", () => {
  it("is high for a complementary split that touches at the body", () => {
    expect(splitDuplicateScore(A, backContiguous)).toBeGreaterThan(0.5);
  });
  it("is ~0 for two disjoint instances that are far apart", () => {
    expect(splitDuplicateScore(A, backFar)).toBe(0);
  });
  it("is ~0 when the two instances label the same nodes (an overlap, not a split)", () => {
    expect(splitDuplicateScore(A, sameAsA)).toBe(0);
  });
});

describe("detectDuplicates with the split signal", () => {
  it("flags a complementary split (which IoU + node-overlap miss)", () => {
    const dups = detectDuplicates([A, backContiguous]);
    expect(dups).toHaveLength(1);
    expect(dups[0].reason).toBe("split_duplicate");
  });
  it("still ignores two genuinely separate animals", () => {
    expect(detectDuplicates([A, backFar])).toEqual([]);
  });
});
