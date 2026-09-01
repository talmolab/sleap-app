import { describe, it, expect } from "../bun-test";
import { binSizes, binIndexOf } from "@/lib/analyze/instanceSizeCore";

describe("binSizes", () => {
  it("bins evenly across [min,max]; counts sum to n; max lands in the last bin", () => {
    const h = binSizes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(h.binCount).toBe(5);
    expect(h.min).toBe(0);
    expect(h.max).toBe(10);
    expect(h.binWidth).toBe(2);
    expect(h.edges).toEqual([0, 2, 4, 6, 8, 10]);
    expect(h.counts).toHaveLength(5);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(11);
    // 8,9,10 -> last bin (10 clamped in, not a 6th bin)
    expect(h.counts[4]).toBe(3);
  });

  it("ignores non-finite values", () => {
    const h = binSizes([1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY], 2);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("collapses a single distinct value into one bin", () => {
    const h = binSizes([5, 5, 5], 10);
    expect(h.binCount).toBe(1);
    expect(h.counts).toEqual([3]);
    expect(h.min).toBe(5);
    expect(h.max).toBe(5);
  });

  it("returns an empty histogram for no finite input", () => {
    const h = binSizes([], 5);
    expect(h.binCount).toBe(0);
    expect(h.counts).toEqual([]);
    expect(h.edges).toEqual([]);
  });
});

describe("binIndexOf", () => {
  it("maps a size to its bin, clamping the max into the last bin", () => {
    const h = binSizes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5); // width 2
    expect(binIndexOf(h, 0)).toBe(0);
    expect(binIndexOf(h, 1.9)).toBe(0);
    expect(binIndexOf(h, 2)).toBe(1);
    expect(binIndexOf(h, 10)).toBe(4);
  });

  it("returns 0 for a single-value histogram and -1 for non-finite", () => {
    const h = binSizes([5, 5], 4);
    expect(binIndexOf(h, 5)).toBe(0);
    expect(binIndexOf(h, Number.NaN)).toBe(-1);
  });
});
