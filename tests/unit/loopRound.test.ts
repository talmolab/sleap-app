/**
 * Round orchestration: closing the active-learning loop.
 *
 * `nextRound()` previously had ZERO call sites — the dashboard's round counter
 * never moved and a finished correction sweep dead-ended at "Done", so the
 * corrections never fed a retrain. These cover the guard rails (bounded by
 * `loop.maxRounds`, refuses without a config) and the hand-off, including the
 * ordering invariant that a failed hand-off must not bump the round.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { useActiveLearningStore, roundStatus } from "@/stores/activeLearningStore";
import { useAppStore } from "@/stores/appStore";
import { useTrainingStore } from "@/stores/trainingStore";
import { startNextRound } from "@/lib/activeLearning/loopRound";

function resetAll() {
  useAppStore.setState(useAppStore.getInitialState());
  useActiveLearningStore.getState().clear();
  useTrainingStore.getState().reset();
  useTrainingStore.getState().setPendingHandoff(null);
}

/** Adopt the built-in workflow (maxRounds 5, localize enabled). */
function withConfig() {
  useActiveLearningStore.getState().useDefaultConfig(["a", "b", "c"]);
  return useActiveLearningStore.getState().config!;
}

describe("roundStatus", () => {
  beforeEach(resetAll);

  it("reports no loop at all without a config", () => {
    expect(roundStatus({ config: null, round: 1 })).toEqual({
      canAdvance: false,
      round: 1,
      maxRounds: null,
      atFinalRound: false,
    });
  });

  it("can advance below the cap and not at it", () => {
    const config = withConfig();
    const max = config.loop.maxRounds;
    expect(roundStatus({ config, round: 1 }).canAdvance).toBe(true);
    expect(roundStatus({ config, round: max - 1 }).canAdvance).toBe(true);
    expect(roundStatus({ config, round: max }).canAdvance).toBe(false);
    expect(roundStatus({ config, round: max }).atFinalRound).toBe(true);
  });
});

describe("nextRound", () => {
  beforeEach(resetAll);

  it("refuses without a config and changes nothing", () => {
    const before = useActiveLearningStore.getState().round;
    expect(useActiveLearningStore.getState().nextRound()).toBe(false);
    expect(useActiveLearningStore.getState().round).toBe(before);
  });

  it("advances and resets to the first enabled phase by default", () => {
    withConfig();
    expect(useActiveLearningStore.getState().nextRound()).toBe(true);
    expect(useActiveLearningStore.getState().round).toBe(2);
    // Default config enables localize.
    expect(useActiveLearningStore.getState().phase).toBe("localize");
  });

  it("honours an explicit landing phase", () => {
    withConfig();
    useActiveLearningStore.getState().nextRound({ phase: "mine" });
    expect(useActiveLearningStore.getState().phase).toBe("mine");
  });

  it("stops at maxRounds instead of counting past it", () => {
    const config = withConfig();
    const max = config.loop.maxRounds;
    for (let i = 1; i < max; i++) {
      expect(useActiveLearningStore.getState().nextRound()).toBe(true);
    }
    expect(useActiveLearningStore.getState().round).toBe(max);
    // The cap holds, repeatedly.
    expect(useActiveLearningStore.getState().nextRound()).toBe(false);
    expect(useActiveLearningStore.getState().nextRound()).toBe(false);
    expect(useActiveLearningStore.getState().round).toBe(max);
  });
});

describe("startNextRound", () => {
  beforeEach(resetAll);

  it("explains itself when no workflow is loaded", () => {
    useAppStore.setState({ projectPath: "/proj.slp" });
    const r = startNextRound();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("No active-learning workflow");
  });

  it("names the cap and how to raise it at the final round", () => {
    const config = withConfig();
    useAppStore.setState({ projectPath: "/proj.slp" });
    useActiveLearningStore.setState({ round: config.loop.maxRounds });
    const r = startNextRound();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("maxRounds");
  });

  it("does NOT advance the round when the training hand-off fails", () => {
    // The ordering invariant: an unsaved project can't retrain (training reads
    // the .slp from disk), and bumping the round first would leave the dashboard
    // claiming a round that was never queued.
    withConfig();
    useAppStore.setState({ projectPath: null });
    const r = startNextRound();
    expect(r.ok).toBe(false);
    expect(useActiveLearningStore.getState().round).toBe(1);
    expect(useTrainingStore.getState().pendingHandoff).toBeNull();
  });

  it("advances, leaves the sweep, and queues the retrain", () => {
    withConfig();
    useAppStore.setState({ projectPath: "/proj.slp" });
    // Simulate a finished correction sweep with a stale review badge.
    useAppStore.getState().enterCorrectMode({ queue: [] });
    useAppStore.getState().setPendingReview({ flagged: 3, total: 9 });

    const r = startNextRound();
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.round).toBe(2);

    const al = useActiveLearningStore.getState();
    expect(al.round).toBe(2);
    // Looping back from corrections into a retrain — not back to hand-seeding.
    expect(al.phase).toBe("mine");

    const app = useAppStore.getState();
    expect(app.labelingMode).not.toBe("correct");
    expect(app.pendingReview).toBeNull();
    expect(app.sidebarOpenPanels).toContain("training");

    // The hand-off the Training panel drains on arrival.
    const t = useTrainingStore.getState();
    expect(t.config.trainingLabelsPath).toBe("/proj.slp");
    expect(t.pendingHandoff?.requireModelTypeChoice).toBe(true);
    expect(t.pendingHandoff?.skipUserLabeled).toBe(true);
  });

  it("can be driven repeatedly up to the cap", () => {
    const config = withConfig();
    useAppStore.setState({ projectPath: "/proj.slp" });
    for (let i = 1; i < config.loop.maxRounds; i++) {
      expect(startNextRound().ok).toBe(true);
    }
    expect(useActiveLearningStore.getState().round).toBe(config.loop.maxRounds);
    expect(startNextRound().ok).toBe(false);
  });
});
