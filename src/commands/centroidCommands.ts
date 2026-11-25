/**
 * Centroid commands (`LabeledFrame.centroids`), for the predicted centroids a
 * Centroid Only run on a multi-node skeleton writes. Each is one undo step
 * over every frame, so the autosave writes the whole project for them.
 */
import { PredictedCentroid, UserCentroid, type Centroid, type LabeledFrame } from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
import { frameHasContent } from "@/lib/frameLabeling";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";

/** Score of a predicted centroid, -Infinity for anything else. */
const scoreOf = (c: Centroid) =>
  c instanceof PredictedCentroid && Number.isFinite(c.score) ? c.score : -Infinity;

/** A user centroid with everything a predicted one carries except its score. */
export function toUserCentroid(c: Centroid): UserCentroid {
  const user = new UserCentroid({
    x: c.x,
    y: c.y,
    z: c.z,
    track: c.track,
    trackingScore: c.trackingScore,
    instance: c.instance,
    category: c.category,
    name: c.name,
    source: c.source,
  });
  user.identity = c.identity ?? null;
  user.identityScore = c.identityScore ?? null;
  user.categoryScore = c.categoryScore ?? null;
  return user;
}

/** Show the current frame as it is now (or nothing, if it was removed). */
function refresh(ctx: CommandContext): void {
  const { labels, video, frameIdx } = ctx.state;
  const cur = labels && video ? labels.find({ video, frameIdx })[0] ?? null : null;
  ctx.state.setLabeledFrame(cur && frameHasContent(cur) ? cur : null);
  ctx.state.bumpOverlayVersion();
  ctx.state.markChanged();
}

function acceptOnFrame(lf: LabeledFrame, minScore: number): number {
  let n = 0;
  lf.centroids = lf.centroids.map((c) => {
    if (!(c instanceof PredictedCentroid) || scoreOf(c) < minScore) return c;
    n++;
    return toUserCentroid(c);
  });
  return n;
}

/** Turn predicted centroids scoring ≥ `minScore` (default 0) into user centroids, project-wide. */
export const AcceptAllCentroids: Command = {
  name: "AcceptAllCentroids",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;
    const raw = Number(params?.minScore ?? 0);
    const minScore = Number.isFinite(raw) ? raw : 0;
    const snapshot = ctx.takeAllFramesSnapshot("AcceptAllCentroids");
    let n = 0;
    for (const lf of labels.labeledFrames) n += acceptOnFrame(lf, minScore);
    if (n === 0) {
      toast.info("No predicted centroids to accept.");
      return;
    }
    ctx.pushUndoSnapshot(snapshot);
    refresh(ctx);
    toast.success(`Accepted ${n} predicted centroid${n === 1 ? "" : "s"}`);
  },
};

/**
 * Delete predicted centroids scoring below `maxScore` (default: every
 * predicted centroid), project-wide. Frames left empty are removed.
 */
export const DeletePredictedCentroids: Command = {
  name: "DeletePredictedCentroids",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;
    const raw = params?.maxScore;
    const maxScore = raw === undefined || raw === null ? Infinity : Number(raw);
    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictedCentroids");
    let n = 0;
    for (const lf of labels.labeledFrames) {
      const before = lf.centroids.length;
      lf.centroids = lf.centroids.filter((c) => !(c instanceof PredictedCentroid) || !(scoreOf(c) < maxScore));
      n += before - lf.centroids.length;
    }
    if (n === 0) {
      toast.info("No predicted centroids to delete.");
      return;
    }
    labels.labeledFrames = labels.labeledFrames.filter(frameHasContent);
    labels.reindex();
    ctx.pushUndoSnapshot(snapshot);
    refresh(ctx);
    toast.success(`Deleted ${n} predicted centroid${n === 1 ? "" : "s"}`);
  },
};
