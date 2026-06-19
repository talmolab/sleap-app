/**
 * Tests for the pure fixed-height row windowing helper (#160).
 *
 * `computeVirtualWindow` is React-free math used by the Frames panel's
 * hand-rolled virtualization. These tests pin down the exact contract:
 * degenerate inputs, the scroll-position math, clamping at both ends, and the
 * spacer invariant that keeps the scroll height constant.
 */

import { describe, it, expect } from "../bun-test";
import {
  computeVirtualWindow,
  type VirtualWindow,
} from "@/lib/virtualWindow";

/** Asserts the spacer invariant: total rendered height === full table height. */
function expectInvariant(w: VirtualWindow, rowCount: number, rowHeight: number) {
  expect(w.topPad + (w.endIdx - w.startIdx) * rowHeight + w.bottomPad).toBe(
    rowCount * rowHeight,
  );
}

describe("computeVirtualWindow", () => {
  it("returns an all-zero window when there are no rows", () => {
    expect(
      computeVirtualWindow({
        scrollTop: 0,
        viewportHeight: 400,
        rowHeight: 20,
        rowCount: 0,
      }),
    ).toEqual({ startIdx: 0, endIdx: 0, topPad: 0, bottomPad: 0 });
  });

  it("returns an all-zero window when rowCount is negative", () => {
    expect(
      computeVirtualWindow({
        scrollTop: 0,
        viewportHeight: 400,
        rowHeight: 20,
        rowCount: -5,
      }),
    ).toEqual({ startIdx: 0, endIdx: 0, topPad: 0, bottomPad: 0 });
  });

  it("renders the full range when rowHeight is 0", () => {
    expect(
      computeVirtualWindow({
        scrollTop: 0,
        viewportHeight: 400,
        rowHeight: 0,
        rowCount: 1000,
      }),
    ).toEqual({ startIdx: 0, endIdx: 1000, topPad: 0, bottomPad: 0 });
  });

  it("renders the full range when viewportHeight is 0", () => {
    expect(
      computeVirtualWindow({
        scrollTop: 0,
        viewportHeight: 0,
        rowHeight: 20,
        rowCount: 1000,
      }),
    ).toEqual({ startIdx: 0, endIdx: 1000, topPad: 0, bottomPad: 0 });
  });

  it("windows from the top with default overscan when scrollTop is 0", () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    });
    // first = 0; visibleCount = ceil(400/20) = 20; overscan = 8.
    // startIdx = clamp(0 - 8, 0, 1000) = 0
    // endIdx   = clamp(0 + 20 + 8, 0, 1000) = 28
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(28);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe((1000 - 28) * 20);
    expectInvariant(w, 1000, 20);
  });

  it("windows around the scroll position when scrolled to the middle", () => {
    const w = computeVirtualWindow({
      scrollTop: 1000,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    });
    // first = floor(1000/20) = 50; visibleCount = 20; overscan = 8.
    // startIdx = clamp(50 - 8, 0, 1000) = 42
    // endIdx   = clamp(50 + 20 + 8, 42, 1000) = 78
    expect(w.startIdx).toBe(42);
    expect(w.endIdx).toBe(78);
    expect(w.topPad).toBe(42 * 20); // 840
    expect(w.bottomPad).toBe((1000 - 78) * 20);
    expectInvariant(w, 1000, 20);
  });

  it("clamps endIdx to rowCount and zeroes bottomPad at the bottom", () => {
    const w = computeVirtualWindow({
      // first = floor(19800/20) = 990; visibleCount = 20 -> 990 + 20 = 1010 >= rowCount
      scrollTop: 19800,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    });
    expect(w.endIdx).toBe(1000);
    expect(w.bottomPad).toBe(0);
    // startIdx = clamp(990 - 8, 0, 1000) = 982
    expect(w.startIdx).toBe(982);
    expect(w.topPad).toBe(982 * 20);
    expectInvariant(w, 1000, 20);
  });

  it("renders everything (no pads) when the viewport is taller than all content", () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 100000,
      rowHeight: 20,
      rowCount: 1000,
    });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(1000);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
    expectInvariant(w, 1000, 20);
  });

  it("treats a negative scrollTop as 0", () => {
    const w = computeVirtualWindow({
      scrollTop: -500,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    });
    // Guarded first = max(0, floor(-500/20)) = 0; same as scrollTop 0.
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(28);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe((1000 - 28) * 20);
    expectInvariant(w, 1000, 20);
  });

  it("falls back to render-all when rowHeight is NaN", () => {
    // A NaN from a failed measurement must not slip past the geometry guard
    // (NaN comparisons are false) and poison the window into a blank table.
    expect(
      computeVirtualWindow({
        scrollTop: 0,
        viewportHeight: 400,
        rowHeight: NaN,
        rowCount: 1000,
      }),
    ).toEqual({ startIdx: 0, endIdx: 1000, topPad: 0, bottomPad: 0 });
  });

  it("falls back to render-all when viewportHeight is NaN", () => {
    expect(
      computeVirtualWindow({
        scrollTop: 0,
        viewportHeight: NaN,
        rowHeight: 20,
        rowCount: 1000,
      }),
    ).toEqual({ startIdx: 0, endIdx: 1000, topPad: 0, bottomPad: 0 });
  });

  it("treats a NaN scrollTop as 0 rather than blanking the window", () => {
    const w = computeVirtualWindow({
      scrollTop: NaN,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    });
    // Finiteness guard maps NaN scrollTop -> 0, so this matches the top-scroll case.
    expect(w.startIdx).toBe(0);
    expect(w.topPad).toBe(0);
    expect(w.endIdx).toBe(28);
    expect(w.bottomPad).toBe((1000 - 28) * 20);
    expectInvariant(w, 1000, 20);
  });

  it("produces a narrower range with overscan 0 than with the default overscan", () => {
    const base = {
      scrollTop: 1000,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    };
    const noOverscan = computeVirtualWindow({ ...base, overscan: 0 });
    const defaultOverscan = computeVirtualWindow(base);

    // overscan 0: first = 50, visibleCount = 20.
    // startIdx = clamp(50, 0, 1000) = 50; endIdx = clamp(70, 50, 1000) = 70.
    expect(noOverscan.startIdx).toBe(50);
    expect(noOverscan.endIdx).toBe(70);
    expect(noOverscan.topPad).toBe(50 * 20);
    expect(noOverscan.bottomPad).toBe((1000 - 70) * 20);
    expectInvariant(noOverscan, 1000, 20);

    // default (8) widens the window on both sides.
    expect(defaultOverscan.startIdx).toBeLessThan(noOverscan.startIdx);
    expect(defaultOverscan.endIdx).toBeGreaterThan(noOverscan.endIdx);
  });

  it("widens the window symmetrically as overscan grows", () => {
    const base = {
      scrollTop: 1000,
      viewportHeight: 400,
      rowHeight: 20,
      rowCount: 1000,
    };
    const w = computeVirtualWindow({ ...base, overscan: 20 });
    // first = 50, visibleCount = 20, overscan = 20.
    // startIdx = clamp(30, 0, 1000) = 30; endIdx = clamp(90, 30, 1000) = 90.
    expect(w.startIdx).toBe(30);
    expect(w.endIdx).toBe(90);
    expectInvariant(w, 1000, 20);
  });

  it("holds the spacer invariant across a range of representative inputs", () => {
    const cases = [
      { scrollTop: 0, viewportHeight: 333, rowHeight: 17, rowCount: 250 },
      { scrollTop: 1234, viewportHeight: 480, rowHeight: 24, rowCount: 9999 },
      { scrollTop: 50000, viewportHeight: 600, rowHeight: 32, rowCount: 1500 },
      { scrollTop: 7, viewportHeight: 100, rowHeight: 13, rowCount: 1 },
      { scrollTop: 9999, viewportHeight: 401, rowHeight: 20, rowCount: 500, overscan: 3 },
    ];
    for (const c of cases) {
      const w = computeVirtualWindow(c);
      // window is well-formed and inside bounds
      expect(w.startIdx).toBeGreaterThanOrEqual(0);
      expect(w.endIdx).toBeLessThanOrEqual(c.rowCount);
      expect(w.endIdx).toBeGreaterThanOrEqual(w.startIdx);
      expectInvariant(w, c.rowCount, c.rowHeight);
    }
  });
});
