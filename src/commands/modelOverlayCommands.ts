/**
 * Accept a pose from Compare Model Predictions into the project.
 *
 * The picked model pose becomes a user instance on the current frame. If the
 * project has a predicted instance there that matches it (Hungarian on mean
 * node distance between that model's poses and the project's predictions on
 * this frame, within the same-animal gate), the user instance replaces it and
 * keeps its track — the same thing double-clicking a prediction does, only
 * with another model's pose. With no match it's added alongside. One undo step
 * (the default single-frame snapshot).
 *
 * The new instance's nodes start unconfirmed, as when converting a prediction;
 * nodes the model didn't place are filled in like a converted prediction's.
 */
import { Instance, LabeledFrame, PredictedInstance } from "@talmolab/sleap-io.js";
import type { Skeleton } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { toast } from "@/lib/notify";
import { fillMissingPredictedNodes } from "@/lib/instancePlacement";
import { matchPoses } from "@/lib/modelOverlay/matching";
import type { OverlayPose } from "@/lib/modelOverlay/core";

/** `inst`'s points as `[x0, y0, …]` in `nodeNames` order (NaN where missing or unknown). */
export function instanceXyByNames(inst: Instance, nodeNames: readonly string[]): Float64Array {
  const names = inst.skeleton.nodes.map((n) => n.name);
  const out = new Float64Array(nodeNames.length * 2);
  nodeNames.forEach((name, i) => {
    const j = names.indexOf(name);
    const p = j >= 0 ? inst.points[j] : undefined;
    const ok = p && p.visible !== false && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
    out[2 * i] = ok ? p.xy[0] : NaN;
    out[2 * i + 1] = ok ? p.xy[1] : NaN;
  });
  return out;
}

/**
 * Which of the frame's predicted instances (index into `lf.instances`) the
 * pose at `poseIdx` matches, or -1. All of the model's poses on the frame take
 * part, so two animals can't both claim the same prediction.
 */
export function matchProjectPrediction(
  lf: LabeledFrame,
  modelPoses: readonly OverlayPose[],
  poseIdx: number,
  nodeNames: readonly string[]
): number {
  const preds: number[] = [];
  lf.instances.forEach((inst, i) => {
    if (inst instanceof PredictedInstance) preds.push(i);
  });
  if (preds.length === 0) return -1;
  const targets = preds.map((i) => instanceXyByNames(lf.instances[i], nodeNames));
  const match = matchPoses(
    modelPoses.map((p) => p.xy),
    targets
  );
  const t = match[poseIdx] ?? -1;
  return t >= 0 ? preds[t] : -1;
}

/** Same node names, any order. */
function sameNodeNames(sk: Skeleton, names: readonly string[]): boolean {
  return sk.nodes.length === names.length && sk.nodes.every((n) => names.includes(n.name));
}

/**
 * Params:
 *   poses: OverlayPose[]  the model's poses on the current frame
 *   poseIdx: number       the one to accept
 *   modelName: string     for the confirmation toast
 */
export const AcceptModelPose: Command = {
  name: "AcceptModelPose",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, video, frameIdx, skeleton } = ctx.state;
    if (!labels || !video || !skeleton) return;
    const poses = params?.poses as OverlayPose[] | undefined;
    const poseIdx = params?.poseIdx;
    if (!poses || typeof poseIdx !== "number" || !poses[poseIdx]) return;
    const pose = poses[poseIdx];
    const nodeNames = skeleton.nodes.map((n) => n.name);
    if (pose.xy.length !== nodeNames.length * 2) return; // skeleton changed since loading

    const frames = labels.find({ video, frameIdx });
    let lf: LabeledFrame;
    if (frames.length > 0) {
      lf = frames[0];
    } else {
      lf = new LabeledFrame({ video, frameIdx });
      labels.append(lf);
    }

    const matchIdx = matchProjectPrediction(lf, poses, poseIdx, nodeNames);
    const matched = matchIdx >= 0 ? lf.instances[matchIdx] : null;
    // Keep the matched prediction's skeleton object (multi-skeleton projects)
    // when it has the same nodes; points are written in its node order.
    const target = matched && sameNodeNames(matched.skeleton, nodeNames) ? matched.skeleton : skeleton;
    const points = target.nodes.map((node) => {
      const i = nodeNames.indexOf(node.name);
      const x = pose.xy[2 * i];
      const y = pose.xy[2 * i + 1];
      const ok = Number.isFinite(x) && Number.isFinite(y);
      return {
        xy: [ok ? x : NaN, ok ? y : NaN] as [number, number],
        visible: ok,
        complete: false,
        name: node.name,
      };
    });
    const inst = new Instance({ skeleton: target, points, track: matched?.track ?? null });
    fillMissingPredictedNodes(inst);

    if (matched) lf.instances.splice(matchIdx, 1, inst);
    else lf.instances.push(inst);
    if (lf.isNegative) {
      lf.isNegative = false;
      ctx.state.bumpOverlayVersion();
    }

    ctx.state.setLabeledFrame(lf);
    ctx.state.setInstance(inst);
    ctx.state.markChanged();

    const name = typeof params?.modelName === "string" ? params.modelName : "model";
    toast.success(
      matched
        ? `Accepted ${name}'s pose, replacing the matching prediction${matched.track ? ` (${matched.track.name})` : ""}`
        : `Accepted ${name}'s pose as a new instance`
    );
  },
};
