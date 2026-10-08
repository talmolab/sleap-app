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
import type { ReviewItem } from "@/lib/activeLearning/reviewQueue";

/**
 * Where the continuous round loop is right now. Runtime-only (not persisted):
 * an app restart lands back on `idle` with the persisted history intact.
 *  - `training`   a round's pose model is training
 *  - `predicting` the round's model is predicting new videos / revisit samples
 *  - `reviewing`  the round's review queue is ready (or being swept)
 */
export type LoopStage = "idle" | "training" | "predicting" | "reviewing";

/** One trained model of a round, per training-config slot. */
export interface RoundModel {
  /** Training-config slot ("centroid", "centered_instance", or "config"). */
  slot: string;
  /** The run directory sleap-nn wrote (what `--model_paths` takes). */
  dir: string;
}

/** What one round of the continuous loop trained and produced. Persisted. */
export interface RoundRecord {
  round: number;
  /** The pose pipeline (training `modelType`), reused by later rounds. */
  modelType: string;
  models: RoundModel[];
  /** ISO timestamp of the training run's completion. */
  trainedAt: string;
  /** Whether this round started from the previous round's weights. */
  fineTuned: boolean;
  /** Filled in once the round's inference finishes. */
  predicted?: { videos: number; frames: number };
  /** Size of the review queue the round produced. */
  queued?: number;
}

/** The persisted part of the loop (stored in .slp provenance beside the config). */
export interface PersistedLoopState {
  round: number;
  phase: ActiveLearningPhase | null;
  history: RoundRecord[];
  predictedVideos: string[];
}

export interface ActiveLearningState {
  /** The loaded workflow config, or null if AL is not set up for this project. */
  config: ActiveLearningConfig | null;
  /** Validation of `config` against the project skeleton at adoption time. */
  validation: ConfigValidationResult | null;
  /** 1-based active-learning round (meaningful only once a config is loaded). */
  round: number;
  /** Current phase within the round, or null when idle. */
  phase: ActiveLearningPhase | null;
  /** Rounds whose pose model finished training, oldest first. */
  history: RoundRecord[];
  /**
   * Videos (by {@link videoKey}) that some round has already predicted in full.
   * Anything else in the project is a NEW video the next round predicts first.
   */
  predictedVideos: string[];
  /** Live stage of the continuous loop (runtime-only). */
  stage: LoopStage;
  /** Within `predicting`: inference jobs done / total (runtime-only). */
  stageProgress: { done: number; total: number } | null;
  /**
   * The current round's prepared review queue, waiting for the user (it was
   * badged rather than auto-started). Runtime-only: indices go stale across
   * reloads, so a restart rebuilds from the labels instead.
   */
  pendingQueue: ReviewItem[] | null;

  /** Parse + validate a YAML workflow and adopt it. Returns the validation. */
  loadConfigFromYaml(text: string, skeletonNodeNames?: string[]): ConfigValidationResult;
  /**
   * Adopt an already-built config (validated against the skeleton). Adopting a
   * NEW workflow restarts at round 1 with empty history; pass `keepProgress`
   * when editing the current one, so a tweak doesn't throw the loop away.
   */
  setConfig(
    config: ActiveLearningConfig,
    skeletonNodeNames?: string[],
    opts?: { keepProgress?: boolean },
  ): ConfigValidationResult;
  /** Adopt the built-in default config. */
  useDefaultConfig(skeletonNodeNames?: string[]): ConfigValidationResult;
  /** Drop the config and reset bookkeeping (e.g. on project close). */
  clear(): void;

  /** Enter a specific phase. */
  setPhase(phase: ActiveLearningPhase | null): void;
  /**
   * Advance to the next round.
   *
   * Returns false and changes NOTHING when the loop can't advance: no config
   * (the round counter is meaningless without one) or already at
   * `config.loop.maxRounds` — the config asks for a bounded loop, so honour the
   * bound rather than counting past it.
   *
   * By default the new round starts at {@link firstEnabledPhase}. Pass `phase`
   * to land somewhere else: looping back from a finished correction sweep
   * resumes at the phase that consumes those corrections, not at hand-seeding.
   */
  nextRound(opts?: { phase?: ActiveLearningPhase }): boolean;

  /** Record (or replace) a round's trained model. */
  recordTraining(rec: RoundRecord): void;
  /** Patch an existing round record (inference/review results). */
  updateRound(round: number, patch: Partial<RoundRecord>): void;
  /** Remember videos that have now been predicted in full. */
  markVideosPredicted(keys: string[]): void;
  setStage(stage: LoopStage): void;
  setStageProgress(progress: { done: number; total: number } | null): void;
  setPendingQueue(queue: ReviewItem[] | null): void;
  /** Restore the persisted loop state (project load). */
  restoreLoopState(state: Partial<PersistedLoopState>): void;
}

/** The latest round that has a trained model, or null before round 1 trains. */
export function lastTrainedRound(
  state: Pick<ActiveLearningState, "history">,
): RoundRecord | null {
  return state.history.length > 0 ? state.history[state.history.length - 1] : null;
}

/** Whether {@link ActiveLearningState.nextRound} would advance, and why not. */
export function roundStatus(
  state: Pick<ActiveLearningState, "config" | "round">,
): { canAdvance: boolean; round: number; maxRounds: number | null; atFinalRound: boolean } {
  const maxRounds = state.config?.loop.maxRounds ?? null;
  if (maxRounds === null) {
    return { canAdvance: false, round: state.round, maxRounds: null, atFinalRound: false };
  }
  return {
    canAdvance: state.round < maxRounds,
    round: state.round,
    maxRounds,
    atFinalRound: state.round >= maxRounds,
  };
}

export const useActiveLearningStore = create<ActiveLearningState>((set, get) => ({
  config: null,
  validation: null,
  round: 1,
  phase: null,
  history: [],
  predictedVideos: [],
  stage: "idle",
  stageProgress: null,
  pendingQueue: null,

  loadConfigFromYaml(text, skeletonNodeNames) {
    return get().setConfig(parseActiveLearningConfig(text), skeletonNodeNames);
  },

  setConfig(config, skeletonNodeNames, opts) {
    const validation = validateActiveLearningConfig(config, skeletonNodeNames);
    if (opts?.keepProgress && get().config) {
      set({ config, validation });
      return validation;
    }
    set({
      config,
      validation,
      round: 1,
      phase: firstEnabledPhase(config),
      history: [],
      predictedVideos: [],
      stage: "idle",
      stageProgress: null,
      pendingQueue: null,
    });
    return validation;
  },

  useDefaultConfig(skeletonNodeNames) {
    return get().setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, skeletonNodeNames);
  },

  clear() {
    set({
      config: null,
      validation: null,
      round: 1,
      phase: null,
      history: [],
      predictedVideos: [],
      stage: "idle",
      stageProgress: null,
      pendingQueue: null,
    });
  },

  setPhase(phase) {
    set({ phase });
  },

  nextRound(opts) {
    const { config, round } = get();
    if (!roundStatus({ config, round }).canAdvance) return false;
    set({
      round: round + 1,
      // config is non-null here — canAdvance requires it.
      phase: opts?.phase ?? firstEnabledPhase(config!),
    });
    return true;
  },

  recordTraining(rec) {
    set((s) => ({ history: [...s.history.filter((r) => r.round !== rec.round), rec] }));
  },

  updateRound(round, patch) {
    set((s) => ({ history: s.history.map((r) => (r.round === round ? { ...r, ...patch } : r)) }));
  },

  markVideosPredicted(keys) {
    set((s) => ({ predictedVideos: [...new Set([...s.predictedVideos, ...keys])] }));
  },

  setStage(stage) {
    set({ stage, ...(stage !== "predicting" ? { stageProgress: null } : {}) });
  },

  setStageProgress(progress) {
    set({ stageProgress: progress });
  },

  setPendingQueue(queue) {
    set({ pendingQueue: queue });
  },

  restoreLoopState(state) {
    set((s) => ({
      round: typeof state.round === "number" && state.round >= 1 ? state.round : s.round,
      phase: state.phase !== undefined ? state.phase : s.phase,
      history: Array.isArray(state.history) ? state.history : s.history,
      predictedVideos: Array.isArray(state.predictedVideos) ? state.predictedVideos : s.predictedVideos,
    }));
  },
}));
