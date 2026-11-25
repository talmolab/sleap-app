/**
 * Segmentation-mask edit commands (#155). Each is one undo step: they act on
 * the current frame, so the default single-frame snapshot (which keeps
 * `LabeledFrame.masks`) covers them, and they're frame-level edits for the
 * incremental autosave (whose journal records masks).
 *
 * Masks are addressed by index into the current frame's `masks` (indices
 * survive undo, which restores clones rather than the original objects).
 * Polygons are in source (full-frame) coordinates.
 *
 * An edit always assigns the mask a NEW `rleCounts` array: undo snapshots
 * share the old one, and sleap-io's decoded-raster cache is keyed on it.
 */
import {
  LabeledFrame,
  PredictedSegmentationMask,
  UserSegmentationMask,
  encodeRle,
  type Instance,
  type SegmentationMask,
  type Track,
} from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { frameHasContent } from "@/lib/frameLabeling";
import {
  MIN_POLYGON_POINTS,
  combineRasters,
  isEmptyRaster,
  polygonRaster,
  type MaskGrid,
  type Pt,
} from "@/lib/maskPolygon";

const TOPICS = [UpdateTopic.Frame, UpdateTopic.Instance];

/** The current frame, created on demand when `create` is set. */
function currentFrame(ctx: CommandContext, create = false): LabeledFrame | null {
  const { labels, video, frameIdx } = ctx.state;
  if (!labels || !video) return null;
  const found = labels.find({ video, frameIdx })[0];
  if (found || !create) return found ?? null;
  const lf = new LabeledFrame({ video, frameIdx });
  labels.append(lf);
  return lf;
}

/** Refresh the canvas and mark the project edited. */
function touched(ctx: CommandContext, lf: LabeledFrame | null): void {
  ctx.state.setLabeledFrame(lf && frameHasContent(lf) ? lf : null);
  ctx.state.bumpOverlayVersion();
  ctx.state.markChanged();
}

/** Validated polygon vertices from `params.points`, or null. */
function polygonParam(params?: Record<string, unknown>): Pt[] | null {
  const raw = params?.points;
  if (!Array.isArray(raw) || raw.length < MIN_POLYGON_POINTS) return null;
  const pts = raw as unknown[];
  const ok = pts.every(
    (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  return ok ? (pts as Pt[]).map(([x, y]) => [x, y] as Pt) : null;
}

function gridOf(mask: SegmentationMask): MaskGrid {
  return { height: mask.height, width: mask.width, scale: mask.scale, offset: mask.offset };
}

/**
 * Add a user mask filled from a polygon. As in labelroi, each polygon is its
 * own mask, and nothing is left selected, so the next polygon is a new mask too.
 *
 * Params: `points` (source coordinates, at least 3), `height` / `width` (the
 * new mask's grid: the displayed frame), optional `offset` (source position
 * of the grid's top-left, e.g. a crop's origin; default `[0, 0]`), `instance`
 * (linked pose instance; its track is used unless `track` is given), `track`,
 * `category`. A polygon that covers no pixel adds nothing.
 */
export const AddMaskPolygon: Command = {
  name: "AddMaskPolygon",
  topics: TOPICS,
  execute(ctx, params) {
    const points = polygonParam(params);
    const height = Number(params?.height);
    const width = Number(params?.width);
    if (!points || !(height > 0) || !(width > 0)) return;
    const off = params?.offset as [number, number] | undefined;
    const grid: MaskGrid = {
      height: Math.round(height),
      width: Math.round(width),
      scale: [1, 1],
      offset: off && Number.isFinite(off[0]) && Number.isFinite(off[1]) ? [off[0], off[1]] : [0, 0],
    };
    const raster = polygonRaster(points, grid);
    if (isEmptyRaster(raster)) return;
    const lf = currentFrame(ctx, true);
    if (!lf) return;
    const instance = (params?.instance as Instance | null | undefined) ?? null;
    const track = (params?.track as Track | null | undefined) ?? instance?.track ?? null;
    const mask = UserSegmentationMask.fromArray(raster, grid.height, grid.width, {
      offset: grid.offset,
      instance,
      track,
      category: typeof params?.category === "string" ? params.category : "",
      source: "polygon",
    });
    lf.masks.push(mask);
    ctx.state.set("selectedMaskIdx", null);
    touched(ctx, lf);
  },
};

/**
 * Add a polygon to, or cut it from, a mask. Params: `index`, `points` (source
 * coordinates), `op` ("add" | "cut").
 *
 * The polygon is filled into the mask's own grid, so any part outside that
 * grid is ignored. Editing a predicted mask replaces it with a user mask (as
 * editing a predicted pose does); no `fromPredicted` link is kept, since the
 * prediction leaves the frame. Cutting a mask down to nothing deletes it.
 */
export const EditMaskPolygon: Command = {
  name: "EditMaskPolygon",
  topics: TOPICS,
  execute(ctx, params) {
    const lf = currentFrame(ctx);
    const index = Number(params?.index);
    const mask = lf && Number.isInteger(index) ? lf.masks[index] : undefined;
    const points = polygonParam(params);
    const op = params?.op === "cut" ? "cut" : params?.op === "add" ? "add" : null;
    if (!lf || !mask || !points || !op) return;

    const shape = polygonRaster(points, gridOf(mask));
    if (isEmptyRaster(shape)) {
      if (op === "add") toast.info("That polygon is outside the selected mask's area.");
      return;
    }
    const next = combineRasters(mask.data, shape, op);
    if (isEmptyRaster(next)) {
      lf.masks.splice(index, 1);
      ctx.state.set("selectedMaskIdx", null);
      touched(ctx, lf);
      return;
    }
    const target: SegmentationMask =
      mask instanceof PredictedSegmentationMask ? mask.toUser(false) : mask;
    target.rleCounts = encodeRle(next, mask.height, mask.width);
    lf.masks[index] = target;
    ctx.state.set("selectedMaskIdx", index);
    touched(ctx, lf);
  },
};

/**
 * Delete a mask. Params: `index`.
 *
 * The frame is kept even when this was the last thing on it, as DeleteBbox
 * does, so the deletion is journaled by the incremental autosave.
 */
export const DeleteMask: Command = {
  name: "DeleteMask",
  topics: TOPICS,
  execute(ctx, params) {
    const lf = currentFrame(ctx);
    const index = Number(params?.index);
    if (!lf || !Number.isInteger(index) || !lf.masks[index]) return;
    lf.masks.splice(index, 1);
    ctx.state.set("selectedMaskIdx", null);
    touched(ctx, lf);
  },
};
