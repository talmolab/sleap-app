/**
 * Drives the continuous active-learning loop between rounds (see
 * `lib/activeLearning/roundEngine`). Mounted once, in AppShell.
 *
 * Two transitions keep the loop moving:
 *  - A loop round's training run finishes: record its models, predict, then
 *    review (`onRoundTrainingCompleted`).
 *  - A round's review sweep reaches its last item: with `loop.autoRetrain`,
 *    start the next round after a short grace period. It cancels if the user
 *    steps back into the queue, or picks "Not now".
 */

import { useEffect } from "react";
import { useTrainingStore } from "@/stores/trainingStore";
import { useAppStore } from "@/stores/appStore";
import {
  useActiveLearningStore,
  roundStatus,
  lastTrainedRound,
} from "@/stores/activeLearningStore";
import { advanceRound, onRoundTrainingCompleted } from "@/lib/activeLearning/roundEngine";
import { toast } from "@/lib/notify";

/** How long the "retraining in…" toast waits before the next round starts. */
export const AUTO_RETRAIN_GRACE_MS = 5000;

function sweepFinished(s: {
  labelingMode: string;
  correctQueue: unknown[];
  correctCursor: number;
}): boolean {
  return s.labelingMode === "correct" && s.correctQueue.length > 0 && s.correctCursor >= s.correctQueue.length;
}

export function useActiveLearningRoundEngine(): void {
  useEffect(() => {
    // One completion per run: a run is identified by its start time.
    let handledRun: number | null = null;
    const unsubTraining = useTrainingStore.subscribe((s, prev) => {
      const run = s.activeLearningRun;
      if (!run || s.status === prev.status) return;
      const al = useActiveLearningStore.getState();
      if (s.status === "running") {
        al.setStage("training");
        return;
      }
      if (prev.status !== "running") return;
      if (s.status === "completed") {
        if (handledRun === s.startedAt) return;
        handledRun = s.startedAt;
        void onRoundTrainingCompleted(run.round);
      } else {
        al.setStage("idle");
        toast.error(
          `Round ${run.round}: training ${s.status === "stopped" ? "was stopped" : "failed"}. The loop is paused — retrain from the Correct tab when ready.`,
        );
      }
    });

    let pending: ReturnType<typeof setTimeout> | null = null;
    const cancelPending = () => {
      if (pending) clearTimeout(pending);
      pending = null;
    };
    const unsubApp = useAppStore.subscribe((s, prev) => {
      const done = sweepFinished(s);
      const wasDone = sweepFinished(prev);
      if (!done && wasDone) {
        cancelPending();
        return;
      }
      if (!done || wasDone) return;
      const al = useActiveLearningStore.getState();
      if (al.stage !== "reviewing" || !al.config?.loop.autoRetrain) return;
      if (!roundStatus(al).canAdvance || !lastTrainedRound(al)) return;
      cancelPending();
      const next = al.round + 1;
      toast.info(`Round ${al.round} reviewed. Round ${next} starts training in ${AUTO_RETRAIN_GRACE_MS / 1000} s.`, {
        duration: AUTO_RETRAIN_GRACE_MS,
        action: {
          label: "Not now",
          onClick: () => {
            cancelPending();
            useActiveLearningStore.getState().setStage("idle");
          },
        },
      });
      pending = setTimeout(() => {
        pending = null;
        // Still sitting on the finished sweep? Then go.
        if (!sweepFinished(useAppStore.getState())) return;
        void advanceRound().then((o) => {
          if (!o.ok) toast.error(o.reason);
        });
      }, AUTO_RETRAIN_GRACE_MS);
    });

    return () => {
      cancelPending();
      unsubTraining();
      unsubApp();
    };
  }, []);
}
