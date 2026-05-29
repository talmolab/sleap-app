import { describe, it, expect } from "../bun-test";
import {
  createSeriesCache,
  getOrComputeSeries,
  peekSeries,
  putSeries,
} from "@/lib/seriesCache";

const VIDEO_A = { id: "a" };
const VIDEO_B = { id: "b" };

describe("seriesCache", () => {
  it("computes on miss and returns the same reference on hit (no recompute)", () => {
    const cache = createSeriesCache();
    let computes = 0;
    const compute = () => {
      computes++;
      return new Map([[1, 5]]);
    };
    const first = getOrComputeSeries(cache, VIDEO_A, 0, "point-displacement|sum", compute);
    const second = getOrComputeSeries(cache, VIDEO_A, 0, "point-displacement|sum", compute);
    expect(computes).toBe(1); // cached on the second call
    expect(second).toBe(first); // same reference
  });

  it("caches different (graph, reduction) keys independently", () => {
    const cache = createSeriesCache();
    let computes = 0;
    const mk = () => {
      computes++;
      return new Map([[1, computes]]);
    };
    getOrComputeSeries(cache, VIDEO_A, 0, "point-displacement|sum", mk);
    getOrComputeSeries(cache, VIDEO_A, 0, "point-displacement|max", mk);
    getOrComputeSeries(cache, VIDEO_A, 0, "point-displacement|sum", mk); // hit
    expect(computes).toBe(2);
  });

  it("invalidates the whole cache when overlay (label edit) changes", () => {
    const cache = createSeriesCache();
    let computes = 0;
    const mk = () => {
      computes++;
      return new Map([[1, computes]]);
    };
    getOrComputeSeries(cache, VIDEO_A, 0, "tracking-score|min", mk);
    getOrComputeSeries(cache, VIDEO_A, 1, "tracking-score|min", mk); // overlay bumped -> recompute
    expect(computes).toBe(2);
  });

  it("invalidates the cache when the video changes", () => {
    const cache = createSeriesCache();
    let computes = 0;
    const mk = () => {
      computes++;
      return new Map([[1, computes]]);
    };
    getOrComputeSeries(cache, VIDEO_A, 0, "point-count|sum", mk);
    getOrComputeSeries(cache, VIDEO_B, 0, "point-count|sum", mk); // different video -> recompute
    expect(computes).toBe(2);
  });

  it("peek returns undefined on miss and the stored series after put", () => {
    const cache = createSeriesCache();
    expect(peekSeries(cache, VIDEO_A, 0, "min-centroid-proximity|sum")).toBeUndefined();
    const series = new Map([[2, 9]]);
    putSeries(cache, VIDEO_A, 0, "min-centroid-proximity|sum", series);
    expect(peekSeries(cache, VIDEO_A, 0, "min-centroid-proximity|sum")).toBe(series);
  });

  it("put then overlay change drops the entry (peek miss)", () => {
    const cache = createSeriesCache();
    putSeries(cache, VIDEO_A, 0, "point-displacement|sum", new Map([[1, 1]]));
    expect(peekSeries(cache, VIDEO_A, 1, "point-displacement|sum")).toBeUndefined();
  });
});
