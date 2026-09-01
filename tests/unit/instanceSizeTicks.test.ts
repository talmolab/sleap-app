import { describe, it, expect } from "../bun-test";
import { niceTicks } from "@/lib/analyze/instanceSizeCore";

describe("niceTicks", () => {
  it("produces round, evenly-spaced ticks covering the range", () => {
    // 74..116 -> step 10, ticks span 70..120
    expect(niceTicks(74, 116, 5)).toEqual([70, 80, 90, 100, 110, 120]);
  });

  it("keeps integer steps for a 0..10 range", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("collapses to a single tick when min == max", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
  });

  it("returns an empty array for non-finite bounds", () => {
    expect(niceTicks(Number.NaN, 10)).toEqual([]);
    expect(niceTicks(0, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("orders swapped bounds", () => {
    expect(niceTicks(116, 74, 5)).toEqual([70, 80, 90, 100, 110, 120]);
  });
});
