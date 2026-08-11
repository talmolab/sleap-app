import { describe, it, expect } from "../bun-test";
import {
  downsampleSeries,
  makeToYPos,
  frameTickInterval,
} from "@/lib/headerSeriesRender";

describe("frameTickInterval", () => {
  it("ticks every 10 for short videos (<20 frames)", () => {
    expect(frameTickInterval(15)).toBe(10);
  });
  it("ticks every 100 for a few-hundred-frame video (markers at 100/200/300)", () => {
    expect(frameTickInterval(300)).toBe(100);
    expect(frameTickInterval(500)).toBe(100);
  });
  it("steps up to keep the tick count bounded (<= maxTicks)", () => {
    expect(frameTickInterval(3000)).toBe(1000); // 100→30 ticks (>24), 1000→3
  });
});

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
  it("topPad reserves headroom: max maps to topPad, not the top edge", () => {
    // height=100, topPad=20 → the peak sits at y=20, leaving 20px above it.
    const toY = makeToYPos(0, 10, 100, 20);
    expect(toY(10)).toBeCloseTo(20);
  });
  it("a constant positive series maps to the top (full bar)", () => {
    // A flat non-zero series (e.g. constant tracking score 5): seriesMin = 4, so
    // the value maps to y=0 (top). (An ALL-ZERO series is skipped entirely by
    // drawHeaderSeries — see below — so this mapping only matters for constant
    // positive values, which represent a real, if unvarying, measurement.)
    const toY = makeToYPos(5, 5, 16);
    expect(toY(5)).toBe(0);
  });
});

import { drawHeaderSeries } from "@/lib/headerSeriesRender";

describe("drawHeaderSeries", () => {
  it("fills the area under the curve, then strokes the top edge", () => {
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push("begin"),
      moveTo: () => calls.push("moveTo"),
      lineTo: () => calls.push("lineTo"),
      closePath: () => calls.push("closePath"),
      fill: () => calls.push("fill"),
      stroke: () => calls.push("stroke"),
      set strokeStyle(_v: string) {},
      set fillStyle(_v: string) {},
      set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;

    const series = new Map([[0, 1], [1, 3], [2, 2]]);
    drawHeaderSeries(ctx, series, 3, 100, 16);

    expect(calls).toContain("fill");
    expect(calls).toContain("closePath");
    expect(calls.filter((c) => c === "lineTo").length).toBeGreaterThan(0);
    // fill happens before the top-edge stroke; stroke is the final draw call.
    expect(calls[calls.length - 1]).toBe("stroke");
    expect(calls.indexOf("fill")).toBeLessThan(calls.lastIndexOf("stroke"));
  });
  it("draws nothing for an all-zero series (no value to show)", () => {
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push("begin"),
      moveTo: () => calls.push("moveTo"),
      lineTo: () => calls.push("lineTo"),
      closePath: () => calls.push("closePath"),
      fill: () => calls.push("fill"),
      stroke: () => calls.push("stroke"),
      set strokeStyle(_v: string) {},
      set fillStyle(_v: string) {},
      set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;
    const result = drawHeaderSeries(
      ctx,
      new Map([[0, 0], [1, 0], [2, 0]]),
      3,
      100,
      16,
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("no-ops on empty series", () => {
    let stroked = false;
    const ctx = {
      beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
      stroke: () => { stroked = true; },
      set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;
    drawHeaderSeries(ctx, new Map(), 3, 100, 16);
    expect(stroked).toBe(false);
  });
});
