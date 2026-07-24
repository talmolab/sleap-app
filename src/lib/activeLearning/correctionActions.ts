/**
 * Phase-3 correction actions that touch both the store and the command system,
 * shared by the VideoPlayer (Space key) and the correction UI (Accept buttons)
 * so "accept" behaves identically everywhere.
 */

import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext, ConvertPredictionToInstance } from "@/commands";
import { resolveReviewInstance } from "./reviewQueue";

/** Is the store currently framed on this queue item's video + frame? */
function onItemFrame(item: { videoIdx: number; frameIdx: number }): boolean {
  const s = useAppStore.getState();
  return (
    !!s.labels &&
    s.frameIdx === item.frameIdx &&
    s.labels.videos[item.videoIdx] === s.video
  );
}

/**
 * Accept the instance currently under review — adopting the prediction as a
 * user label even if it was never touched, since reviewing it endorses it — and
 * advance to the next queued item. A dragged instance is already a user
 * instance, so the convert no-ops and this just advances.
 *
 * If the view drifted off the item's frame, it snaps back first, then RE-VERIFIES
 * it actually landed there before converting: `ConvertPredictionToInstance`
 * targets the store's live `frameIdx`, which `setFrameIdx` clamps to the video's
 * frame count — for a deferred video whose count is still a stand-in, the target
 * frame can clamp to a different frame and convert the wrong instance. If we
 * can't land on the item's frame, bail WITHOUT converting or advancing (a retry
 * once the video backend loads works) so we never mutate the wrong frame.
 */
export function acceptAndAdvanceCorrection(): void {
  const s0 = useAppStore.getState();
  const item = s0.correctQueue[s0.correctCursor];
  if (!item || !s0.labels) {
    useAppStore.getState().correctAdvance();
    return;
  }
  if (!onItemFrame(item)) {
    s0.syncCorrectSelection();
    if (!onItemFrame(item)) return; // couldn't navigate to the item — don't guess
  }
  const s = useAppStore.getState();
  if (s.labels) {
    const inst = resolveReviewInstance(s.labels, item);
    if (inst instanceof PredictedInstance) {
      commandContext.execute(ConvertPredictionToInstance, { instanceIdx: item.instanceIdx });
    }
  }
  useAppStore.getState().correctAdvance();
}
