import { describe, it, expect } from "../bun-test";
import { reduceValues } from "@/lib/statisticSeriesCore";

describe("reduceValues", () => {
  it("sum of empty is 0", () => {
    expect(reduceValues([], "sum")).toBe(0);
  });
  it("sum adds values", () => {
    expect(reduceValues([1, 2, 3], "sum")).toBe(6);
  });
  it("min of empty is 0 (score semantics)", () => {
    expect(reduceValues([], "min")).toBe(0);
  });
  it("min ignores NaN", () => {
    expect(reduceValues([3, NaN, 1], "min")).toBe(1);
  });
  it("max returns largest", () => {
    expect(reduceValues([3, 1, 2], "max")).toBe(3);
  });
  it("mean ignores NaN (nanmean)", () => {
    expect(reduceValues([2, NaN, 4], "mean")).toBe(3);
  });
  it("mean of all-NaN is NaN", () => {
    expect(Number.isNaN(reduceValues([NaN, NaN], "mean"))).toBe(true);
  });
});
