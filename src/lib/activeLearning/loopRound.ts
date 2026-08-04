/**
 * Close the active-learning loop: turn a finished correction sweep into the next
 * round's training run (issue #212).
 *
 * Until this existed, `nextRound()` had zero call sites — the round counter in
 * the dashboard never moved and the loop wasn't a loop. Correcting predictions
 * dead-ended at a "Done" button, so round 2 meant repeating every step by hand
 * and, worse, the corrections you just made never fed a retrain.
 *
 * The insight is that a correction sweep IS the mining phase: every instance you
 * accepted became a user label, so the project now holds strictly more training
 * data than when the model was trained. Retraining on it is the whole point of
 * the loop, and it's the same hand-off Phase 2 uses — so reuse it rather than
 * inventing a second path to the Training panel.
 */

import { useActiveLearningStore, roundStatus } from "@/stores/activeLearningStore";
import { useAppStore } from "@/stores/appStore";
import { setupPoseTraining } from "./trainPose";

export type NextRoundOutcome =
  | { ok: true; round: number }
  | { ok: false; reason: string };

/**
 * Advance the loop one round and hand off to pose retraining.
 *
 * Order matters. The training hand-off is attempted FIRST because it can fail
 * (an unsaved project would retrain on a `.slp` that predates the corrections —
 * training reads from disk, not from memory). Bumping the round before that
 * check could leave the dashboard claiming round 3 while nothing was queued.
 *
 * Lands the new round on the `mine` phase rather than `firstEnabledPhase`: we're
 * looping back from corrections into a retrain, not restarting at hand-seeding
 * centroids, which is what `localize` would mean.
 */
export function startNextRound(): NextRoundOutcome {
  const al = useActiveLearningStore.getState();
  const status = roundStatus(al);

  if (status.maxRounds === null) {
    return { ok: false, reason: "No active-learning workflow is loaded." };
  }
  if (!status.canAdvance) {
    return {
      ok: false,
      reason: `Round ${status.round} of ${status.maxRounds} — the configured loop is complete. Raise loop.maxRounds to keep going.`,
    };
  }

  // Fails loudly (toasts) when the project isn't saved.
  if (!setupPoseTraining()) {
    return { ok: false, reason: "Couldn't set up training for the next round." };
  }

  // Leave the correction sweep before navigating — its keybindings and zoom
  // shouldn't survive into the Training panel.
  const app = useAppStore.getState();
  if (app.labelingMode === "correct") app.exitCorrectMode();
  // The sweep is over; a leftover badge would re-announce work already done.
  app.setPendingReview(null);

  if (!al.nextRound({ phase: "mine" })) {
    return { ok: false, reason: "The loop could not advance." };
  }

  app.openPanel("training");
  return { ok: true, round: useActiveLearningStore.getState().round };
}
