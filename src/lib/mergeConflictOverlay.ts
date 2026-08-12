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
import type { RGB } from "@/lib/colorPalettes";
import { buildExportRenderedInstances } from "@/lib/videoExport";

/** Base pose color (blue-500) in the conflict preview. `RenderedInstance.color`
 *  is an RGB tuple (fed to `rgbToCSS`), NOT a CSS string. */
export const CONFLICT_BASE_COLOR: RGB = [59, 130, 246];
/** Donor pose color (orange-500) in the conflict preview. */
export const CONFLICT_DONOR_COLOR: RGB = [249, 115, 22];

export interface ConflictOverlayContext {
  /** The base video the conflict frame belongs to (for crop-aware coords). */
  video: Video | null;
  /** Project tracks (passed through to the shared builder; color is overridden). */
  tracks: Track[];
}

/**
 * Build blue base + orange donor {@link RenderedInstance}s for one conflict
 * frame. Geometry (nodes, edges, crop-aware coords, visibility) comes from the
 * shared exporter builder; only the color is forced so base vs donor read
 * clearly. `nodeColors`/`edgeColors` are cleared so the uniform base/donor color
 * wins over any per-node/edge palette coloring.
 */
export function buildConflictOverlay(
  baseInstances: readonly Instance[],
  donorInstances: readonly Instance[],
  ctx: ConflictOverlayContext
): { base: RenderedInstance[]; donor: RenderedInstance[] } {
  const opts = {
    palette: "standard",
    // Not "node"/"edge" → the builder leaves nodeColors/edgeColors undefined, so
    // the single forced color applies uniformly.
    distinctlyColor: "track",
    colorPredicted: true,
    showNonVisibleNodes: true,
    tracks: ctx.tracks,
    video: ctx.video,
  };

  const force = (
    instances: readonly Instance[],
    color: RGB
  ): RenderedInstance[] =>
    buildExportRenderedInstances(instances, opts).map((ri) => ({
      ...ri,
      color,
      nodeColors: undefined,
      edgeColors: undefined,
    }));

  return {
    base: force(baseInstances, CONFLICT_BASE_COLOR),
    donor: force(donorInstances, CONFLICT_DONOR_COLOR),
  };
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
