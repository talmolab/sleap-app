/**
 * Centroid Only inference: a centroid model run alone, one point per animal
 * (sleap-nn >= 0.3.5, `sleap-nn predict --centroid_only`).
 *
 * What a run returns depends on the skeleton the model was trained on
 * (`sleap_nn/inference/predictor.py`, `_resolve_centroid_packaging`):
 * - 1 node (e.g. a pellet): the point is the whole pose, so the app keeps
 *   sleap-nn's default `--centroid-output instance` and gets ordinary
 *   predicted instances of the project's own skeleton;
 * - more nodes: sleap-nn would put instances on a separate 1-node "centroid"
 *   skeleton, so the app asks for `--centroid-output centroid` and gets
 *   `PredictedCentroid`s in `LabeledFrame.centroids`, drawn on the canvas.
 */
import { compareVersions } from "@/platform/inferenceArgs";

/** First sleap-nn with `--centroid_only` / `--centroid-output`. */
export const MIN_SLEAP_NN_CENTROID_ONLY_VERSION = "0.3.5";

/**
 * Why a Centroid Only run can't start, or null when it can. `sleapNnVersion`
 * is the installed version (null when unknown: then the run is allowed and a
 * too-old sleap-nn reports its own error).
 */
export function centroidOnlyProblem(opts: {
  remote: boolean;
  sleapNnVersion: string | null | undefined;
}): string | null {
  if (opts.remote) {
    return "Centroid Only can't run on a worker yet: workers run `sleap-nn track`, which can't run a centroid model alone. Run it on this computer.";
  }
  const core = opts.sleapNnVersion?.trim().replace(/^v/i, "").split(/[-+ ]/)[0];
  if (core && /^\d+(\.\d+)*$/.test(core) && compareVersions(core, MIN_SLEAP_NN_CENTROID_ONLY_VERSION) < 0) {
    return `Centroid Only needs sleap-nn ${MIN_SLEAP_NN_CENTROID_ONLY_VERSION} or newer (installed: ${opts.sleapNnVersion}). Update it in the Environment panel.`;
  }
  return null;
}
