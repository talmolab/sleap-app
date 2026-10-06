import { describe, it, expect } from "../bun-test";
import { bboxSize, summarizeSizes } from "@/lib/analyze/instanceSizeCore";

describe("bboxSize", () => {
  it("computes w/h/size from visible points; size = max(w, h)", () => {
    // 40 wide, 10 tall -> size = 40
    const box = bboxSize([
      [0, 0],
      [40, 0],
      [40, 10],
      [0, 10],
    ]);
    expect(box).not.toBeNull();
    expect(box!.w).toBe(40);
    expect(box!.h).toBe(10);
    expect(box!.size).toBe(40);
  });

  it("ignores NaN (invisible) points", () => {
    const box = bboxSize([
      [0, 0],
      [Number.NaN, Number.NaN],
      [20, 30],
    ]);
    expect(box!.w).toBe(20);
    expect(box!.h).toBe(30);
    expect(box!.size).toBe(30);
  });

  it("returns null when no point is visible", () => {
    expect(bboxSize([])).toBeNull();
    expect(bboxSize([[Number.NaN, Number.NaN]])).toBeNull();
  });

  it("a single visible point has zero extent", () => {
    const box = bboxSize([[5, 7]]);
    expect(box!.w).toBe(0);
    expect(box!.h).toBe(0);
    expect(box!.size).toBe(0);
  });
});

describe("summarizeSizes", () => {
  it("computes count/min/max/mean/median and population std", () => {
    const s = summarizeSizes([10, 20, 30, 40, 100]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(40);
    expect(s.median).toBe(30);
    // population std (ddof=0): sqrt(mean(sq dev from 40)) = sqrt(1000)
    expect(s.std).toBeCloseTo(31.6227766, 5);
  });

  it("computes p90/p95/p99 with numpy-linear interpolation", () => {
    const s = summarizeSizes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.median).toBeCloseTo(5.5, 6);
    expect(s.p90).toBeCloseTo(9.1, 6);
    expect(s.p95).toBeCloseTo(9.55, 6);
    expect(s.p99).toBeCloseTo(9.91, 6);
  });

  it("counts outliers as sizes > mean + 2*std", () => {
    const s = summarizeSizes([10, 10, 10, 10, 10, 10, 10, 10, 10, 100]);
    // mean 19, std 27 -> threshold 73; only 100 exceeds it
    expect(s.outlierCount).toBe(1);
  });

  it("handles empty input", () => {
    const s = summarizeSizes([]);
    expect(s.count).toBe(0);
  });
});
