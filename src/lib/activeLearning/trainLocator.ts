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
import { useEnvironmentStore } from "@/stores/environmentStore";
import { getDefaultProfileForHead } from "@/lib/trainingProfiles";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/platform";
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

/**
 * Configure + launch centroid-locator training (local/desktop only).
 *
 * Prechecks the runtime so we never claim "training started" when it can't:
 * training needs the desktop app AND a selected Python with sleap-nn installed.
 * On success it fires the run WITHOUT awaiting (startTraining resolves only when
 * the whole run finishes, and reports failures via status "error" rather than
 * throwing) — the top-bar TrainingProgressBar surfaces progress/errors/log.
 * Returns true if a run was actually kicked off.
 */
export function startCentroidLocatorTraining(alConfig: ActiveLearningConfig): boolean {
  if (!isTauri) {
    toast.error("Locator training runs in the desktop app only.");
    return false;
  }
  // sleap-nn is normally a `uv tool` (its own venv), invoked as the `sleap-nn`
  // command by runTraining — so it is NOT importable from a selected Python and
  // needs no interpreter selected. Detect it the way the Inference panel does
  // (the uv tool list); also accept a python-venv install (pythonCheck).
  const env = useEnvironmentStore.getState();
  const sleapNnAvailable =
    env.tools.some((t) => t.name === "sleap-nn" || t.commands?.includes("sleap-nn")) ||
    !!env.pythonCheck?.sleapNnVersion;
  if (!sleapNnAvailable) {
    toast.error("sleap-nn isn't detected. Install it in the Environment panel, then train.");
    return false;
  }
  if (!setupCentroidTraining(alConfig)) return false;

  void useTrainingStore.getState().startTraining({ inferenceTarget: "nothing" });
  return true;
}
