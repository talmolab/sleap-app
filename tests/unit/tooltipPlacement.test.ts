import { describe, it, expect } from "../bun-test";
import {
  computeTooltipPlacement,
  getInsetRect,
  rectsOverlap,
  INSET_MARGIN,
  DEFAULT_ANCHOR_CLEARANCE,
  DEFAULT_INSET_GAP,
  DEFAULT_EDGE_MARGIN,
  type Rect,
  type TooltipPlacement,
} from "@/lib/tooltipPlacement";

const CONTAINER = { width: 900, height: 600 };
const TOOLTIP = { width: 220, height: 100 };

function anchorBox(x: number, y: number, clearance = DEFAULT_ANCHOR_CLEARANCE): Rect {
  return {
    x: x - clearance,
    y: y - clearance,
    width: clearance * 2,
    height: clearance * 2,
  };
}

function tooltipRect(pos: { left: number; top: number }, size = TOOLTIP): Rect {
  return { x: pos.left, y: pos.top, width: size.width, height: size.height };
}

function expectInsideContainer(
  rect: Rect,
  container = CONTAINER,
  margin = DEFAULT_EDGE_MARGIN,
) {
  expect(rect.x).toBeGreaterThanOrEqual(margin);
  expect(rect.y).toBeGreaterThanOrEqual(margin);
  expect(rect.x + rect.width).toBeLessThanOrEqual(container.width - margin);
  expect(rect.y + rect.height).toBeLessThanOrEqual(container.height - margin);
}

describe("getInsetRect & rectsOverlap", () => {
  it("computes the top-right magnifier inset rect matching VideoPlayer", () => {
    expect(getInsetRect(900, 180)).toEqual({
      x: 900 - INSET_MARGIN - 180,
      y: INSET_MARGIN,
      width: 180,
      height: 180,
    });
  });

  it("treats touching edges as non-overlapping and intersecting boxes as overlapping", () => {
    const a: Rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(rectsOverlap(a, { x: 100, y: 0, width: 50, height: 50 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 50, width: 100, height: 50 })).toBe(false);
    expect(rectsOverlap(a, { x: 99, y: 10, width: 50, height: 50 })).toBe(true);
  });
});

describe("computeTooltipPlacement — inset docking during node drag", () => {
  it("docks directly below a top-right inset and aligns right edges", () => {
    const inset = getInsetRect(CONTAINER.width, 180);
    const pos = computeTooltipPlacement({
      anchor: { x: 400, y: 300 },
      tooltip: TOOLTIP,
      container: CONTAINER,
      insetRect: inset,
      dockToInset: true,
    });

    expect(pos.placement).toBe("inset-bottom");
    // Right edge of tooltip aligns cleanly with right edge of inset.
    expect(pos.left + TOOLTIP.width).toBe(inset.x + inset.width);
    expect(pos.top).toBe(inset.y + inset.height + DEFAULT_INSET_GAP);

    const rect = tooltipRect(pos);
    expectInsideContainer(rect);
    expect(rectsOverlap(rect, inset)).toBe(false);
    expect(rectsOverlap(rect, anchorBox(400, 300))).toBe(false);
  });

  it("shifts to inset-left when the dragged keypoint moves into the space below a top-right inset", () => {
    const inset = getInsetRect(CONTAINER.width, 180);
    const keypointUnderInset = {
      x: inset.x + inset.width - 80,
      y: inset.y + inset.height + 40,
    };

    const pos = computeTooltipPlacement({
      anchor: keypointUnderInset,
      tooltip: TOOLTIP,
      container: CONTAINER,
      insetRect: inset,
      dockToInset: true,
    });

    expect(pos.placement).toBe("inset-left");
    const rect = tooltipRect(pos);
    expectInsideContainer(rect);
    expect(rectsOverlap(rect, inset)).toBe(false);
    expect(rectsOverlap(rect, anchorBox(keypointUnderInset.x, keypointUnderInset.y))).toBe(false);
  });

  it("handles insets positioned in all four corners cleanly", () => {
    const corners: Array<{ name: string; inset: Rect; expected: TooltipPlacement }> = [
      {
        name: "top-right",
        inset: { x: 708, y: 12, width: 180, height: 180 },
        expected: "inset-bottom",
      },
      {
        name: "top-left",
        inset: { x: 12, y: 12, width: 180, height: 180 },
        expected: "inset-bottom",
      },
      {
        name: "bottom-right",
        inset: { x: 708, y: 408, width: 180, height: 180 },
        expected: "inset-top",
      },
      {
        name: "bottom-left",
        inset: { x: 12, y: 408, width: 180, height: 180 },
        expected: "inset-top",
      },
    ];

    for (const { inset, expected } of corners) {
      const pos = computeTooltipPlacement({
        anchor: { x: 450, y: 300 },
        tooltip: TOOLTIP,
        container: CONTAINER,
        insetRect: inset,
        dockToInset: true,
      });
      expect(pos.placement).toBe(expected);
      const rect = tooltipRect(pos);
      expectInsideContainer(rect);
      expect(rectsOverlap(rect, inset)).toBe(false);
      expect(rectsOverlap(rect, anchorBox(450, 300))).toBe(false);
    }
  });

  it("falls back to inset-left when container height cannot fit tooltip below top-right inset", () => {
    const shortContainer = { width: 800, height: 240 };
    const inset = getInsetRect(shortContainer.width, 180);
    const pos = computeTooltipPlacement({
      anchor: { x: 200, y: 120 },
      tooltip: TOOLTIP,
      container: shortContainer,
      insetRect: inset,
      dockToInset: true,
    });

    expect(pos.placement).toBe("inset-left");
    const rect = tooltipRect(pos);
    expectInsideContainer(rect, shortContainer);
    expect(rectsOverlap(rect, inset)).toBe(false);
    expect(rectsOverlap(rect, anchorBox(200, 120))).toBe(false);
  });

  it("uses opposite corner when anchor blocks all adjacent inset slots in a cramped container", () => {
    const tightContainer = { width: 520, height: 240 };
    const inset = getInsetRect(tightContainer.width, 180); // x: 328..508, y: 12..192
    // Place anchor right where inset-left (x: 100..320, y: 12..112) would land
    const anchor = { x: 240, y: 60 };
    const pos = computeTooltipPlacement({
      anchor,
      tooltip: TOOLTIP,
      container: tightContainer,
      insetRect: inset,
      dockToInset: true,
    });

    const rect = tooltipRect(pos);
    expectInsideContainer(rect, tightContainer);
    expect(rectsOverlap(rect, inset)).toBe(false);
    expect(rectsOverlap(rect, anchorBox(anchor.x, anchor.y))).toBe(false);
  });
});

describe("computeTooltipPlacement — floating hover & drag without inset", () => {
  it("places to the right of the anchor when there is plenty of space", () => {
    const pos = computeTooltipPlacement({
      anchor: { x: 300, y: 250 },
      tooltip: TOOLTIP,
      container: CONTAINER,
      insetRect: null,
      dockToInset: false,
    });

    expect(pos.placement).toBe("right-top");
    const rect = tooltipRect(pos);
    expectInsideContainer(rect);
    expect(rectsOverlap(rect, anchorBox(300, 250))).toBe(false);
  });

  it("never overlaps the dragged keypoint or clips outside container at any corner or edge", () => {
    const testPoints = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 890, y: 10 },
      { x: 890, y: 590 },
      { x: 10, y: 590 },
      { x: 450, y: 5 },
      { x: 450, y: 595 },
      { x: 5, y: 300 },
      { x: 895, y: 300 },
      { x: 450, y: 300 },
    ];

    for (const pt of testPoints) {
      const pos = computeTooltipPlacement({
        anchor: pt,
        tooltip: TOOLTIP,
        container: CONTAINER,
        insetRect: null,
        dockToInset: false,
      });
      const rect = tooltipRect(pos);
      expectInsideContainer(rect);
      expect(rectsOverlap(rect, anchorBox(pt.x, pt.y))).toBe(false);
    }
  });

  it("flips away from a visible Shift-loupe inset during plain hover", () => {
    const inset = getInsetRect(CONTAINER.width, 180); // x: 708..888, y: 12..192
    // Cursor just to the left of the inset: right-top would overlap the inset.
    const anchor = { x: inset.x - 40, y: 80 };
    const pos = computeTooltipPlacement({
      anchor,
      tooltip: TOOLTIP,
      container: CONTAINER,
      insetRect: inset,
      dockToInset: false,
    });

    expect(pos.placement).toBe("left-top");
    const rect = tooltipRect(pos);
    expectInsideContainer(rect);
    expect(rectsOverlap(rect, inset)).toBe(false);
    expect(rectsOverlap(rect, anchorBox(anchor.x, anchor.y))).toBe(false);
  });

  it("handles zero-sized containers safely without NaN", () => {
    const pos = computeTooltipPlacement({
      anchor: { x: 50, y: 60 },
      tooltip: TOOLTIP,
      container: { width: 0, height: 0 },
    });
    expect(Number.isFinite(pos.left)).toBe(true);
    expect(Number.isFinite(pos.top)).toBe(true);
  });
});
