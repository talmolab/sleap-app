/**
 * Pure non-overlapping tooltip placement geometry for the video canvas.
 *
 * Keeps the node hover/drag tooltip from obscuring the dragged keypoint or the
 * magnifier inset, and clamps it cleanly inside the canvas container bounds.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export type TooltipPlacement =
  | "inset-bottom"
  | "inset-top"
  | "inset-left"
  | "inset-right"
  | "right-top"
  | "left-top"
  | "right-bottom"
  | "left-bottom"
  | "bottom"
  | "top"
  | "opposite-corner"
  | "clamped";

export interface TooltipPlacementInput {
  /** Keypoint or pointer position in container-local coordinates. */
  anchor: Point2D;
  /** Tooltip dimensions in CSS pixels. */
  tooltip: Size;
  /** Canvas container dimensions in CSS pixels. */
  container: Size;
  /** Magnifier inset rect in container-local coordinates, if visible. */
  insetRect?: Rect | null;
  /**
   * When true and `insetRect` is provided (e.g. while dragging a node with the
   * magnifier visible), dock the tooltip neatly aligned to the inset box so it
   * never drifts over the dragged keypoint.
   */
  dockToInset?: boolean;
  /** Offset from the anchor point when floating near the cursor/node (px). */
  anchorOffset?: number;
  /** Minimum exclusion radius around the anchor that must not be overlapped (px). */
  anchorClearance?: number;
  /** Gap between the inset box and a docked tooltip (px). */
  insetGap?: number;
  /** Minimum margin from container edges (px). */
  margin?: number;
}

export interface TooltipPlacementResult {
  left: number;
  top: number;
  placement: TooltipPlacement;
}

/** Default inset offset from the top-right corner of the canvas container (px). */
export const INSET_MARGIN = 12;
export const DEFAULT_ANCHOR_OFFSET = 16;
export const DEFAULT_ANCHOR_CLEARANCE = 14;
export const DEFAULT_INSET_GAP = 8;
export const DEFAULT_EDGE_MARGIN = 8;

/**
 * Container-local bounding rectangle of the top-right magnifier inset.
 * Shared by VideoPlayer's inset renderer and tooltip placement so both use the
 * exact same coordinates.
 */
export function getInsetRect(
  containerWidth: number,
  insetSize: number,
  margin: number = INSET_MARGIN,
): Rect {
  return {
    x: Math.max(0, containerWidth - margin - insetSize),
    y: margin,
    width: insetSize,
    height: insetSize,
  };
}

/** True when two axis-aligned rectangles overlap with positive area. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Squared distance from a point to the nearest point inside a rectangle (0 if inside). */
function distSqPointToRect(p: Point2D, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return dx * dx + dy * dy;
}

/**
 * Compute non-overlapping container-local `(left, top)` coordinates for a
 * canvas tooltip.
 */
export function computeTooltipPlacement(
  input: TooltipPlacementInput,
): TooltipPlacementResult {
  const {
    anchor,
    tooltip,
    container,
    insetRect = null,
    dockToInset = false,
    anchorOffset = DEFAULT_ANCHOR_OFFSET,
    anchorClearance = DEFAULT_ANCHOR_CLEARANCE,
    insetGap = DEFAULT_INSET_GAP,
    margin = DEFAULT_EDGE_MARGIN,
  } = input;

  if (container.width <= 0 || container.height <= 0) {
    return {
      left: anchor.x + anchorOffset,
      top: anchor.y - 8,
      placement: "right-top",
    };
  }

  const maxX = Math.max(margin, container.width - tooltip.width - margin);
  const maxY = Math.max(margin, container.height - tooltip.height - margin);
  const clampX = (x: number) => Math.max(margin, Math.min(maxX, x));
  const clampY = (y: number) => Math.max(margin, Math.min(maxY, y));

  const fitsInContainer = (r: Rect): boolean =>
    r.x >= margin &&
    r.y >= margin &&
    r.x + r.width <= container.width - margin &&
    r.y + r.height <= container.height - margin;

  const anchorBox: Rect = {
    x: anchor.x - anchorClearance,
    y: anchor.y - anchorClearance,
    width: anchorClearance * 2,
    height: anchorClearance * 2,
  };

  const makeRect = (x: number, y: number): Rect => ({
    x,
    y,
    width: tooltip.width,
    height: tooltip.height,
  });

  const avoidsInset = (r: Rect): boolean => !insetRect || !rectsOverlap(r, insetRect);
  const avoidsAnchor = (r: Rect): boolean => !rectsOverlap(r, anchorBox);

  // 1. Inset-docked mode (node drag while magnifier inset is visible).
  if (dockToInset && insetRect) {
    const insetOnRight = insetRect.x + insetRect.width / 2 >= container.width / 2;
    const insetOnBottom = insetRect.y + insetRect.height / 2 >= container.height / 2;

    // Align horizontally with the inset's outer edge (right edge when on right,
    // left edge when on left) so the tooltip forms a clean vertical column with
    // the magnifier box.
    const alignedX = clampX(
      insetOnRight ? insetRect.x + insetRect.width - tooltip.width : insetRect.x,
    );
    const alignedY = clampY(
      insetOnBottom ? insetRect.y + insetRect.height - tooltip.height : insetRect.y,
    );

    const bottomCandidate = {
      placement: "inset-bottom" as const,
      rect: makeRect(alignedX, insetRect.y + insetRect.height + insetGap),
    };
    const topCandidate = {
      placement: "inset-top" as const,
      rect: makeRect(alignedX, insetRect.y - tooltip.height - insetGap),
    };
    const leftCandidate = {
      placement: "inset-left" as const,
      rect: makeRect(insetRect.x - tooltip.width - insetGap, alignedY),
    };
    const rightCandidate = {
      placement: "inset-right" as const,
      rect: makeRect(insetRect.x + insetRect.width + insetGap, alignedY),
    };

    const candidates = [
      ...(insetOnBottom ? [topCandidate, bottomCandidate] : [bottomCandidate, topCandidate]),
      ...(insetOnRight ? [leftCandidate, rightCandidate] : [rightCandidate, leftCandidate]),
    ];

    // Prefer a docked side that fits in bounds and avoids both inset and anchor.
    for (const c of candidates) {
      if (fitsInContainer(c.rect) && avoidsInset(c.rect) && avoidsAnchor(c.rect)) {
        return { left: c.rect.x, top: c.rect.y, placement: c.placement };
      }
    }

    // If the dragged keypoint is directly over the available inset-adjacent slots,
    // try the opposite corner away from both the inset and the anchor.
    const oppositeCorner = makeRect(
      clampX(insetOnRight ? margin : maxX),
      clampY(insetOnBottom ? margin : maxY),
    );
    if (avoidsInset(oppositeCorner) && avoidsAnchor(oppositeCorner)) {
      return {
        left: oppositeCorner.x,
        top: oppositeCorner.y,
        placement: "opposite-corner",
      };
    }

    // Fallback: best candidate that avoids the inset and maximizes distance from anchor.
    const nonOverlappingInset = candidates.filter(
      (c) => fitsInContainer(c.rect) && avoidsInset(c.rect),
    );
    if (nonOverlappingInset.length > 0) {
      let best = nonOverlappingInset[0];
      let bestDist = distSqPointToRect(anchor, best.rect);
      for (const c of nonOverlappingInset.slice(1)) {
        const d = distSqPointToRect(anchor, c.rect);
        if (d > bestDist) {
          best = c;
          bestDist = d;
        }
      }
      return { left: best.rect.x, top: best.rect.y, placement: best.placement };
    }

    const fallback = candidates[0];
    return {
      left: clampX(fallback.rect.x),
      top: clampY(fallback.rect.y),
      placement: "clamped",
    };
  }

  // 2. Floating mode (plain hover, or dragging when the magnifier inset is hidden).
  const floatCandidates: Array<{ placement: TooltipPlacement; rect: Rect }> = [
    {
      placement: "right-top",
      rect: makeRect(anchor.x + anchorOffset, anchor.y - 8),
    },
    {
      placement: "left-top",
      rect: makeRect(anchor.x - anchorOffset - tooltip.width, anchor.y - 8),
    },
    {
      placement: "right-bottom",
      rect: makeRect(anchor.x + anchorOffset, anchor.y - tooltip.height + 8),
    },
    {
      placement: "left-bottom",
      rect: makeRect(anchor.x - anchorOffset - tooltip.width, anchor.y - tooltip.height + 8),
    },
    {
      placement: "bottom",
      rect: makeRect(clampX(anchor.x - tooltip.width / 2), anchor.y + anchorOffset),
    },
    {
      placement: "top",
      rect: makeRect(
        clampX(anchor.x - tooltip.width / 2),
        anchor.y - anchorOffset - tooltip.height,
      ),
    },
  ];

  // Pass 1: strictly inside container, clear of both anchor and inset.
  for (const c of floatCandidates) {
    if (fitsInContainer(c.rect) && avoidsAnchor(c.rect) && avoidsInset(c.rect)) {
      return { left: c.rect.x, top: c.rect.y, placement: c.placement };
    }
  }

  // Pass 2: clamp into container bounds (e.g. near top/bottom edge where a
  // small vertical nudge keeps the tooltip clear of the anchor and inset).
  for (const c of floatCandidates) {
    const clamped = makeRect(clampX(c.rect.x), clampY(c.rect.y));
    if (avoidsAnchor(clamped) && avoidsInset(clamped)) {
      return { left: clamped.x, top: clamped.y, placement: c.placement };
    }
  }

  // Pass 3: avoid the anchor even if cramped container forces overlap with inset.
  for (const c of floatCandidates) {
    const clamped = makeRect(clampX(c.rect.x), clampY(c.rect.y));
    if (avoidsAnchor(clamped)) {
      return { left: clamped.x, top: clamped.y, placement: c.placement };
    }
  }

  // Pass 4: place in the container corner farthest from the anchor.
  const corners = [
    makeRect(margin, margin),
    makeRect(maxX, margin),
    makeRect(margin, maxY),
    makeRect(maxX, maxY),
  ];
  let bestCorner = corners[0];
  let bestScore = -1;
  for (const corner of corners) {
    const insetBonus = avoidsInset(corner) ? 1e9 : 0;
    const score = insetBonus + distSqPointToRect(anchor, corner);
    if (score > bestScore) {
      bestScore = score;
      bestCorner = corner;
    }
  }
  return { left: bestCorner.x, top: bestCorner.y, placement: "clamped" };
}
