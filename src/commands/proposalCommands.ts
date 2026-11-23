/**
 * Accept Claude's correction of a prediction (prediction review, Claude
 * connector): the predicted instance becomes a user instance with Claude's
 * node changes, in one undo step — what double-clicking the prediction and
 * dragging those nodes would do.
 *
 * Like {@link ConvertPredictionToInstance}, the user instance replaces the
 * prediction in place and keeps its track and a `fromPredicted` link to it.
 * Nodes Claude moved are placed, visible and marked complete (the user
 * approved them); nodes Claude hid are marked not visible; every other node
 * starts as a converted prediction's would. No edits = accept the prediction
 * as is.
 */
import { Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { clonePredictedPoints } from "./editCommands";
import { fillMissingPredictedNodes } from "@/lib/instancePlacement";

/**
 * Params:
 *   instance: PredictedInstance                       the prediction (on the frame on screen)
 *   nodes: Record<node index, [x, y] | null>         Claude's changes; null = not visible
 */
export const AcceptCorrectedPrediction: Command = {
  name: "AcceptCorrectedPrediction",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const predicted = params?.instance;
    const nodes = params?.nodes as Record<string, [number, number] | null> | undefined;
    const lf = ctx.state.labeledFrame;
    if (!(predicted instanceof PredictedInstance) || !nodes || !lf) return;
    // A prediction off the frame on screen wouldn't be in the undo snapshot.
    const idx = lf.instances.indexOf(predicted);
    if (idx < 0) return;

    const user = new Instance({
      skeleton: predicted.skeleton,
      points: clonePredictedPoints(predicted.points),
      track: predicted.track,
      fromPredicted: predicted,
    });
    for (const [k, v] of Object.entries(nodes)) {
      const p = user.points[Number(k)];
      if (!p) continue;
      if (v === null) {
        p.visible = false;
        continue;
      }
      p.xy = [v[0], v[1]];
      p.visible = true;
      p.complete = true;
    }
    // Nodes the model didn't place (and Claude didn't either) get a spot to drag from.
    fillMissingPredictedNodes(user);

    lf.instances.splice(idx, 1, user);
    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(user);
    ctx.state.markChanged();
    ctx.state.bumpOverlayVersion();
  },
};
