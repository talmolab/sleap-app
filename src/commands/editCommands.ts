/**
 * Edit commands: instance creation, deletion, copy/paste, point manipulation,
 * and prediction-to-instance conversion.
 *
 * Ports SLEAP's AddInstance, DeleteSelectedInstance, CopyInstance, PasteInstance,
 * SetInstancePointLocations, DeleteFramePredictions, ConvertPredictionToInstance.
 */

import { Instance, LabeledFrame, PredictedInstance } from "@talmolab/sleap-io.js";
import type { Labels } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { useAppStore } from "../stores/appStore";
import { merge } from "@/lib/merge";
import { toast } from "@/lib/notify";

/** Create a new Instance on the current frame using Instance.empty(). */
export const AddInstance: Command = {
  name: "AddInstance",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx, skeleton } = ctx.state;
    if (!labels || !video || !skeleton) return;

    // Create an empty instance with NaN points
    const instance = Instance.empty({ skeleton });

    // Find or create the LabeledFrame for this video + frame
    const frames = labels.find({ video, frameIdx });
    let lf: LabeledFrame;
    if (frames.length > 0) {
      lf = frames[0];
    } else {
      lf = new LabeledFrame({ video, frameIdx });
      labels.append(lf);
    }

    lf.instances.push(instance);

    // Select the new instance and update state
    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(instance);
    ctx.state.markChanged();

    // Auto-enter placement mode for the new empty instance
    useAppStore.getState().enterPlacementMode();
  },
};

/** Remove the currently selected instance from its frame. */
export const DeleteSelectedInstance: Command = {
  name: "DeleteSelectedInstance",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx, instance } = ctx.state;
    if (!labels || !video || !instance) return;

    const frames = labels.find({ video, frameIdx });
    if (frames.length === 0) return;

    const lf = frames[0];
    const idx = lf.instances.indexOf(instance);
    if (idx === -1) return;

    lf.instances.splice(idx, 1);

    // Clear selection
    ctx.state.setInstance(null);
    ctx.state.setLabeledFrame(lf.instances.length > 0 ? lf : null);
    ctx.state.markChanged();
  },
};

/**
 * Update a point's x,y coordinates on the selected instance.
 *
 * Params:
 *   nodeIdx: number - index of the node/point to update
 *   x: number - new x coordinate
 *   y: number - new y coordinate
 */
export const SetPointLocation: Command = {
  name: "SetPointLocation",
  topics: [], // No redraw topics - canvas handles this directly for drag perf
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { instance } = ctx.state;
    if (!instance) return;

    const nodeIdx = params?.nodeIdx;
    const x = params?.x;
    const y = params?.y;

    if (typeof nodeIdx !== "number" || typeof x !== "number" || typeof y !== "number") {
      return;
    }

    if (nodeIdx < 0 || nodeIdx >= instance.points.length) return;

    instance.points[nodeIdx].xy = [x, y];
    instance.points[nodeIdx].visible = true;
    instance.points[nodeIdx].complete = true;

    ctx.state.markChanged();
  },
};

/** Deep-copy a point array. */
function clonePoints(points: Instance["points"]): Instance["points"] {
  return points.map((p) => ({
    xy: [p.xy[0], p.xy[1]] as [number, number],
    visible: p.visible,
    complete: p.complete,
    name: p.name,
    score: p.score,
  }));
}

/** Copy the selected instance's point data to the clipboard. */
export const CopyInstance: Command = {
  name: "CopyInstance",
  topics: [],
  execute(ctx: CommandContext) {
    const { instance } = ctx.state;
    if (!instance) return;

    const clone = new Instance({
      skeleton: instance.skeleton,
      points: clonePoints(instance.points),
      track: instance.track,
    });
    ctx.setState({ clipboardInstance: clone });
  },
};

/** Paste the clipboard instance onto the current frame. */
export const PasteInstance: Command = {
  name: "PasteInstance",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx, clipboardInstance, skeleton } = ctx.state;
    if (!labels || !video || !clipboardInstance || !skeleton) return;

    const newInstance = new Instance({
      skeleton,
      points: clonePoints(clipboardInstance.points),
      track: clipboardInstance.track,
    });

    // Find or create the LabeledFrame
    const frames = labels.find({ video, frameIdx });
    let lf: LabeledFrame;
    if (frames.length > 0) {
      lf = frames[0];
    } else {
      lf = new LabeledFrame({ video, frameIdx });
      labels.append(lf);
    }

    lf.instances.push(newInstance);
    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(newInstance);
    ctx.state.markChanged();
  },
};

/** Delete all predicted instances on the current frame. */
export const DeleteFramePredictions: Command = {
  name: "DeleteFramePredictions",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx, instance } = ctx.state;
    if (!labels || !video) return;

    const frames = labels.find({ video, frameIdx });
    if (frames.length === 0) return;

    const lf = frames[0];
    const userInstances = lf.instances.filter((inst) => !(inst instanceof PredictedInstance));
    lf.instances = userInstances;

    // If selected instance was predicted, deselect
    if (instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.setLabeledFrame(userInstances.length > 0 ? lf : null);
    ctx.state.markChanged();
  },
};

/**
 * Convert a predicted instance to a user instance.
 *
 * Params:
 *   instanceIdx: number - index of the predicted instance in the labeled frame
 *
 * Clones the predicted instance's points into a new user Instance,
 * replaces the predicted one in the frame, and selects the new instance.
 */
export const ConvertPredictionToInstance: Command = {
  name: "ConvertPredictionToInstance",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const instanceIdx = params?.instanceIdx;
    if (typeof instanceIdx !== "number") return;

    const frames = labels.find({ video, frameIdx });
    if (frames.length === 0) return;

    const lf = frames[0];
    const predicted = lf.instances[instanceIdx];
    if (!predicted || !(predicted instanceof PredictedInstance)) return;

    // Clone as a user Instance (no score property)
    const userInstance = new Instance({
      skeleton: predicted.skeleton,
      points: clonePoints(predicted.points),
      track: predicted.track,
    });

    // Replace the predicted instance with the user instance
    lf.instances.splice(instanceIdx, 1, userInstance);

    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(userInstance);
    ctx.state.markChanged();
  },
};

/**
 * No-op mutating command to create an undo snapshot before a continuous edit
 * operation (drag, placement). Since it has topics, CommandContext.execute()
 * will auto-snapshot the current frame state before calling execute().
 * The actual mutations happen directly on the data model during the drag.
 */
export const BeginEdit: Command = {
  name: "BeginEdit",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute() {
    // Intentionally empty - the snapshot is the point
  },
};

/**
 * Move an entire instance by a delta.
 *
 * Params:
 *   dx: number - x offset
 *   dy: number - y offset
 */
export const MoveInstance: Command = {
  name: "MoveInstance",
  topics: [], // No redraw topics - caller handles re-render
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { instance } = ctx.state;
    if (!instance) return;

    const dx = params?.dx;
    const dy = params?.dy;
    if (typeof dx !== "number" || typeof dy !== "number") return;

    for (const point of instance.points) {
      if (!isNaN(point.xy[0]) && !isNaN(point.xy[1])) {
        point.xy = [point.xy[0] + dx, point.xy[1] + dy];
      }
    }

    ctx.state.markChanged();
  },
};

/**
 * Rotate all points in the selected instance around its centroid.
 *
 * Params:
 *   angle: number - rotation angle in radians
 */
export const RotateInstance: Command = {
  name: "RotateInstance",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { instance } = ctx.state;
    if (!instance || instance instanceof PredictedInstance) return;

    const angle = params?.angle;
    if (typeof angle !== "number") return;

    // Compute centroid of visible points
    const visible = instance.points.filter(
      (p) => !isNaN(p.xy[0]) && !isNaN(p.xy[1])
    );
    if (visible.length === 0) return;

    const cx = visible.reduce((s, p) => s + p.xy[0], 0) / visible.length;
    const cy = visible.reduce((s, p) => s + p.xy[1], 0) / visible.length;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (const point of instance.points) {
      if (isNaN(point.xy[0]) || isNaN(point.xy[1])) continue;
      const dx = point.xy[0] - cx;
      const dy = point.xy[1] - cy;
      point.xy = [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    }

    ctx.state.markChanged();
  },
};

/** Delete all predicted instances across all frames. */
export const DeleteAllPredictions: Command = {
  name: "DeleteAllPredictions",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext) {
    const { labels, instance } = ctx.state;
    if (!labels) return;

    // Take a multi-frame snapshot BEFORE deletion for proper undo
    const snapshot = ctx.takeAllFramesSnapshot("DeleteAllPredictions");

    let removed = 0;
    for (const lf of labels.labeledFrames) {
      const before = lf.instances.length;
      lf.instances = lf.instances.filter((inst) => !(inst instanceof PredictedInstance));
      removed += before - lf.instances.length;
    }

    // Remove empty labeled frames
    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) return;

    // Push the multi-frame snapshot for undo
    ctx.pushUndoSnapshot(snapshot);

    // If selected instance was predicted, deselect
    if (instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
  },
};

/**
 * Merge predictions from inference output into current labels.
 * Supports "auto" (default) and "replace_predictions" strategies.
 */
export const MergePredictions: Command = {
  name: "MergePredictions",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;

    const predictions = params?.predictions as Labels;
    if (!predictions) return;

    const strategy =
      (params?.strategy as "auto" | "replace_predictions") ?? "auto";

    const snapshot = ctx.takeAllFramesSnapshot("MergePredictions");
    const result = merge(labels, predictions, { frameStrategy: strategy });
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();

    toast.success(
      `Merged ${result.instancesAdded} prediction(s). ${result.framesAdded} new frame(s), ${result.conflicts} conflict(s).`
    );
  },
};
