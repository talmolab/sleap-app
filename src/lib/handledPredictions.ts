/**
 * Predictions the user has already dealt with on a frame: one a user instance
 * was made from (`fromPredicted`), or one a user instance overlaps (the same
 * animal, matched on mean node distance as Compare Models' Accept matches).
 * Prediction review skips them, and a Claude correction for one is outdated:
 * accepting it would label that animal twice.
 *
 * Its own module so the proposal store and the connector's tools can both use
 * it without importing each other.
 */
import { matchPoses } from "@/lib/modelOverlay/matching";
import type { Instance, LabeledFrame, PredictedInstance } from "@/types";

/** `[x0, y0, …]` of an instance's placed, visible nodes (NaN elsewhere). */
export function poseXy(inst: Instance): Float64Array {
  const out = new Float64Array(inst.points.length * 2);
  inst.points.forEach((p, i) => {
    const ok = p.visible !== false && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
    out[2 * i] = ok ? p.xy[0] : NaN;
    out[2 * i + 1] = ok ? p.xy[1] : NaN;
  });
  return out;
}

/** The frame's predictions a user instance was made from or overlaps. */
export function handledPredictions(lf: LabeledFrame): Set<PredictedInstance> {
  const preds = lf.predictedInstances;
  const users = lf.userInstances;
  const out = new Set<PredictedInstance>();
  if (preds.length === 0 || users.length === 0) return out;
  for (const u of users) if (u.fromPredicted) out.add(u.fromPredicted as PredictedInstance);
  const match = matchPoses(users.map(poseXy), preds.map(poseXy));
  match.forEach((t) => {
    if (t >= 0) out.add(preds[t]);
  });
  return out;
}
