/**
 * Unit tests for the QC numeric helpers (Phase 1 of the sleap.qc port).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp (src/lib/qc/checks/util.js), a
 * lab JS port of Python `sleap.qc`, intended for integration into sleap-app.
 * These lock the NumPy-idiom contracts the feature extractor depends on:
 * POPULATION std (÷N, not ÷N-1), the 1e-6 std floor, visibility = both coords
 * finite, and the min-visible bbox.
 */
import { describe, it, expect } from "../bun-test";
import {
  isVisible,
  dist,
  mean,
  std,
  safeStd,
  maxAbs,
  meanAbs,
  visiblePoints,
  bbox,
} from "@/lib/analyze/qc/util";

describe("qc/util", () => {
  it("isVisible requires both coords finite (NaN = invisible)", () => {
    expect(isVisible([1, 2])).toBe(true);
    expect(isVisible([NaN, 2])).toBe(false);
    expect(isVisible([1, NaN])).toBe(false);
    expect(isVisible(null as unknown as number[])).toBe(false);
  });

  it("mean and POPULATION std (÷N)", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4);
    expect(mean([])).toBe(0);
    // population std of [2,4,6]: sqrt(mean((x-4)^2)) = sqrt(8/3)
    expect(std([2, 4, 6])).toBeCloseTo(Math.sqrt(8 / 3));
    expect(std([5])).toBe(0);
    expect(std([])).toBe(0);
  });

  it("safeStd floors at 1e-6", () => {
    expect(safeStd([5, 5, 5])).toBe(1e-6); // zero variance → floored
    expect(safeStd([2, 4, 6])).toBeCloseTo(Math.sqrt(8 / 3));
  });

  it("dist is Euclidean", () => {
    expect(dist([0, 0], [3, 4])).toBeCloseTo(5);
  });

  it("maxAbs / meanAbs", () => {
    expect(maxAbs([-3, 1, 2])).toBe(3);
    expect(maxAbs([])).toBe(0);
    expect(meanAbs([-2, 4])).toBeCloseTo(3);
  });

  it("visiblePoints filters out invisible", () => {
    expect(visiblePoints([[1, 1], [NaN, NaN], [2, 2]])).toEqual([[1, 1], [2, 2]]);
  });

  it("bbox over visible points, or null under the min-visible floor", () => {
    expect(bbox([[1, 2], [5, 8], [NaN, NaN]])).toEqual([1, 2, 5, 8]);
    expect(bbox([[1, 1]])).toBeNull(); // < 2 visible
    expect(bbox([[1, 1]], 1)).toEqual([1, 1, 1, 1]); // custom min
  });
});
