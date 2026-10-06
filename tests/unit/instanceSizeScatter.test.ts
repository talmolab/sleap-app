import { describe, it, expect } from "../bun-test";
import { pickScatterIndices } from "@/lib/analyze/instanceSizeCore";

describe("pickScatterIndices (scatter downsampling — crash guard)", () => {
  it("returns every index when the count is within the cap", () => {
    const sizes = [5, 5, 5, 5, 5];
    expect(pickScatterIndices(sizes, 10)).toEqual([0, 1, 2, 3, 4]);
  });

  it("caps the total, ascending + unique", () => {
    const sizes = Array.from({ length: 1000 }, (_, i) => i);
    const picked = pickScatterIndices(sizes, 100);
    expect(picked.length).toBeLessThanOrEqual(100);
    expect(new Set(picked).size).toBe(picked.length);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it("keeps the bulk visible even when outliers are dense (the cut-off-left bug)", () => {
    // 60 small (value 5) + 40 large (value 300). The large group alone (40)
    // would blow a small cap; the OLD 'keep all outliers first' logic then showed
    // ONLY the large tail and hid the small bulk. Bulk MUST still be represented.
    const sizes = Array.from({ length: 100 }, (_, i) => (i >= 60 ? 300 : 5));
    const picked = pickScatterIndices(sizes, 20);
    const bulk = picked.filter((i) => i < 60); // small-size indices
    const tail = picked.filter((i) => i >= 60); // large-size indices
    expect(bulk.length).toBeGreaterThan(0); // bulk is present (the fix)
    expect(tail.length).toBeGreaterThan(0); // extremes still present
  });

  it("reserves the largest instances so the extreme tail stays visible", () => {
    // Sizes ascending: the largest are the highest indices. The single max index
    // (999) should survive downsampling via the reserve.
    const sizes = Array.from({ length: 1000 }, (_, i) => i);
    const picked = pickScatterIndices(sizes, 100);
    expect(picked).toContain(999); // the max-size instance is reserved
  });

  it("does not rank non-finite sizes as largest", () => {
    const sizes = Array.from({ length: 500 }, (_, i) => (i === 0 ? Number.NaN : 10));
    const picked = pickScatterIndices(sizes, 50);
    expect(picked.length).toBeLessThanOrEqual(50);
    // NaN at 0 must not be force-included via the largest-reserve (all finite are 10).
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });
});
