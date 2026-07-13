/**
 * Active-learning loop state (issue #212).
 *
 * Holds the project's workflow config (the "define the workflow" step) plus the
 * round/phase bookkeeping the dashboard uses. Compute is NOT done here — the
 * orchestrator drives the existing {@link trainingStore}/{@link inferenceStore}
 * local paths. This store is deliberately small and side-effect-free so it is
 * unit-testable via `useActiveLearningStore.getState()`.
 */

import { create } from "zustand";
import {
  DEFAULT_ACTIVE_LEARNING_CONFIG,
  firstEnabledPhase,
  parseActiveLearningConfig,
  validateActiveLearningConfig,
  type ActiveLearningConfig,
  type ActiveLearningPhase,
  type ConfigValidationResult,
} from "@/lib/activeLearning/config";

export interface ActiveLearningState {
  /** The loaded workflow config, or null if AL is not set up for this project. */
  config: ActiveLearningConfig | null;
  /** Validation of `config` against the project skeleton at adoption time. */
  validation: ConfigValidationResult | null;
  /** 1-based active-learning round (meaningful only once a config is loaded). */
  round: number;
  /** Current phase within the round, or null when idle. */
  phase: ActiveLearningPhase | null;

  /** Parse + validate a YAML workflow and adopt it. Returns the validation. */
  loadConfigFromYaml(text: string, skeletonNodeNames?: string[]): ConfigValidationResult;
  /** Adopt an already-built config (validated against the skeleton). */
  setConfig(config: ActiveLearningConfig, skeletonNodeNames?: string[]): ConfigValidationResult;
  /** Adopt the built-in default config. */
  useDefaultConfig(skeletonNodeNames?: string[]): ConfigValidationResult;
  /** Drop the config and reset bookkeeping (e.g. on project close). */
  clear(): void;

  /** Enter a specific phase. */
  setPhase(phase: ActiveLearningPhase | null): void;
  /** Advance to the next round, resetting to the first enabled phase. */
  nextRound(): void;
}

export const useActiveLearningStore = create<ActiveLearningState>((set, get) => ({
  config: null,
  validation: null,
  round: 1,
  phase: null,

  loadConfigFromYaml(text, skeletonNodeNames) {
    return get().setConfig(parseActiveLearningConfig(text), skeletonNodeNames);
  },

  setConfig(config, skeletonNodeNames) {
    const validation = validateActiveLearningConfig(config, skeletonNodeNames);
    set({
      config,
      validation,
      round: 1,
      phase: firstEnabledPhase(config),
    });
    return validation;
  },

  useDefaultConfig(skeletonNodeNames) {
    return get().setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, skeletonNodeNames);
  },

  clear() {
    set({ config: null, validation: null, round: 1, phase: null });
  },

  setPhase(phase) {
    set({ phase });
  },

  nextRound() {
    const { config, round } = get();
    set({
      round: round + 1,
      phase: config ? firstEnabledPhase(config) : null,
    });
  },
}));
