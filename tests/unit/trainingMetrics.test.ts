import { describe, it, expect } from "../bun-test";
import { quantile } from "@/lib/trainingMetrics";

describe("quantile", () => {
  it("computes the median with linear interpolation", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
  });
  it("computes q1 and q3 like numpy.quantile default", () => {
    // numpy.quantile([1,2,3,4,5], 0.25) === 2 ; 0.75 === 4
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBeCloseTo(2, 10);
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBeCloseTo(4, 10);
  });
  it("returns the single value for a 1-element array", () => {
    expect(quantile([7], 0.25)).toBe(7);
  });
});
