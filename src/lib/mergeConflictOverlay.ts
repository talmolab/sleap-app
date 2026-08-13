/**
 * Overlay builder for the merge-conflict preview canvas (A3).
 *
 * A conflict clashes a BASE instance against a DONOR instance on one frame. To
 * let the user decide keep-base / keep-donor / keep-both, the preview draws both
 * poses over the base video frame in two fixed colors. This module reuses the
 * clip-exporter's pure {@link buildExportRenderedInstances} (crop-aware node
 * coords + edges, no interactive concerns) and overrides the per-instance color
 * to a fixed base/donor color so the two files are visually distinct regardless
 * of track/palette coloring. The actual canvas paint uses `renderInstances`
 * ({@link file://../canvas/SkeletonRenderer.ts}); see the ConflictPreviewCanvas.
 */

import type { Instance, Track, Video } from "@/types";
import type { RenderedInstance } from "@/canvas/SkeletonRenderer";
import { getInstanceColor, type RGB } from "@/lib/colorPalettes";
import { buildExportRenderedInstances } from "@/lib/videoExport";

/**
 * Donor pose color (magenta) in the conflict preview — a fixed, distinct
 * "incoming" color that won't collide with the base's blue/orange track colors.
 * `RenderedInstance.color` is an RGB tuple (fed to `rgbToCSS`), NOT a CSS string.
 */
export const CONFLICT_DONOR_COLOR: RGB = [236, 72, 153];

export interface ConflictOverlayContext {
  /** The base video the conflict frame belongs to (for crop-aware coords). */
  video: Video | null;
  /** Project tracks (so the base pose gets its real track color). */
  tracks: Track[];
  /** Color settings from the app store, so BASE matches the on-canvas instance. */
  palette?: string;
  distinctlyColor?: string;
  colorPredicted?: boolean;
  /**
   * Frame index of each base instance (from {@link Conflict.baseColorIndices}),
   * used to color the base pose exactly as the main canvas does. Falls back to
   * array order when absent.
   */
  baseColorIndices?: number[];
}

/**
 * Build overlay {@link RenderedInstance}s for one conflict frame. The BASE pose
 * keeps its real track/palette color (so it matches the instance drawn on the
 * main canvas); only the DONOR pose is recolored to the fixed
 * {@link CONFLICT_DONOR_COLOR} so "incoming" reads distinctly regardless of the
 * base's colors. Geometry (nodes, edges, crop-aware coords) comes from the
 * shared exporter builder.
 */
export function buildConflictOverlay(
  baseInstances: readonly Instance[],
  donorInstances: readonly Instance[],
  ctx: ConflictOverlayContext
): { base: RenderedInstance[]; donor: RenderedInstance[] } {
  const opts = {
    palette: ctx.palette ?? "standard",
    distinctlyColor: ctx.distinctlyColor ?? "track",
    colorPredicted: ctx.colorPredicted ?? false,
    showNonVisibleNodes: true,
    tracks: ctx.tracks,
    video: ctx.video,
  };

  // Re-color the base pose using each instance's FRAME index (not its position
  // in this conflict's small array) so instance 0 = palette[0], instance 1 =
  // palette[1]… exactly as on the main canvas. Tracked instances color by track
  // (index ignored) inside getInstanceColor.
  const base = buildExportRenderedInstances(baseInstances, opts).map((ri, k) => ({
    ...ri,
    color: getInstanceColor(
      opts.palette,
      opts.distinctlyColor,
      ctx.baseColorIndices?.[k] ?? k,
      baseInstances[k].track,
      opts.tracks,
      false,
      opts.colorPredicted
    ),
  }));
  const donor = buildExportRenderedInstances(donorInstances, opts).map((ri) => ({
    ...ri,
    color: CONFLICT_DONOR_COLOR,
    nodeColors: undefined,
    edgeColors: undefined,
  }));

  return { base, donor };
}

/** A rectangle in source-pixel space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box (source pixels) around the visible nodes of the given rendered
 * instances, padded by `padFrac` of each dimension and expanded to at least
 * `minSize`. Returns null if no node is visible/finite. Used to crop the preview
 * canvas to the conflict region so the poses (and their small offset) are big
 * enough to compare instead of lost in the full frame.
 */
export function conflictCropRect(
  instances: ReadonlyArray<{
    nodes: ReadonlyArray<{ x: number; y: number; visible: boolean }>;
  }>,
  opts: { padFrac?: number; minSize?: number } = {}
): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const inst of instances) {
    for (const n of inst.nodes) {
      if (!n.visible || Number.isNaN(n.x) || Number.isNaN(n.y)) continue;
      any = true;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
  }
  if (!any) return null;

  const padFrac = opts.padFrac ?? 0.6;
  const minSize = opts.minSize ?? 40;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const w = Math.max((maxX - minX) * (1 + padFrac), minSize);
  const h = Math.max((maxY - minY) * (1 + padFrac), minSize);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** How a source frame maps into the preview canvas (fit-and-center / letterbox). */
export interface FitTransform {
  /** Uniform scale from source pixels to canvas pixels. */
  scale: number;
  /** Left padding (canvas px) when the fitted frame is narrower than the canvas. */
  offsetX: number;
  /** Top padding (canvas px) when the fitted frame is shorter than the canvas. */
  offsetY: number;
  displayWidth: number;
  displayHeight: number;
}

/**
 * Fit a `srcW`×`srcH` frame into a `canvasW`×`canvasH` canvas, preserving aspect
 * ratio and centering (letterbox/pillarbox). Instance coords (source pixels) map
 * to canvas via `ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)`.
 */
export function computeFitTransform(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number
): FitTransform {
  if (srcW <= 0 || srcH <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0, displayWidth: 0, displayHeight: 0 };
  }
  const scale = Math.min(canvasW / srcW, canvasH / srcH);
  const displayWidth = srcW * scale;
  const displayHeight = srcH * scale;
  return {
    scale,
    offsetX: (canvasW - displayWidth) / 2,
    offsetY: (canvasH - displayHeight) / 2,
    displayWidth,
    displayHeight,
  };
}
