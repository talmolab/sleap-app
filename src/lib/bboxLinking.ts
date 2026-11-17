/**
 * Which pose instance a bounding box belongs to (#488). A box drawn around an
 * animal is linked to that animal's instance, so it shares its color and
 * track and sleap-nn can pair box and pose.
 */
import type { Instance } from "@talmolab/sleap-io.js";

/** Share of an instance's visible points that must fall in a box to count as enclosed. */
export const ENCLOSED_FRACTION = 0.8;

/**
 * Whether most (≥ {@link ENCLOSED_FRACTION}) of the instance's visible points
 * are inside the axis-aligned rect (source coordinates). An instance with no
 * visible points is never inside.
 */
export function instanceInsideRect(
  inst: Instance,
  rect: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  let visible = 0;
  let inside = 0;
  for (const p of inst.points) {
    const [x, y] = p.xy;
    if (!p.visible || Number.isNaN(x) || Number.isNaN(y)) continue;
    visible++;
    if (x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2) inside++;
  }
  return visible > 0 && inside / visible >= ENCLOSED_FRACTION;
}
