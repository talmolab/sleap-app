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
import { toast } from "@/lib/notify";
import {
  placeInstance,
  findNearestPriorFrame,
  fillMissingPredictedNodes,
  centerInstanceAt,
} from "@/lib/instancePlacement";

/**
 * Create a new Instance on the current frame using the selected placement
 * method.
 *
 * Params:
 *   location?: [number, number] - scene/frame coordinates to center the new
 *     instance on (e.g. the right-click point that opened "Add Instance" in
 *     the context menu). When omitted (menu bar / hotkey invocation), the
 *     configured placement method's own default anchor is used unchanged.
 */
export const AddInstance: Command = {
  name: "AddInstance",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, video, frameIdx, skeleton } = ctx.state;
    if (!labels || !video || !skeleton) return;

    // A skeleton with no nodes would yield a null instance (zero points, zero
    // edges). PyQt SLEAP forbids this; refuse it here too and tell the user why.
    if (skeleton.nodes.length === 0) {
      toast.info("Add at least one node to the skeleton before adding an instance.");
      return;
    }

    // Get the placement method from app settings
    const method = useAppStore.getState().instanceInitMethod;

    // Get existing instances on the current frame
    const currentFrames = labels.find({ video, frameIdx });
    const existingInstances =
      currentFrames.length > 0 ? currentFrames[0].instances : [];

    const priorFrame = findNearestPriorFrame(labels, video, frameIdx);

    // Create instance using the selected placement method
    const instance = placeInstance(
      method,
      skeleton,
      video,
      existingInstances,
      priorFrame,
      useAppStore.getState().visibleSceneRect
    );

    const location = params?.location as [number, number] | undefined;
    if (location) {
      centerInstanceAt(instance, location);
    }

    // Find or create the LabeledFrame for this video + frame
    let lf: LabeledFrame;
    if (currentFrames.length > 0) {
      lf = currentFrames[0];
    } else {
      lf = new LabeledFrame({ video, frameIdx });
      labels.append(lf);
    }

    lf.instances.push(instance);

    // Select the new instance and update state
    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(instance);
    ctx.state.markChanged();

    // Only enter placement mode if instance has unplaced (NaN) points
    const hasNaNPoints = instance.points.some(
      (p) => isNaN(p.xy[0]) || isNaN(p.xy[1])
    );
    if (hasNaNPoints) {
      useAppStore.getState().enterPlacementMode();
    }
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

/**
 * Clone a predicted instance's points for conversion to a user Instance,
 * forcing `visible` to match sleap_io's canonical rule (`visible = !isNaN(x)`)
 * rather than trusting the model's `visible` flag as-is. A model can emit
 * `visible: true` for a keypoint it failed to place (`xy: [NaN, NaN]`); left
 * uncorrected, the renderer tries to draw a filled marker at NaN and nothing
 * appears at all, instead of the hollow "invisible node" marker it draws for
 * genuinely non-visible points.
 */
function clonePredictedPoints(points: Instance["points"]): Instance["points"] {
  return points.map((p) => ({
    xy: [p.xy[0], p.xy[1]] as [number, number],
    visible: !Number.isNaN(p.xy[0]),
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

    // Never materialize a node-less instance (see AddInstance).
    if (skeleton.nodes.length === 0) {
      toast.info("Add at least one node to the skeleton before pasting an instance.");
      return;
    }

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

    // Clone as a user Instance (no score property), keeping the fromPredicted
    // link so the user→prediction provenance round-trips to the SLP (Python
    // parity — sleap-io.js persists Instance.fromPredicted).
    const userInstance = new Instance({
      skeleton: predicted.skeleton,
      points: clonePredictedPoints(predicted.points),
      track: predicted.track,
      fromPredicted: predicted,
    });
    fillMissingPredictedNodes(userInstance);

    // Replace the predicted instance with the user instance
    lf.instances.splice(instanceIdx, 1, userInstance);

    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(userInstance);
    ctx.state.markChanged();
  },
};

/**
 * Accept ALL predicted instances on the current frame as user instances in one
 * action (PyQt "Add Instances from All Predictions on Current Frame").
 *
 * REPLACE-in-place — each predicted instance is swapped for a cloned user
 * Instance at the same position — to match this app's single-instance
 * double-click accept ({@link ConvertPredictionToInstance}) rather than PyQt's
 * append-alongside. Non-predicted instances are left untouched. Provenance
 * (fromPredicted) and track are preserved. Single-frame op → single-frame undo.
 */
export const AddInstancesFromAllPredictions: Command = {
  name: "AddInstancesFromAllPredictions",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  // Manage our own snapshot so a no-predictions invocation (e.g. via hotkey)
  // doesn't leave a spurious no-op entry on the undo stack.
  skipAutoSnapshot: true,
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const frames = labels.find({ video, frameIdx });
    if (frames.length === 0) return;

    const lf = frames[0];
    const predictedCount = lf.instances.filter(
      (inst) => inst instanceof PredictedInstance
    ).length;
    if (predictedCount === 0) {
      toast.info("No predictions on this frame to accept.");
      return;
    }

    // Snapshot BEFORE mutating (single frame) for undo.
    const snapshot = ctx.takeSnapshot("AddInstancesFromAllPredictions");
    ctx.pushUndoSnapshot(snapshot);

    // Swap each predicted instance in place for a user Instance, keeping the
    // fromPredicted link (Python-parity provenance) and track.
    let firstConverted: Instance | null = null;
    lf.instances = lf.instances.map((inst) => {
      if (!(inst instanceof PredictedInstance)) return inst;
      const userInstance = new Instance({
        skeleton: inst.skeleton,
        points: clonePredictedPoints(inst.points),
        track: inst.track,
        fromPredicted: inst,
      });
      fillMissingPredictedNodes(userInstance);
      if (!firstConverted) firstConverted = userInstance;
      return userInstance;
    });

    ctx.state.setLabeledFrame(lf);
    if (firstConverted) ctx.state.setInstance(firstConverted);
    ctx.state.markChanged();

    toast.success(
      `Accepted ${predictedCount} prediction${predictedCount > 1 ? "s" : ""} as ` +
        `user instance${predictedCount > 1 ? "s" : ""}`
    );
  },
};

/**
 * Accept ALL predicted instances across every labeled frame in the project
 * (all videos, not just the current one) as user instances, in one action
 * (PyQt "Accept All Predictions" — {@link AddInstancesFromAllPredictions}
 * above is this app's per-current-frame analogue of PyQt's
 * `AddUserInstancesFromPredictions`; this is the per-project analogue of
 * `AddUserInstancesFromAllPredictions` in ../sleap/sleap/gui/commands.py).
 *
 * REPLACE-in-place per frame, same as the current-frame version above, for
 * internal consistency — PyQt appends the new user instance alongside the
 * prediction instead of replacing it; see that command's docstring for why
 * this app doesn't.
 */
export const AddInstancesFromAllPredictionsInProject: Command = {
  name: "AddInstancesFromAllPredictionsInProject",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext) {
    const { labels } = ctx.state;
    if (!labels) return;

    const framesWithPredictions = labels.labeledFrames.filter((lf) =>
      lf.instances.some((inst) => inst instanceof PredictedInstance)
    );
    if (framesWithPredictions.length === 0) {
      toast.info("No predictions in this project to accept.");
      return;
    }

    const snapshot = ctx.takeAllFramesSnapshot("AddInstancesFromAllPredictionsInProject");

    let totalAccepted = 0;
    for (const lf of framesWithPredictions) {
      lf.instances = lf.instances.map((inst) => {
        if (!(inst instanceof PredictedInstance)) return inst;
        const userInstance = new Instance({
          skeleton: inst.skeleton,
          points: clonePredictedPoints(inst.points),
          track: inst.track,
          fromPredicted: inst,
        });
        fillMissingPredictedNodes(userInstance);
        totalAccepted++;
        return userInstance;
      });
    }

    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();

    toast.success(
      `Accepted ${totalAccepted} prediction${totalAccepted > 1 ? "s" : ""} across ` +
        `${framesWithPredictions.length} frame${framesWithPredictions.length > 1 ? "s" : ""}`
    );
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
  async execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;

    const predictions = params?.predictions as Labels;
    if (!predictions) return;

    const strategy =
      (params?.strategy as "auto" | "replace_predictions") ?? "auto";

    const snapshot = ctx.takeAllFramesSnapshot("MergePredictions");
    // Route through sleap-io.js's Labels.merge (issue #226). Match tracks by
    // NAME — io's default is object IDENTITY, which would duplicate every track
    // because the predictions are loaded from a separate file and never share
    // Track objects with the project. Match videos by BASENAME — the predictions
    // reference the same video under a possibly-different (compute-node) path.
    // Unlike the retired hand-rolled merge, io carries centroids/bboxes/masks/
    // rois + fromPredicted provenance, so the active-learning locator's
    // centroid-only output now survives the merge.
    const result = await labels.merge(predictions, {
      track: "name",
      video: "basename",
      frame: strategy,
    });
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();

    const conflicts = result.conflicts.length;
    toast.success(
      `Merged ${result.instancesAdded} prediction(s) across ${result.framesMerged} frame(s)` +
        (conflicts > 0 ? `, ${conflicts} conflict(s)` : "") +
        "."
    );
  },
};
