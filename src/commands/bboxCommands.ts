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
  PredictedBoundingBox,
  UserBoundingBox,
  type BoundingBox,
  type Instance,
  type Track,
} from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { frameHasContent } from "@/lib/frameLabeling";
import { derivePoseBboxes, normalizeBboxPadding } from "@/lib/poseBboxes";

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

/**
 * Delete a box. Params: `index`.
 *
 * The frame is kept even when this was the last thing on it, as Delete
 * Instance does. This is a frame-level edit for the incremental autosave, which
 * journals frames that still exist: removing the frame meant the deletion was
 * never journaled, and the box came back after crash recovery. An empty frame
 * counts as unlabeled (`frameHasContent`).
 */
export const DeleteBbox: Command = {
  name: "DeleteBbox",
  topics: TOPICS,
  execute(ctx, params) {
    const t = targetBox(ctx, params);
    if (!t) return;
    t.lf.bboxes.splice(t.index, 1);
    ctx.state.set("selectedBboxIdx", null);
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

/** A user box with everything a predicted box carries except its score. */
export function toUserBbox(box: BoundingBox): UserBoundingBox {
  const user = new UserBoundingBox({
    x1: box.x1,
    y1: box.y1,
    x2: box.x2,
    y2: box.y2,
    angle: box.angle,
    track: box.track,
    trackingScore: box.trackingScore,
    instance: box.instance,
    category: box.category,
    name: box.name,
    source: box.source,
  });
  user.identity = box.identity ?? null;
  user.identityScore = box.identityScore ?? null;
  user.categoryScore = box.categoryScore ?? null;
  return user;
}

/** Score of a predicted box, -Infinity for anything else. */
const scoreOf = (b: BoundingBox) =>
  b instanceof PredictedBoundingBox && Number.isFinite(b.score) ? b.score : -Infinity;

/**
 * Accept predicted boxes on one frame: turn them into user boxes in place.
 * Returns how many changed.
 */
function acceptOnFrame(lf: LabeledFrame, minScore: number, onlyIndex?: number): number {
  let n = 0;
  lf.bboxes = lf.bboxes.map((b, i) => {
    if (!(b instanceof PredictedBoundingBox)) return b;
    if (onlyIndex !== undefined ? i !== onlyIndex : scoreOf(b) < minScore) return b;
    n++;
    return toUserBbox(b);
  });
  return n;
}

/** Accept one predicted box (it becomes a user box). Params: `index`. */
export const AcceptBbox: Command = {
  name: "AcceptBbox",
  topics: TOPICS,
  execute(ctx, params) {
    const t = targetBox(ctx, params);
    if (!t || !(t.box instanceof PredictedBoundingBox)) return;
    acceptOnFrame(t.lf, -Infinity, t.index);
    touched(ctx, t.lf);
  },
};

/** Accept every predicted box on the current frame scoring ≥ `minScore` (default 0). */
export const AcceptFrameBboxes: Command = {
  name: "AcceptFrameBboxes",
  topics: TOPICS,
  execute(ctx, params) {
    const lf = currentFrame(ctx);
    if (!lf) return;
    const minScore = Number(params?.minScore ?? 0);
    const n = acceptOnFrame(lf, Number.isFinite(minScore) ? minScore : 0);
    if (n > 0) touched(ctx, lf);
  },
};

/**
 * Accept predicted boxes scoring ≥ `minScore` across the whole project (or one
 * `video` when given). One undo step.
 */
export const AcceptAllBboxes: Command = {
  name: "AcceptAllBboxes",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;
    const minScore = Number(params?.minScore ?? 0);
    const snapshot = ctx.takeAllFramesSnapshot("AcceptAllBboxes");
    let n = 0;
    for (const lf of labels.labeledFrames) {
      n += acceptOnFrame(lf, Number.isFinite(minScore) ? minScore : 0);
    }
    if (n === 0) {
      toast.info("No predicted boxes to accept.");
      return;
    }
    ctx.pushUndoSnapshot(snapshot);
    touched(ctx, ctx.state.labeledFrame);
    toast.success(`Accepted ${n} predicted box${n === 1 ? "" : "es"}`);
  },
};

/**
 * Delete predicted boxes scoring below `maxScore` (default: all predicted
 * boxes) across the project. Frames left empty are removed. One undo step.
 */
export const DeletePredictedBboxes: Command = {
  name: "DeletePredictedBboxes",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;
    const raw = params?.maxScore;
    const maxScore = raw === undefined || raw === null ? Infinity : Number(raw);
    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictedBboxes");
    let n = 0;
    for (const lf of labels.labeledFrames) {
      const before = lf.bboxes.length;
      lf.bboxes = lf.bboxes.filter(
        (b) => !(b instanceof PredictedBoundingBox) || !(scoreOf(b) < maxScore),
      );
      n += before - lf.bboxes.length;
    }
    if (n === 0) {
      toast.info("No predicted boxes to delete.");
      return;
    }
    labels.labeledFrames = labels.labeledFrames.filter(frameHasContent);
    labels.reindex();
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.set("selectedBboxIdx", null);
    const { video, frameIdx } = ctx.state;
    const cur = video ? labels.find({ video, frameIdx })[0] ?? null : null;
    touched(ctx, cur);
    toast.success(`Deleted ${n} predicted box${n === 1 ? "" : "es"}`);
  },
};

/**
 * Boxes "Boxes from Poses" would add to a frame (not yet added): see
 * `derivePoseBboxes` for the rules, which match sleap-nn's.
 */
export function posesToBboxes(lf: LabeledFrame, padding: number, includePredicted = false): BoundingBox[] {
  return derivePoseBboxes(lf, { padding, includePredicted }).map((d) => d.box);
}

/**
 * Add a padded box around every pose instance that doesn't already have a
 * linked box, on the current frame (`scope: "frame"`, default) or every frame
 * (`scope: "project"`). These are the same boxes sleap-nn derives at train
 * time with `bbox_source: instances`, but saved and editable. One undo step.
 * Params: `padding` (px, default 0, at least 0), `scope`, `includePredicted`
 * (also box predicted instances, as predicted boxes; default false).
 */
export const BboxesFromPoses: Command = {
  name: "BboxesFromPoses",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;
    const pad = normalizeBboxPadding(params?.padding ?? 0);
    const includePredicted = params?.includePredicted === true;
    const project = params?.scope === "project";
    const frames = project ? labels.labeledFrames : [currentFrame(ctx)].filter((f): f is LabeledFrame => !!f);
    const snapshot = project
      ? ctx.takeAllFramesSnapshot("BboxesFromPoses")
      : ctx.takeSnapshot("BboxesFromPoses");
    let n = 0;
    for (const lf of frames) {
      const add = posesToBboxes(lf, pad, includePredicted);
      lf.bboxes.push(...add);
      n += add.length;
    }
    if (n === 0) {
      toast.info(
        includePredicted ? "Every instance already has a box." : "Every user instance already has a box.",
      );
      return;
    }
    ctx.pushUndoSnapshot(snapshot);
    touched(ctx, ctx.state.labeledFrame ?? currentFrame(ctx));
    toast.success(`Added ${n} box${n === 1 ? "" : "es"} from poses`);
  },
};

/** Command names that only edit the current frame (for the incremental autosave). */
export const BBOX_FRAME_COMMANDS = [
  AddBbox.name,
  SetBboxGeometry.name,
  DeleteBbox.name,
  SetBboxProps.name,
  AcceptBbox.name,
  AcceptFrameBboxes.name,
];
