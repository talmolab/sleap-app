/**
 * Pure routing helper for double-clicking an empty region of the video canvas
 * (no node, instance, or compare-model pose hit).
 *
 * Kept separate from VideoPlayer so every guard condition can be verified
 * cleanly in unit tests without mounting a full canvas.
 */

export interface EmptyCanvasDoubleClickContext {
  /** Alt+double-click zoom reset gesture (`isZoomBoxGesture`). */
  isZoomBoxGesture: boolean;
  /** Pan mode is active (`defaultToPan !== isSpaceHeld`). */
  shouldPan: boolean;
  /** Modifier keys held on the double-click event. */
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Active modal/drawing modes that must suppress empty-canvas instance creation. */
  skeletonBuildMode: boolean;
  bboxDrawMode: boolean;
  areaDeleteMode: boolean;
  imageFeatureRoiDrawActive: boolean;
  pickingAnchor: boolean;
  instanceSequencePick: boolean;
  /** Currently in node placement mode, or a placement click just fired. */
  isPlacingNodes: boolean;
  recentPlacementClick: boolean;
  /** Project/view preconditions for creating an instance. */
  hasProject: boolean;
  skeletonNodeCount: number;
  showInstances: boolean;
  isViewOnly: boolean;
}

export type EmptyCanvasDoubleClickAction =
  | "reset-zoom"
  | "reset-pan-zoom"
  | "add-instance"
  | "none";

/**
 * Decide what an empty-canvas double-click should do.
 *
 * Priority:
 * 1. Alt+double-click (`isZoomBoxGesture`) resets zoom in any mode.
 * 2. Pan mode resets zoom and pan.
 * 3. Plain unmodified double-click when editing is allowed adds a new instance
 *    centered at the clicked coordinates.
 */
export function resolveEmptyCanvasDoubleClick(
  ctx: EmptyCanvasDoubleClickContext,
): EmptyCanvasDoubleClickAction {
  if (ctx.isZoomBoxGesture) return "reset-zoom";
  if (ctx.shouldPan) return "reset-pan-zoom";

  if (
    ctx.altKey ||
    ctx.ctrlKey ||
    ctx.metaKey ||
    ctx.shiftKey ||
    ctx.skeletonBuildMode ||
    ctx.bboxDrawMode ||
    ctx.areaDeleteMode ||
    ctx.imageFeatureRoiDrawActive ||
    ctx.pickingAnchor ||
    ctx.instanceSequencePick ||
    ctx.isPlacingNodes ||
    ctx.recentPlacementClick ||
    !ctx.hasProject ||
    ctx.skeletonNodeCount <= 0 ||
    !ctx.showInstances ||
    ctx.isViewOnly
  ) {
    return "none";
  }

  return "add-instance";
}
