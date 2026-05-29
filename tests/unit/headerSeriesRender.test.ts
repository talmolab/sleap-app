import { describe, it, expect } from "../bun-test";
import { downsampleSeries, makeToYPos } from "@/lib/headerSeriesRender";

describe("downsampleSeries", () => {
  it("step=1 when series fits width", () => {
    const m = new Map([[0, 1], [1, 2], [2, 3]]);
    const { step, buckets } = downsampleSeries(m, 100);
    expect(step).toBe(1);
    expect(buckets.get(0)).toBe(1);
    expect(buckets.get(2)).toBe(3);
  });
  it("buckets take the max per group when downsampling", () => {
    // 4 frames into width 2 => step=2, buckets at 0 and 2 take max of pairs
    const m = new Map([[0, 1], [1, 5], [2, 2], [3, 3]]);
    const { step, buckets } = downsampleSeries(m, 2);
    expect(step).toBe(2);
    expect(buckets.get(0)).toBe(5); // max(1,5)
    expect(buckets.get(2)).toBe(3); // max(2,3)
  });
});

describe("makeToYPos", () => {
  it("maps min to bottom and max to top", () => {
    const toY = makeToYPos(0, 10, 20); // min=0,max=10,height=20
    // seriesMin = min-1 = -1; scale = 20/(10-(-1)) = 20/11
    expect(toY(10)).toBeCloseTo(20 - (10 - -1) * (20 / 11)); // top-ish
    expect(toY(0)).toBeCloseTo(20 - (0 - -1) * (20 / 11));
  });
});
