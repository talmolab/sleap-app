/**
 * Resolves which config a training-panel slot should auto-load: the EXACT
 * config from that head's most recently trained run under
 * `{projectDir}/models/` (via `modelDiscovery.findTrainedModels`) when one
 * exists, falling back to the generic baseline profile otherwise. Used both
 * for a fresh project (no trained runs yet → baseline) and for "Train Again"
 * (`trainingStore.reset()`), where the prior run's config should win over the
 * baseline so retraining resumes from what was actually run last time.
 *
 * File access is injectable (mirrors `modelDiscovery.ModelFsAccess`) so this
 * is unit-testable without the Tauri runtime.
 */

import type { DiscoveredModel } from "./modelDiscovery";
import { slotToHeadType, getRecommendedProfileForHead } from "./trainingProfiles";
import type { BackboneProfileRecommendation } from "./modelStats";
import type { ModelType } from "@/stores/trainingStore";

export interface SlotConfigSource {
  yamlText: string;
  filename: string;
  /** Absolute path to the source run's checkpoint file, for Resume/Fine-tune. `null` for a baseline profile or a trained run with no resolvable checkpoint. */
  checkpointPath: string | null;
  /** Where this config came from — a prior trained run, or a baseline preset
   *  (fresh project, no matching trained run). Callers use this to know
   *  whether to seed a fresh baseline's max_stride as Auto (`null`) — a
   *  trained run's own max_stride should always be honored as-is. */
  source: "trained" | "baseline";
}

/** Minimal filesystem surface this resolver needs (injectable for tests). */
export interface TrainedConfigFsAccess {
  readTextFile(path: string): Promise<string>;
  join(dir: string, name: string): Promise<string>;
}

export interface ResolveSlotConfigOptions {
  /**
   * When `false`, skip the trained-run lookup entirely and always use the
   * baseline — for the tutorial's first training pass (see
   * `TUTORIAL_FIRST_TRAINING_STEP_IDS` in `lib/tutorial/steps.ts`), which is
   * meant to demonstrate the baseline workflow even if a trained run already
   * exists on disk for this head (e.g. a prior tutorial pass on the same
   * project). Defaults to `true` (normal "Train Again" behavior).
   */
  preferTrained?: boolean;
  /** Size-derived Medium/Large RF recommendation (see recommendBackboneProfile
   *  in modelStats.ts) used to pick the baseline profile's RF tier. `null`/
   *  omitted falls back to the Medium RF profile (e.g. no project loaded yet). */
  recommendation?: BackboneProfileRecommendation | null;
}

/**
 * Pick the config source for one slot: the matching trained run's
 * `training_config.yaml` if `discovered` has one for this slot's head, else
 * the baseline profile. Returns `null` only if neither exists (no trained run
 * AND no baseline for this head).
 */
export async function resolveSlotConfigSource(
  slot: string,
  modelType: ModelType,
  discovered: DiscoveredModel[],
  fs: TrainedConfigFsAccess,
  opts: ResolveSlotConfigOptions = {},
): Promise<SlotConfigSource | null> {
  const headType = slotToHeadType(modelType, slot);
  if (opts.preferTrained ?? true) {
    const trainedMatch = discovered.find((m) => m.headKey === headType);
    if (trainedMatch) {
      try {
        const cfgPath = await fs.join(trainedMatch.path, "training_config.yaml");
        const yamlText = await fs.readTextFile(cfgPath);
        const checkpointPath = trainedMatch.checkpointFile
          ? await fs.join(trainedMatch.path, trainedMatch.checkpointFile)
          : null;
        return { yamlText, filename: "training_config.yaml", checkpointPath, source: "trained" };
      } catch {
        // Unreadable/missing despite discovery — fall through to the baseline.
      }
    }
  }
  const baseline = getRecommendedProfileForHead(headType, opts.recommendation ?? null);
  return baseline
    ? { yamlText: baseline.content, filename: baseline.filename, checkpointPath: null, source: "baseline" }
    : null;
}
