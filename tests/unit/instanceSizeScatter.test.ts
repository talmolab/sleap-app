import { describe, it, expect } from "../bun-test";
import { pickScatterIndices } from "@/lib/analyze/instanceSizeCore";

describe("pickScatterIndices (scatter downsampling — crash guard)", () => {
  it("returns every index when the count is within the cap", () => {
    const sizes = [5, 5, 5, 5, 5];
    expect(pickScatterIndices(sizes, 5, 1, 10)).toEqual([0, 1, 2, 3, 4]);
  });

  it("caps the total and keeps ALL outliers when over the cap", () => {
    // 90 non-outliers (value 5) + 10 outliers (value 100). mean=10, std=5 →
    // threshold=20, so indices 90..99 are outliers.
    const sizes = Array.from({ length: 100 }, (_, i) => (i >= 90 ? 100 : 5));
    const picked = pickScatterIndices(sizes, 10, 5, 20);

    expect(picked.length).toBeLessThanOrEqual(20);
    // ascending
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    // every outlier survives the downsample
    for (let i = 90; i < 100; i += 1) expect(picked).toContain(i);
    // the rest is filled by a uniform sample that spans from the start
    expect(picked[0]).toBe(0);
    // sampled indices are valid + unique
    expect(new Set(picked).size).toBe(picked.length);
    for (const i of picked) expect(i).toBeGreaterThanOrEqual(0);
  });

  it("treats non-finite sizes as non-outliers (index alignment preserved)", () => {
    const sizes = Array.from({ length: 50 }, (_, i) => (i === 7 ? Number.NaN : 5));
    const picked = pickScatterIndices(sizes, 5, 1, 10);
    expect(picked.length).toBeLessThanOrEqual(10);
    // NaN at 7 must not be flagged as an outlier (would otherwise be force-kept)
    // — with threshold 7 and all finite values 5, there are no outliers at all.
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it("samples outliers too when they alone exceed the cap", () => {
    // 5000 outliers, cap 100 → keep a 100-sample of them, still <= cap.
    const sizes = Array.from({ length: 5000 }, () => 1000);
    const picked = pickScatterIndices(sizes, 10, 5, 100);
    expect(picked.length).toBeLessThanOrEqual(100);
    expect(picked.length).toBeGreaterThan(0);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });
});
