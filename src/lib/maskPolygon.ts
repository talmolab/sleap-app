/**
 * Geometry for the mask polygon tool: turning a drawn polygon into mask
 * pixels, adding it to or cutting it from a mask, and finding the mask under
 * a point. Pure, so it's unit-tested without a canvas.
 *
 * Polygons are in source (full-frame) coordinates. A mask is a raster in its
 * own pixel grid, placed by `scale` / `offset` (`source = maskPx / scale +
 * offset`), so a polygon is mapped into that grid before it's filled. Pixel
 * (c, r) covers `[c, c + 1) x [r, r + 1)` in mask space and is inside when its
 * center is (sleap-io's `rasterizeGeometry`).
 */
import { rasterizeGeometry, type SegmentationMask } from "@talmolab/sleap-io.js";
import { ENCLOSED_FRACTION } from "@/lib/bboxLinking";

export type Pt = [number, number];

/** Fewest vertices a polygon needs to enclose anything. */
export const MIN_POLYGON_POINTS = 3;

/** The pixel grid of a mask: its size and placement in source coordinates. */
export interface MaskGrid {
  height: number;
  width: number;
  scale: [number, number];
  offset: [number, number];
}

/** Fill `points` (source coordinates) into a raster on `grid`. */
export function polygonRaster(points: readonly Pt[], grid: MaskGrid): Uint8Array {
  const [sx, sy] = grid.scale;
  const [ox, oy] = grid.offset;
  const ring = points.map(([x, y]) => [(x - ox) * sx, (y - oy) * sy]);
  if (ring.length >= MIN_POLYGON_POINTS) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  }
  return rasterizeGeometry({ type: "Polygon", coordinates: [ring] }, grid.height, grid.width);
}

/** `base` with `shape` added (union) or cut out (difference). Returns a new array. */
export function combineRasters(
  base: ArrayLike<number>,
  shape: ArrayLike<number>,
  op: "add" | "cut",
): Uint8Array {
  const out = new Uint8Array(base.length);
  for (let i = 0; i < out.length; i++) {
    const b = base[i] ? 1 : 0;
    const s = shape[i] ? 1 : 0;
    out[i] = op === "add" ? b | s : b & (s ^ 1);
  }
  return out;
}

/** True when the raster has no foreground pixel. */
export function isEmptyRaster(raster: ArrayLike<number>): boolean {
  for (let i = 0; i < raster.length; i++) if (raster[i]) return false;
  return true;
}

/** Even-odd point-in-polygon test (ring need not be closed). */
export function pointInPolygon(x: number, y: number, points: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether `mask` covers the source point (x, y). */
export function maskContains(mask: SegmentationMask, x: number, y: number): boolean {
  const c = Math.floor((x - mask.offset[0]) * mask.scale[0]);
  const r = Math.floor((y - mask.offset[1]) * mask.scale[1]);
  if (c < 0 || r < 0 || c >= mask.width || r >= mask.height) return false;
  return mask.data[r * mask.width + c] !== 0;
}

/**
 * Index of the topmost mask (last drawn) covering the source point, or null.
 * When `preferred` covers the point too it wins, so clicking inside the
 * selected mask keeps it selected even where masks overlap.
 */
export function maskIndexAt(
  masks: readonly SegmentationMask[],
  x: number,
  y: number,
  preferred: number | null = null,
): number | null {
  if (preferred !== null && masks[preferred] && maskContains(masks[preferred], x, y)) return preferred;
  for (let i = masks.length - 1; i >= 0; i--) {
    if (maskContains(masks[i], x, y)) return i;
  }
  return null;
}

/** True when `p` is within `tolerance` of the first vertex of a polygon that can close. */
export function closesPolygon(points: readonly Pt[], p: Pt, tolerance: number): boolean {
  if (points.length < MIN_POLYGON_POINTS) return false;
  const [fx, fy] = points[0];
  return Math.hypot(p[0] - fx, p[1] - fy) <= tolerance;
}

/** Drop consecutive vertices closer than `eps` (a double-click adds two). */
export function dedupePolygon(points: readonly Pt[], eps: number): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  return out;
}

/**
 * Whether most (≥ {@link ENCLOSED_FRACTION}) of a pose instance's visible
 * points lie inside the polygon: the rule a drawn box uses to link itself to
 * the instance it encloses.
 */
export function instanceInsidePolygon(
  inst: { points: readonly { xy: readonly number[]; visible: boolean }[] },
  points: readonly Pt[],
): boolean {
  let visible = 0;
  let inside = 0;
  for (const p of inst.points) {
    const [x, y] = p.xy;
    if (!p.visible || Number.isNaN(x) || Number.isNaN(y)) continue;
    visible++;
    if (pointInPolygon(x, y, points)) inside++;
  }
  return visible > 0 && inside / visible >= ENCLOSED_FRACTION;
}

/** What a finished polygon does. */
export type PolygonAction =
  | { kind: "new" }
  | { kind: "edit"; op: "add" | "cut"; index: number }
  | { kind: "needsSelection" };

/**
 * Decide what a finished polygon does, from the modifiers held at its first
 * click and the selected mask. As in labelroi, every polygon is its own mask
 * by default, whatever is selected. Alt cuts it from the selected mask (with
 * nothing selected there's nothing to cut). Shift adds it to the selected mask,
 * for one animal in several pieces (with nothing selected, a new mask).
 */
export function polygonAction(
  mods: { cut: boolean; add: boolean },
  selected: number | null,
): PolygonAction {
  if (mods.cut) return selected === null ? { kind: "needsSelection" } : { kind: "edit", op: "cut", index: selected };
  if (mods.add && selected !== null) return { kind: "edit", op: "add", index: selected };
  return { kind: "new" };
}
