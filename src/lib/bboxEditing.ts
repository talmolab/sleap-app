/**
 * Pure geometry for drawing and editing bounding boxes on the canvas (#488).
 *
 * Everything here works in image (scene) coordinates — the same space as
 * `RenderedBbox.corners`. VideoPlayer converts to source coordinates (for
 * cropped videos) only when it commits an edit.
 */
import type { RenderedBbox } from "@/canvas/BboxRenderer";

/** An axis-aligned rectangle with x1 ≤ x2 and y1 ≤ y2. */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** What part of a box a pointer grabbed. Compass names are resize handles. */
export type BboxHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const RESIZE_HANDLES: Exclude<BboxHandle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Rectangle spanned by two points, normalized. */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x1: Math.min(a.x, b.x),
    y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x),
    y2: Math.max(a.y, b.y),
  };
}

/** Bounds of a rendered box's corners. */
export function rectOfCorners(corners: [number, number][]): Rect {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** Handle positions of an axis-aligned rect. */
export function handlePoints(r: Rect): Record<Exclude<BboxHandle, "move">, [number, number]> {
  const cx = (r.x1 + r.x2) / 2;
  const cy = (r.y1 + r.y2) / 2;
  return {
    nw: [r.x1, r.y1],
    n: [cx, r.y1],
    ne: [r.x2, r.y1],
    e: [r.x2, cy],
    se: [r.x2, r.y2],
    s: [cx, r.y2],
    sw: [r.x1, r.y2],
    w: [r.x1, cy],
  };
}

/** Distance from point p to segment ab. */
function distToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Whether p is inside a convex polygon (the box corners, either winding). */
function insidePolygon(px: number, py: number, corners: [number, number][]): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const cross = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface BboxHit {
  /** Index into the frame's `bboxes`. */
  index: number;
  handle: BboxHandle;
}

/**
 * What the pointer at (x, y) grabs, or null. `tol` is the grab distance in
 * image pixels. The selected box wins: its resize handles first (axis-aligned
 * boxes only), then its border or inside (move). Other boxes are grabbed by
 * their border only, so clicking on an animal inside a box still reaches the
 * pose underneath. Later boxes (drawn on top) win ties.
 */
export function hitTestBbox(
  boxes: readonly RenderedBbox[],
  x: number,
  y: number,
  tol: number,
  selectedIndex: number | null,
): BboxHit | null {
  const selected = selectedIndex === null ? undefined : boxes.find((b) => b.index === selectedIndex);
  if (selected) {
    if (!selected.isRotated) {
      const pts = handlePoints(rectOfCorners(selected.corners));
      for (const h of RESIZE_HANDLES) {
        if (Math.hypot(x - pts[h][0], y - pts[h][1]) <= tol) return { index: selected.index, handle: h };
      }
    }
    if (onBorder(selected, x, y, tol) || insidePolygon(x, y, selected.corners)) {
      return { index: selected.index, handle: "move" };
    }
  }
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (onBorder(boxes[i], x, y, tol)) return { index: boxes[i].index, handle: "move" };
  }
  return null;
}

function onBorder(box: RenderedBbox, x: number, y: number, tol: number): boolean {
  const c = box.corners;
  for (let i = 0; i < c.length; i++) {
    if (distToSegment(x, y, c[i], c[(i + 1) % c.length]) <= tol) return true;
  }
  return false;
}

/**
 * The rect after dragging `handle` of `orig` by (dx, dy). Moving keeps the
 * size; resizing moves only the grabbed edges and re-normalizes, so dragging
 * past the opposite edge flips the box instead of inverting it.
 */
export function dragRect(orig: Rect, handle: BboxHandle, dx: number, dy: number): Rect {
  if (handle === "move") {
    return { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy };
  }
  let { x1, y1, x2, y2 } = orig;
  if (handle.includes("w")) x1 += dx;
  if (handle.includes("e")) x2 += dx;
  if (handle.includes("n")) y1 += dy;
  if (handle.includes("s")) y2 += dy;
  return rectFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 });
}

/** CSS cursor for a handle. */
export function handleCursor(handle: BboxHandle): string {
  switch (handle) {
    case "move":
      return "move";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
  }
}

/** Smallest box side (image px) a drag must reach to create a box. */
export const MIN_BBOX_SIZE = 3;
