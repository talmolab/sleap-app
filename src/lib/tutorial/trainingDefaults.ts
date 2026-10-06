/**
 * Training-config values the tutorial sets for the user, as a pure function so
 * they're testable without the overlay. `TutorialOverlay` calls this on every
 * re-check tick and applies the result with `updateConfigHyperparams` —
 * every tick, not once, because the configs load (and "Train Again" reloads
 * them) asynchronously in `TrainingPanel`, after the step has started.
 */

import type { TrainingStatus } from "@/stores/trainingStore";
import { TUTORIAL_FIRST_TRAINING_STEP_IDS } from "./steps";

/** Epochs for the first training pass: just enough to see the loop work. */
export const TUTORIAL_MAX_EPOCHS = 5;

/**
 * Default epochs for the retrain step. "Train Again" reloads the last run's
 * config — the 5-epoch first pass — so any config still at
 * `TUTORIAL_MAX_EPOCHS` is raised to this. A value the user typed themselves
 * is left alone; the step's completion doesn't depend on it.
 */
export const TUTORIAL_RETRAIN_EPOCHS = 50;

/**
 * Anchor part set for Top-Down: the central node of the skeleton the
 * create-skeleton step asks for. Set on the centered-instance config (as the
 * Anchor Part dropdown does), but only while it's still Auto and only if the
 * skeleton has that node — a user's own pick is kept, and an anchor naming a
 * missing node would make training fail.
 */
export const TUTORIAL_ANCHOR_PART = "torso";
const ANCHOR_STEP_IDS = new Set(["run-training", "retrain"]);

export interface TutorialConfigView {
  slot: string;
  maxEpochs: number;
  anchorPart: string | null;
}

export interface TutorialConfigUpdate {
  slot: string;
  updates: { maxEpochs?: number; anchorPart?: string };
}

export function tutorialTrainingUpdates(
  stepId: string,
  trainingStatus: TrainingStatus,
  skeletonNodeNames: string[],
  configs: TutorialConfigView[],
): TutorialConfigUpdate[] {
  const out: TutorialConfigUpdate[] = [];
  const idle = trainingStatus !== "running";

  for (const cf of configs) {
    const updates: TutorialConfigUpdate["updates"] = {};
    if (TUTORIAL_FIRST_TRAINING_STEP_IDS.has(stepId)) {
      if (cf.maxEpochs !== TUTORIAL_MAX_EPOCHS) updates.maxEpochs = TUTORIAL_MAX_EPOCHS;
    } else if (stepId === "retrain" && idle && cf.maxEpochs === TUTORIAL_MAX_EPOCHS) {
      updates.maxEpochs = TUTORIAL_RETRAIN_EPOCHS;
    }
    if (
      ANCHOR_STEP_IDS.has(stepId) &&
      idle &&
      cf.slot === "centered_instance" &&
      cf.anchorPart === null &&
      skeletonNodeNames.includes(TUTORIAL_ANCHOR_PART)
    ) {
      updates.anchorPart = TUTORIAL_ANCHOR_PART;
    }
    if (Object.keys(updates).length > 0) out.push({ slot: cf.slot, updates });
  }
  return out;
}
