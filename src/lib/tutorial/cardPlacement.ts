/**
 * Where to put the tutorial coachmark so it never covers what the user has to
 * click: the highlighted target, and any menu or dropdown open on screen (the
 * File menu's Save item, the canvas right-click menu, a select's options).
 *
 * Pure, so it's testable without a DOM. `TutorialOverlay` measures the rects
 * and applies the result.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = "top" | "bottom" | "left" | "right";

/** Space kept between the card and the viewport edge. */
const MARGIN = 8;

/** Fallback order after the step's own placement: beside first, since the
 * sidebar targets are tall and narrow and the canvas sits to their left. */
const SIDE_ORDER: Placement[] = ["left", "right", "bottom", "top"];

function beside(anchor: Rect, side: Placement, card: Size, gap: number) {
  switch (side) {
    case "top":
      return {
        top: anchor.top - card.height - gap,
        left: anchor.left + anchor.width / 2 - card.width / 2,
      };
    case "bottom":
      return {
        top: anchor.top + anchor.height + gap,
        left: anchor.left + anchor.width / 2 - card.width / 2,
      };
    case "right":
      return {
        top: anchor.top + anchor.height / 2 - card.height / 2,
        left: anchor.left + anchor.width + gap,
      };
    case "left":
      return {
        top: anchor.top + anchor.height / 2 - card.height / 2,
        left: anchor.left - card.width - gap,
      };
  }
}

/** Keep the card fully on-screen. */
export function clampToViewport(
  pos: { top: number; left: number },
  card: Size,
  viewport: Size,
) {
  return {
    top: Math.min(Math.max(pos.top, MARGIN), viewport.height - card.height - MARGIN),
    left: Math.min(Math.max(pos.left, MARGIN), viewport.width - card.width - MARGIN),
  };
}

function inflate(r: Rect, by: number): Rect {
  return { top: r.top - by, left: r.left - by, width: r.width + by * 2, height: r.height + by * 2 };
}

function union(rects: Rect[]): Rect {
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  return { top, left, width: right - left, height: bottom - top };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The card's top-left. Tries the step's `placement` beside the target, then
 * the other sides, then the same sides around the target plus any open menus
 * together (e.g. to the right of the File menu, not over its items), then the
 * viewport corners. Takes the first spot that covers none of them once
 * clamped on-screen; if every spot covers something, the one covering least.
 */
export function placeCard(opts: {
  target: Rect;
  placement: Placement;
  card: Size;
  viewport: Size;
  /** Open menus and dropdowns to keep clear of, besides the target. */
  keepClear?: Rect[];
  /** Distance from the target to the card. */
  gap?: number;
  /** Margin around the target and menus that the card may not enter. */
  clearance?: number;
}) {
  const { target, placement, card, viewport, keepClear = [], gap = 12, clearance = 6 } = opts;
  const avoid = [target, ...keepClear].map((r) => inflate(r, clearance));
  const sides = [placement, ...SIDE_ORDER.filter((s) => s !== placement)];
  const anchors = keepClear.length > 0 ? [target, union([target, ...keepClear])] : [target];

  const corners = [
    { top: MARGIN, left: MARGIN },
    { top: MARGIN, left: viewport.width - card.width - MARGIN },
    { top: viewport.height - card.height - MARGIN, left: MARGIN },
    { top: viewport.height - card.height - MARGIN, left: viewport.width - card.width - MARGIN },
  ];
  const candidates = [
    ...anchors.flatMap((a) => sides.map((s) => beside(a, s, card, gap))),
    ...corners,
  ].map((pos) => clampToViewport(pos, card, viewport));

  let best = candidates[0];
  let bestOverlap = Infinity;
  for (const pos of candidates) {
    const rect = { ...pos, ...card };
    const overlap = avoid.reduce((sum, r) => sum + overlapArea(rect, r), 0);
    if (overlap === 0) return pos;
    if (overlap < bestOverlap) {
      best = pos;
      bestOverlap = overlap;
    }
  }
  return best;
}
