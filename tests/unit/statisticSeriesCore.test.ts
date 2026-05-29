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

import { instanceVelocity } from "@/lib/statisticSeriesCore";

describe("instanceVelocity", () => {
  it("sum of per-node distances (all visible)", () => {
    // node0 moves (0,0)->(3,4) => dist 5; node1 moves (0,0)->(0,0) => 0
    const a = [[3, 4], [0, 0]];
    const b = [[0, 0], [0, 0]];
    expect(instanceVelocity(a, b, "sum")).toBe(5);
  });
  it("max of per-node distances (all visible)", () => {
    const a = [[3, 4], [6, 8]];
    const b = [[0, 0], [0, 0]];
    expect(instanceVelocity(a, b, "max")).toBe(10);
  });
  // HYBRID parity: summary.py uses NaN-propagating np.sum/np.max
  // (summary.py:110), so ANY invisible node makes the whole instance NaN.
  it("sum PROPAGATES NaN when any node distance is NaN (partially-visible)", () => {
    const a = [[3, 4], [NaN, NaN]];
    const b = [[0, 0], [0, 0]];
    expect(Number.isNaN(instanceVelocity(a, b, "sum"))).toBe(true);
  });
  it("max PROPAGATES NaN when any node distance is NaN (partially-visible)", () => {
    const a = [[3, 4], [NaN, NaN]];
    const b = [[0, 0], [0, 0]];
    expect(Number.isNaN(instanceVelocity(a, b, "max"))).toBe(true);
  });
  it("all-NaN instance is NaN for sum and max", () => {
    const a = [[NaN, NaN], [NaN, NaN]];
    const b = [[0, 0], [0, 0]];
    expect(Number.isNaN(instanceVelocity(a, b, "sum"))).toBe(true);
    expect(Number.isNaN(instanceVelocity(a, b, "max"))).toBe(true);
  });
  it("mean uses nanmean: NaN node coords drop out of mean", () => {
    const a = [[3, 4], [NaN, NaN]];
    const b = [[0, 0], [0, 0]];
    expect(instanceVelocity(a, b, "mean")).toBe(5);
  });
  it("all-NaN instance is NaN for mean too (nanmean of empty)", () => {
    const a = [[NaN, NaN]];
    const b = [[0, 0]];
    expect(Number.isNaN(instanceVelocity(a, b, "mean"))).toBe(true);
  });
});

import { medianCentroid, minCentroidDistance } from "@/lib/statisticSeriesCore";

describe("medianCentroid", () => {
  it("computes per-axis median over visible (non-NaN) points", () => {
    // x: median(0,2,100)=2 ; y: median(0,2,100)=2  (odd count -> middle)
    expect(medianCentroid([[0, 0], [2, 2], [100, 100]])).toEqual([2, 2]);
  });
  it("ignores NaN points (nanmedian)", () => {
    // visible x: [0,4] -> median 2 ; visible y: [0,4] -> median 2
    expect(medianCentroid([[0, 0], [NaN, NaN], [4, 4]])).toEqual([2, 2]);
  });
  it("median differs from mean for asymmetric/outlier points", () => {
    // mean x = (0+0+30)/3 = 10 ; median x = 0  -> proves we are NOT using mean
    expect(medianCentroid([[0, 0], [0, 0], [30, 0]])![0]).toBe(0);
  });
  it("returns null when no visible points", () => {
    expect(medianCentroid([[NaN, NaN]])).toBeNull();
    expect(medianCentroid([])).toBeNull();
  });
});

describe("minCentroidDistance", () => {
  it("fewer than 2 centroids -> NaN", () => {
    expect(Number.isNaN(minCentroidDistance([[0, 0]]))).toBe(true);
    expect(Number.isNaN(minCentroidDistance([]))).toBe(true);
  });
  it("returns smallest pairwise distance", () => {
    // distances: (0,0)-(3,4)=5, (0,0)-(0,1)=1, (3,4)-(0,1)=~4.24
    expect(minCentroidDistance([[0, 0], [3, 4], [0, 1]])).toBe(1);
  });
});
