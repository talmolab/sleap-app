/**
 * Alt+drag zoom box on the video canvas (PyQt SLEAP `widgets/video.py`):
 * the gesture check and the zoom/pan math VideoPlayer applies on release.
 */

import { describe, it, expect } from "../bun-test";
import {
  isZoomBoxGesture,
  frameToRotated,
  isZoomBoxTooSmall,
  viewForZoomRect,
  MAX_ZOOM,
  MIN_ZOOM,
} from "@/lib/zoomBox";
import { CANVAS_GESTURES } from "@/lib/canvasGestures";

const mods = (m: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>>) => ({
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...m,
});

/** Where a rotated-scene point lands on the canvas (VideoPlayer's forward transform). */
const toCanvas = (x: number, y: number, v: { zoom: number; panX: number; panY: number }, baseScale: number, offX: number, offY: number) => ({
  x: x * baseScale * v.zoom + offX + v.panX,
  y: y * baseScale * v.zoom + offY + v.panY,
});

describe("isZoomBoxGesture", () => {
  // Only Alt on its own zooms, like PyQt's `modifiers() == Qt.AltModifier`;
  // Alt+Shift+click is the node-selection toggle and must not start a zoom box.
  it("is Alt alone", () => {
    expect(isZoomBoxGesture(mods({ altKey: true }))).toBe(true);
    expect(isZoomBoxGesture(mods({}))).toBe(false);
    expect(isZoomBoxGesture(mods({ altKey: true, shiftKey: true }))).toBe(false);
    expect(isZoomBoxGesture(mods({ altKey: true, ctrlKey: true }))).toBe(false);
    expect(isZoomBoxGesture(mods({ altKey: true, metaKey: true }))).toBe(false);
  });
});

describe("frameToRotated", () => {
  // Must be the exact inverse of VideoPlayer.canvasToScene's rotation step, or
  // the zoom box lands in the wrong place on a rotated video.
  const inverse = (sx: number, sy: number, rotation: number, fw: number, fh: number) => {
    if (rotation === 90) return { x: sy, y: fh - sx };
    if (rotation === 180) return { x: fw - sx, y: fh - sy };
    if (rotation === 270) return { x: fw - sy, y: sx };
    return { x: sx, y: sy };
  };
  it("round-trips with canvasToScene for every rotation", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const r = frameToRotated(30, 70, rotation, 640, 480);
      expect(inverse(r.x, r.y, rotation, 640, 480)).toEqual({ x: 30, y: 70 });
    }
  });
});

describe("isZoomBoxTooSmall", () => {
  // A plain Alt+click (or a tiny wiggle) must not zoom in wildly.
  it("ignores boxes a few screen pixels across", () => {
    expect(isZoomBoxTooSmall({ x1: 0, y1: 0, x2: 0, y2: 0 }, 1)).toBe(true);
    expect(isZoomBoxTooSmall({ x1: 0, y1: 0, x2: 100, y2: 2 }, 1)).toBe(true);
    expect(isZoomBoxTooSmall({ x1: 0, y1: 0, x2: 3, y2: 3 }, 1)).toBe(true);
    expect(isZoomBoxTooSmall({ x1: 0, y1: 0, x2: 20, y2: 20 }, 1)).toBe(false);
    // Measured on screen: 3 units at 4 px per unit is a real 12 px box.
    expect(isZoomBoxTooSmall({ x1: 0, y1: 0, x2: 3, y2: 3 }, 4)).toBe(false);
  });
});

describe("viewForZoomRect", () => {
  const cw = 800, ch = 600, baseScale = 1.25, offX = 0, offY = 0;

  // After release the box should be centered and fill the view along its
  // tighter side, with all of it still visible.
  it("centers the box and fits it in the canvas", () => {
    const rect = { x1: 100, y1: 100, x2: 300, y2: 200 };
    const v = viewForZoomRect(rect, cw, ch, baseScale, offX, offY)!;
    const a = toCanvas(100, 100, v, baseScale, offX, offY);
    const b = toCanvas(300, 200, v, baseScale, offX, offY);
    expect((a.x + b.x) / 2).toBeCloseTo(cw / 2);
    expect((a.y + b.y) / 2).toBeCloseTo(ch / 2);
    // 200x100 box into 800x600: width is the tight side.
    expect(b.x - a.x).toBeCloseTo(cw);
    expect(b.y - a.y).toBeLessThanOrEqual(ch);
  });

  // Dragging up-left draws the same box as dragging down-right.
  it("does not care which corner the drag started from", () => {
    const fwd = viewForZoomRect({ x1: 10, y1: 20, x2: 110, y2: 90 }, cw, ch, baseScale, 5, 7);
    const back = viewForZoomRect({ x1: 110, y1: 90, x2: 10, y2: 20 }, cw, ch, baseScale, 5, 7);
    expect(back).toEqual(fwd);
  });

  // Same limits as scroll-zoom, so a tiny box can't zoom past them.
  it("clamps to the scroll-zoom limits", () => {
    const tiny = viewForZoomRect({ x1: 0, y1: 0, x2: 0.01, y2: 0.01 }, cw, ch, baseScale, offX, offY)!;
    expect(tiny.zoom).toBe(MAX_ZOOM);
    const huge = viewForZoomRect({ x1: 0, y1: 0, x2: 1e6, y2: 1e6 }, cw, ch, baseScale, offX, offY)!;
    expect(huge.zoom).toBe(MIN_ZOOM);
  });

  // An empty box or an unmeasured canvas gives no zoom at all.
  it("returns null for an empty box or canvas", () => {
    expect(viewForZoomRect({ x1: 5, y1: 5, x2: 5, y2: 50 }, cw, ch, baseScale, offX, offY)).toBeNull();
    expect(viewForZoomRect({ x1: 0, y1: 0, x2: 50, y2: 50 }, 0, ch, baseScale, offX, offY)).toBeNull();
  });
});

describe("Help ▸ Keyboard Shortcuts", () => {
  // The gesture list in the Shortcuts dialog should mention the new zoom gestures.
  it("lists Alt+drag zoom and Alt+double-click reset", () => {
    const alt = CANVAS_GESTURES.filter((g) => g.modifiers === "Alt").map((g) => g.action);
    expect(alt).toContain("Zoom to the box you draw");
    expect(alt).toContain("Reset the zoom");
  });
});
