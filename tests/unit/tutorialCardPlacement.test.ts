import { describe, it, expect } from "../bun-test";
import { placeCard, type Rect } from "@/lib/tutorial/cardPlacement";

const viewport = { width: 1280, height: 800 };
const card = { width: 300, height: 200 };

function cardRect(pos: { top: number; left: number }): Rect {
  return { ...pos, ...card };
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

function inViewport(r: Rect): boolean {
  return (
    r.left >= 0 &&
    r.top >= 0 &&
    r.left + r.width <= viewport.width &&
    r.top + r.height <= viewport.height
  );
}

describe("placeCard", () => {
  it("uses the step's placement when it fits", () => {
    const target = { top: 400, left: 1000, width: 260, height: 32 };
    const pos = placeCard({ target, placement: "left", card, viewport });
    expect(pos.left + card.width).toBeLessThanOrEqual(target.left);
    expect(overlaps(cardRect(pos), target)).toBe(false);
  });

  it("moves beside a sidebar button near the top instead of covering it", () => {
    // "top" has no room above this button; clamping it on-screen would put
    // the card right over the button.
    const target = { top: 40, left: 1000, width: 260, height: 32 };
    const pos = placeCard({ target, placement: "top", card, viewport });
    expect(overlaps(cardRect(pos), target)).toBe(false);
    expect(inViewport(cardRect(pos))).toBe(true);
  });

  it("falls back to the other side when the target is at the screen edge", () => {
    const target = { top: 300, left: 10, width: 120, height: 32 };
    const pos = placeCard({ target, placement: "left", card, viewport });
    expect(overlaps(cardRect(pos), target)).toBe(false);
    expect(pos.left).toBeGreaterThan(target.left + target.width);
  });

  it("keeps clear of an open File menu and its items", () => {
    const trigger = { top: 4, left: 8, width: 40, height: 24 };
    const menu = { top: 30, left: 8, width: 220, height: 320 };
    const pos = placeCard({
      target: trigger,
      placement: "right",
      card,
      viewport,
      keepClear: [menu],
    });
    expect(overlaps(cardRect(pos), trigger)).toBe(false);
    expect(overlaps(cardRect(pos), menu)).toBe(false);
    expect(inViewport(cardRect(pos))).toBe(true);
  });

  it("keeps clear of a right-click menu opened over the canvas", () => {
    const target = { top: 100, left: 980, width: 300, height: 600 };
    // Right where "left of the target" would land.
    const contextMenu = { top: 300, left: 700, width: 200, height: 250 };
    const pos = placeCard({
      target,
      placement: "left",
      card,
      viewport,
      keepClear: [contextMenu],
    });
    expect(overlaps(cardRect(pos), target)).toBe(false);
    expect(overlaps(cardRect(pos), contextMenu)).toBe(false);
  });

  it("still returns an on-screen spot when nothing is free", () => {
    const target = { top: 0, left: 0, width: viewport.width, height: viewport.height };
    const pos = placeCard({ target, placement: "left", card, viewport });
    expect(inViewport(cardRect(pos))).toBe(true);
  });
});
