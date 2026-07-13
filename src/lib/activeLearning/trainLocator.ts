/**
 * Kick off centroid-locator training for active-learning Phase 1 (issue #212).
 *
 * Configures the shared trainingStore for a standalone centroid model using
 * baseline.centroid.yaml plus the fast-locator overrides from the AL config,
 * then starts a LOCAL (desktop) run. Post-training auto-inference is skipped for
 * centroid models in trainingStore (the `sleap-nn predict` path isn't wired), so
 * this trains the locator and stops.
 */

import { useTrainingStore, type ConfigHyperparams } from "@/stores/trainingStore";
import { getDefaultProfileForHead } from "@/lib/trainingProfiles";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";
import type { ActiveLearningConfig, LocatorAugmentation } from "@/lib/activeLearning/config";

/** Rotation is always kept (orientation varies); scale/intensity by preset. */
function augmentationOverrides(aug: LocatorAugmentation): Partial<ConfigHyperparams> {
  const base: Partial<ConfigHyperparams> = {
    rotationPreset: "180",
    scaleEnabled: false,
    uniformNoiseEnabled: false,
    gaussianNoiseEnabled: false,
    contrastEnabled: false,
    brightnessEnabled: false,
  };
  if (aug === "minimal") return base;
  if (aug === "rotation") return { ...base, scaleEnabled: true };
  return { ...base, scaleEnabled: true, contrastEnabled: true, brightnessEnabled: true };
}

/**
 * Set up the training store for a centroid-only locator run (does NOT start it).
 * Returns true on success; on failure shows a toast and returns false. Used by
 * both "Start training" and "Tweak configs" (which then opens the Training panel).
 */
export function setupCentroidTraining(alConfig: ActiveLearningConfig): boolean {
  const t = useTrainingStore.getState();
  const projectPath = useAppStore.getState().projectPath;
  if (!projectPath) {
    toast.error("Save the project first, then train the locator.");
    return false;
  }
  const baseline = getDefaultProfileForHead("centroid");
  if (!baseline) {
    toast.error("Centroid training profile is missing.");
    return false;
  }

  t.setConfig("modelType", "centroid");
  t.setConfig("trainingLabelsPath", projectPath);

  const parsed = t.parseYamlConfig(baseline.content, baseline.filename, "centroid");
  if (!parsed) {
    toast.error("Failed to parse the centroid training config.");
    return false;
  }
  t.addConfigFile(parsed);

  const tr = alConfig.localize.training;
  t.updateConfigHyperparams("centroid", {
    scale: tr.inputScale,
    anchorPart: alConfig.localize.centroidNode,
    maxEpochs: tr.maxEpochs,
    batchSize: tr.batchSize,
    stopOnPlateau: tr.earlyStop,
    ...augmentationOverrides(tr.augmentation),
  });
  return true;
}

/** Configure + launch centroid-locator training (local/desktop only). */
export async function startCentroidLocatorTraining(alConfig: ActiveLearningConfig): Promise<void> {
  if (!setupCentroidTraining(alConfig)) return;
  await useTrainingStore.getState().startTraining({ inferenceTarget: "nothing" });
  toast.success("Locator training started — keep seeding; it runs in the background.");
}
