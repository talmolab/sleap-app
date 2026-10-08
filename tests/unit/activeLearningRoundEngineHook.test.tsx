/**
 * The round-engine hook's two transitions: a loop round's training run
 * finishing hands off to the round's inference, and a finished review sweep
 * starts the next round after a grace period (cancelled by "Not now" or by
 * stepping back into the queue).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, cleanup } from "@testing-library/react";

const advanceRound = vi.fn(async () => ({ ok: true as const, round: 2 }));
const onRoundTrainingCompleted = vi.fn(async () => {});
vi.mock("@/lib/activeLearning/roundEngine", () => ({ advanceRound, onRoundTrainingCompleted }));

const { useActiveLearningRoundEngine, AUTO_RETRAIN_GRACE_MS } = await import(
  "@/hooks/useActiveLearningRoundEngine"
);
const { useAppStore } = await import("@/stores/appStore");
const { useTrainingStore } = await import("@/stores/trainingStore");
const { useActiveLearningStore } = await import("@/stores/activeLearningStore");
const { DEFAULT_ACTIVE_LEARNING_CONFIG } = await import("@/lib/activeLearning/config");

function Harness() {
  useActiveLearningRoundEngine();
  return null;
}

const item = {
  videoIdx: 0,
  frameIdx: 0,
  instanceIdx: 0,
  worstScore: 0.1,
  worstNodeIdx: 0,
  meanScore: 0.5,
  instanceScore: 0.9,
  pointScores: [0.1],
  centroidXY: [0, 0] as [number, number],
};

/**
 * Capture the hook's grace-period timer (the test shim has no fake timers):
 * swap `setTimeout`/`clearTimeout` only around `fn`, then return a function
 * that fires every still-pending grace timer.
 */
function withCapturedTimers(fn: () => void): () => void {
  const pending = new Map<number, () => void>();
  let next = 1;
  vi.stubGlobal("setTimeout", ((cb: () => void, ms?: number) => {
    const id = next++;
    if (ms === AUTO_RETRAIN_GRACE_MS) pending.set(id, cb);
    return id;
  }) as unknown as typeof setTimeout);
  vi.stubGlobal("clearTimeout", ((id: number) => {
    pending.delete(id);
  }) as unknown as typeof clearTimeout);
  try {
    fn();
  } finally {
    vi.unstubAllGlobals();
  }
  return () => {
    for (const cb of [...pending.values()]) cb();
    pending.clear();
  };
}

function reviewingRound1() {
  const al = useActiveLearningStore.getState();
  al.setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
  al.recordTraining({ round: 1, modelType: "single_animal", models: [{ slot: "config", dir: "/m" }], trainedAt: "t", fineTuned: false });
  al.setStage("reviewing");
  useAppStore.getState().enterCorrectMode({ queue: [item] });
}

describe("useActiveLearningRoundEngine", () => {
  beforeEach(() => {
    advanceRound.mockClear();
    onRoundTrainingCompleted.mockClear();
    useAppStore.setState(useAppStore.getInitialState());
    useTrainingStore.getState().reset();
    useActiveLearningStore.getState().clear();
    render(<Harness />);
  });
  afterEach(() => {
    cleanup();
  });

  it("hands a finished loop round's training run to the round's inference — once", () => {
    useTrainingStore.setState({ status: "running", startedAt: 111, activeLearningRun: { round: 1 } });
    expect(useActiveLearningStore.getState().stage).toBe("training");
    useTrainingStore.setState({ status: "completed" });
    useTrainingStore.setState({ status: "completed", log: ["x"] }); // unrelated update
    expect(onRoundTrainingCompleted).toHaveBeenCalledTimes(1);
    expect(onRoundTrainingCompleted).toHaveBeenCalledWith(1);
  });

  it("ignores runs that aren't loop rounds", () => {
    useTrainingStore.setState({ status: "running", startedAt: 5, activeLearningRun: null });
    useTrainingStore.setState({ status: "completed" });
    expect(onRoundTrainingCompleted).not.toHaveBeenCalled();
  });

  it("starts the next round after the grace period once the sweep is finished", () => {
    reviewingRound1();
    const fire = withCapturedTimers(() => useAppStore.getState().correctAdvance()); // past the last item
    expect(advanceRound).not.toHaveBeenCalled();
    fire();
    expect(advanceRound).toHaveBeenCalledTimes(1);
  });

  it("cancels when the user steps back into the queue", () => {
    reviewingRound1();
    const fire = withCapturedTimers(() => {
      useAppStore.getState().correctAdvance();
      useAppStore.getState().correctBack();
    });
    fire();
    expect(advanceRound).not.toHaveBeenCalled();
  });

  it("does nothing for a standalone correction sweep (not a loop round)", () => {
    useAppStore.getState().enterCorrectMode({ queue: [item] });
    const fire = withCapturedTimers(() => useAppStore.getState().correctAdvance());
    fire();
    expect(advanceRound).not.toHaveBeenCalled();
  });
});
