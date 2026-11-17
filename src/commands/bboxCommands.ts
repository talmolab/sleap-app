/**
 * Bounding-box edit commands (#488). Each is one undo step: they act on the
 * current frame, so the default single-frame snapshot (which keeps
 * `LabeledFrame.bboxes`) covers them, and they're frame-level edits for the
 * incremental autosave.
 *
 * Boxes are addressed by index into the current frame's `bboxes` (indices
 * survive undo, which restores clones rather than the original objects).
 * Coordinates are source (full-frame) pixels.
 */
import {
  LabeledFrame,
  UserBoundingBox,
  type BoundingBox,
  type Instance,
  type Track,
} from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { frameHasContent } from "@/lib/frameLabeling";

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

/** The box at `params.index` on the current frame. */
function targetBox(ctx: CommandContext, params?: Record<string, unknown>) {
  const lf = currentFrame(ctx);
  const index = Number(params?.index);
  const box = lf && Number.isInteger(index) ? lf.bboxes[index] : undefined;
  return lf && box ? { lf, box, index } : null;
}

function finite(...v: unknown[]): boolean {
  return v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** Refresh the canvas and mark the project edited. */
function touched(ctx: CommandContext, lf: LabeledFrame | null): void {
  ctx.state.setLabeledFrame(lf && frameHasContent(lf) ? lf : null);
  ctx.state.bumpOverlayVersion();
  ctx.state.markChanged();
}

/**
 * Add a user box to the current frame and select it.
 *
 * Params: `x1, y1, x2, y2` (any order), optional `instance` (linked pose
 * instance; its track is used unless `track` is given), `track`, `category`.
 */
export const AddBbox: Command = {
  name: "AddBbox",
  topics: TOPICS,
  execute(ctx, params) {
    const { x1, y1, x2, y2 } = (params ?? {}) as Record<string, number>;
    if (!finite(x1, y1, x2, y2)) return;
    const lf = currentFrame(ctx, true);
    if (!lf) return;
    const instance = (params?.instance as Instance | null | undefined) ?? null;
    const track = (params?.track as Track | null | undefined) ?? instance?.track ?? null;
    const box = new UserBoundingBox({
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
      instance,
      track,
      category: typeof params?.category === "string" ? params.category : "",
    });
    lf.bboxes.push(box);
    ctx.state.set("selectedBboxIdx", lf.bboxes.length - 1);
    touched(ctx, lf);
  },
};

/**
 * Move or resize a box. Params: `index`, `x1, y1, x2, y2` (the pre-rotation
 * extent; a rotated box keeps its angle).
 */
export const SetBboxGeometry: Command = {
  name: "SetBboxGeometry",
  topics: TOPICS,
  execute(ctx, params) {
    const t = targetBox(ctx, params);
    const { x1, y1, x2, y2 } = (params ?? {}) as Record<string, number>;
    if (!t || !finite(x1, y1, x2, y2)) return;
    t.box.x1 = Math.min(x1, x2);
    t.box.y1 = Math.min(y1, y2);
    t.box.x2 = Math.max(x1, x2);
    t.box.y2 = Math.max(y1, y2);
    touched(ctx, t.lf);
  },
};

/** Delete a box. Params: `index`. Removes the frame if nothing else is on it. */
export const DeleteBbox: Command = {
  name: "DeleteBbox",
  topics: TOPICS,
  execute(ctx, params) {
    const t = targetBox(ctx, params);
    if (!t) return;
    t.lf.bboxes.splice(t.index, 1);
    ctx.state.set("selectedBboxIdx", null);
    const { labels } = ctx.state;
    if (labels && !frameHasContent(t.lf)) {
      labels.labeledFrames = labels.labeledFrames.filter((f) => f !== t.lf);
      labels.reindex();
    }
    touched(ctx, t.lf);
  },
};

/**
 * Set a box's category, track or linked instance. Params: `index`, and any of
 * `category` (string), `track` (Track | null), `instance` (Instance | null).
 * Linking an instance also takes its track unless `track` is given.
 */
export const SetBboxProps: Command = {
  name: "SetBboxProps",
  topics: TOPICS,
  execute(ctx, params) {
    const t = targetBox(ctx, params);
    if (!t || !params) return;
    const box: BoundingBox = t.box;
    if (typeof params.category === "string") box.category = params.category.trim();
    if ("instance" in params) {
      box.instance = (params.instance as Instance | null) ?? null;
      if (box.instance && !("track" in params)) box.track = box.instance.track ?? null;
    }
    if ("track" in params) box.track = (params.track as Track | null) ?? null;
    touched(ctx, t.lf);
  },
};

/** Command names that only edit the current frame (for the incremental autosave). */
export const BBOX_FRAME_COMMANDS = [
  AddBbox.name,
  SetBboxGeometry.name,
  DeleteBbox.name,
  SetBboxProps.name,
];
