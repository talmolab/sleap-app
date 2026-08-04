/**
 * Hand active-learning Phase 2 off to pose-model training (issue #212).
 *
 * Phase 2 ends with a project full of hand-placed keypoints and nothing to do
 * with them. This is the bridge to Phase 3: set the Training panel up for a
 * pose run, send the user there to choose a pipeline, and let the panel's
 * existing post-training inference carry the predictions back for correction.
 *
 * Deliberately thin compared to {@link ./trainLocator}. The locator is a fixed
 * recipe (centroid head, fast preset, known augmentation), so it presets
 * everything and can start unattended. A pose model is NOT a fixed recipe —
 * top-down, bottom-up and single-animal are all legitimate depending on the
 * data, so this presets nothing about the model and hands the choice to the
 * Training panel, which already recommends a pipeline from the labels
 * (`recommendPipeline`) and disables the ones the skeleton can't support
 * (`getSkeletonCompatibility`, e.g. bottom-up needs edges for PAFs).
 */

import { useTrainingStore } from "@/stores/trainingStore";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";

/**
 * Post-training inference scope for the AL loop: every frame of the current
 * video EXCEPT the ones already labeled by hand.
 *
 * Phase 3 ranks by worst keypoint to surface hard examples, so re-predicting
 * frames that already have ground truth spends compute to produce instances
 * that will never be corrected. `"video"` + `skipUserLabeled` is how the
 * training store expresses that (it becomes `excludeUserLabeled` on the
 * inference config, i.e. sleap-nn's `--exclude_user_labeled`).
 */
const AL_INFERENCE_TARGET = "video";

/**
 * Prepare the training store for a Phase-2 → pose handoff.
 *
 * Returns true when the caller should navigate to the Training panel; on
 * failure it toasts and returns false.
 *
 * Does NOT set `modelType` — see the module note. It also does not start the
 * run: the user picks the pipeline and presses Start themselves.
 */
export function setupPoseTraining(): boolean {
  const projectPath = useAppStore.getState().projectPath;
  if (!projectPath) {
    // Training reads the .slp from DISK — `trainingLabelsPath || projectPath`,
    // with no re-serialize of in-memory labels. An unsaved project would train
    // on a file that predates the whole keypoint sweep.
    toast.error("Save the project first, then train a pose model.");
    return false;
  }

  const t = useTrainingStore.getState();
  t.setConfig("trainingLabelsPath", projectPath);
  t.setPendingHandoff({
    inferenceTarget: AL_INFERENCE_TARGET,
    skipUserLabeled: true,
    requireModelTypeChoice: true,
  });
  return true;
}
