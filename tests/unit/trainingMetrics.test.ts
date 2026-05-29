import { describe, it, expect } from "../bun-test";
import { quantile, computeYRange } from "@/lib/trainingMetrics";

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

describe("computeYRange", () => {
  it("returns null when no positive data in log scale", () => {
    expect(computeYRange([0, -1], { logScale: true, ignoreOutliers: false })).toBeNull();
  });
  it("pads log range in log space", () => {
    const r = computeYRange([1, 10, 100], { logScale: true, ignoreOutliers: false });
    expect(r).not.toBeNull();
    // log10 range is [0,2]; pad = 2*0.02 = 0.04 → [10^-0.04, 10^2.04]
    expect(r![0]).toBeCloseTo(10 ** -0.04, 6);
    expect(r![1]).toBeCloseTo(10 ** 2.04, 4);
  });
  it("pads linear range by 2% of peak-to-peak", () => {
    const r = computeYRange([1, 2, 3], { logScale: false, ignoreOutliers: false });
    // ptp = 2, dy = 0.04 → [1-0.04, 3+0.04]
    expect(r![0]).toBeCloseTo(0.96, 6);
    expect(r![1]).toBeCloseTo(3.04, 6);
  });
  it("clamps outliers via IQR when enabled and >=4 points (linear)", () => {
    const r = computeYRange([1, 2, 3, 4, 100], { logScale: false, ignoreOutliers: true });
    // q1=2, q3=4, iqr=2 → upper clamp min(q3+3, max+dy) = min(7, 100+dy) = 7
    expect(r![1]).toBeCloseTo(7, 6);
  });
});
