/**
 * Which Inference panel settings a Connect worker leaves out.
 *
 * The worker (talmolab/sleap-connect, `jobs/spec.py` + `jobs/builder.py` on
 * `main`) builds a `sleap-nn track` command from a fixed set of job fields and
 * drops any other field the app sends. It applies: the models, batch size,
 * peak threshold, the frame targets, skip user-labeled frames, the classic and
 * optical-flow trackers with their similarity / matching / window / robust /
 * max tracks / connect single breaks, and the color conversion. Everything
 * else in the panel runs with sleap-nn's default on a worker.
 *
 * The app still sends every setting (named like sleap-nn's own CLI flags), so
 * a worker that learns them applies them. Such a worker advertises
 * {@link WORKER_ALL_TRACK_OPTIONS_FEATURE} in `worker.info.features`, and then
 * nothing is reported here.
 */
import type { InferenceConfig } from "@/stores/inferenceStore";
import { INFERENCE_DEFAULTS as D } from "@/lib/inferenceDefaults";

/** `worker.info.features` entry for a worker that applies every inference field the app sends. */
export const WORKER_ALL_TRACK_OPTIONS_FEATURE = "track_options_v2";

/**
 * Names of the settings in `config` that differ from the default but that a
 * worker without {@link WORKER_ALL_TRACK_OPTIONS_FEATURE} won't apply. Empty
 * when there are none (or the worker applies everything).
 */
export function remoteIgnoredSettings(config: InferenceConfig, workerFeatures: readonly string[] = []): string[] {
  if (workerFeatures.includes(WORKER_ALL_TRACK_OPTIONS_FEATURE)) return [];
  const out: string[] = [];
  const c = config;
  if (c.maxInstances != null) out.push("Max instances");
  if (c.integralRefinement !== D.integralRefinement || (c.integralRefinement && c.integralPatchSize !== D.integralPatchSize)) {
    out.push("Integral refinement");
  }
  if (
    (c.pipeline === "bottom-up" || c.pipeline === "bottom-up-id") &&
    (c.nPoints !== D.nPoints ||
      c.maxEdgeLengthRatio !== D.maxEdgeLengthRatio ||
      c.distPenaltyWeight !== D.distPenaltyWeight ||
      c.minLineScores !== D.minLineScores)
  ) {
    out.push("Bottom-up grouping");
  }
  if (c.device !== D.device) out.push("Device");
  if (c.runtime !== D.runtime) out.push("Runtime");
  if (c.tracking) {
    if (c.trackerMethod === "kalman") out.push("Kalman tracker (the worker runs the classic tracker)");
    if (
      c.trackerMethod === "flow" &&
      (c.flowImgScale !== D.flowImgScale || c.flowWindowSize !== D.flowWindowSize || c.flowMaxLevels !== D.flowMaxLevels)
    ) {
      out.push("Optical flow settings");
    }
    if (c.similarityMethod === "iou") out.push("IoU similarity (the worker compares keypoints, not boxes)");
    if (
      c.minMatchPoints !== D.minMatchPoints ||
      c.minNewTrackPoints !== D.minNewTrackPoints ||
      c.scoringReduction !== D.scoringReduction
    ) {
      out.push("Track matching settings");
    }
    if (c.trackingTargetInstanceCount != null || c.trackingPreCullToTarget || c.trackingCleanInstanceCount != null) {
      out.push("Target instance count / cull / clean");
    }
  }
  if (c.filterOverlapping) out.push("Filter overlapping instances");
  if (
    c.filterMinVisibleNodes != null ||
    c.filterMinVisibleNodeFraction != null ||
    c.filterMinMeanNodeScore != null ||
    c.filterMinInstanceScore != null ||
    c.filterMinCentroidDistance != null
  ) {
    out.push("Instance filters");
  }
  return out;
}
