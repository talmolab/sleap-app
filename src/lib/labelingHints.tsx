/**
 * "Gentle hint" toasts for common novice labeling pitfalls (#341): missing
 * (grey) nodes on a converted prediction, drawing a fresh instance in a frame
 * that already has predictions to double-click instead, leaving other
 * animals' predictions unconverted after accepting one, not knowing you can
 * clone an existing pose instead of drawing a similar one from scratch, not
 * knowing you can move/rotate a whole instance at once instead of
 * repositioning nodes one by one, not knowing what the red→green node
 * transition even means the first time it happens, and force-placing a
 * position for a node that's actually hidden/occluded instead of marking it
 * not-visible. These mirror tips from the legacy PyQt SLEAP tutorial
 * (../sleap/docs/tutorial/initial-labeling.md) that sleap-app already
 * implements (Ctrl/Cmd-drag clone, Alt-drag/-scroll, right-click to toggle
 * visibility) but never surfaces outside its own guided tutorial.
 *
 * The node colors themselves (red/green/yellow) get taught TWICE, on
 * purpose, in two different ways: persistently in the node-hover tooltip
 * (`VideoPlayer.tsx`'s "Node hover tooltip" block — the always-available
 * reference), and proactively via `node-confirmed-color` right at the moment
 * of a red→green transition, so a first-time user sees the explanation
 * exactly when it becomes relevant, not only if they happen to hover a node
 * afterward. Both duplicate — deliberately — the "Label tips" text already
 * shown in the guided tutorial's `correct-predictions` step
 * (`lib/tutorial/steps.ts`), for users who label without ever running that
 * tutorial.
 *
 * Each hint is shown by calling `showLabelingHint` from the discrete action
 * that meets its condition (see call sites in `commands/editCommands.ts` and
 * `components/video/VideoPlayer.tsx`) — NOT from a continuous per-frame
 * check — so a still-true condition doesn't reopen a toast on every render.
 *
 * Gating (#341): the "Show Hints During Labeling" setting (Labels menu /
 * Welcome screen, default on, persisted as `showLabelingHints`) is the ONLY
 * PERSISTED gate — there is deliberately no per-hint "seen it, never again"
 * tracking in storage. (An earlier version permanently silenced a hint on
 * its first showing or on an explicit toast dismiss; that state got stuck
 * from one round of testing to the next with no visible reason a hint had
 * gone silent, so it was removed outright rather than given a reset button
 * to work around it.) Most hints fire every time their condition is met, in
 * every session. A few that fire on a per-NODE (rather than per-action)
 * transition -- `node-confirmed-color`, `mark-occluded-invisible`,
 * `prediction-conversion-lifecycle` -- additionally cap at once per SESSION
 * via a plain module-scoped variable (not the store, not persisted) so they
 * don't repeat once per node/conversion; being module state, it resets on
 * every fresh page load or app relaunch same as everything else here.
 */

import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { Instance, LabeledFrame, Labels } from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";
import { useAppStore } from "@/stores/appStore";
import { formatShortcut } from "@/lib/formatShortcut";

export type LabelingHintId =
  | "missing-nodes-right-click"
  | "double-click-to-convert"
  | "convert-remaining-predictions"
  | "clone-instance-drag"
  | "move-rotate-whole-instance"
  | "node-confirmed-color"
  | "add-another-instance"
  | "mark-occluded-invisible"
  | "prediction-conversion-lifecycle";

const HINT_BODY: Record<LabelingHintId, React.ReactNode> = {
  "missing-nodes-right-click": (
    <>
      When correcting predictions, you can right-click the small, grey nodes
      to mark them as visible.
    </>
  ),
  "double-click-to-convert": (
    <>
      You can create user instances (labels) faster by double-clicking the
      yellow colored poses instead of creating them from scratch.
    </>
  ),
  "convert-remaining-predictions": (
    <>
      Predictions are not used for training, so don't forget to create a user
      label for <strong>each animal</strong> in the frame.
    </>
  ),
  "clone-instance-drag": (
    <>
      Already have a similarly-posed animal in this frame? Hold{" "}
      <strong>{formatShortcut("Ctrl")}</strong> and drag any node of that
      instance to clone it, instead of placing points from scratch.
    </>
  ),
  "move-rotate-whole-instance": (
    <>
      To move the whole instance at once instead of node-by-node,
      double-click any node to select all of them, then drag any one. Hold{" "}
      <strong>{formatShortcut("Alt")}</strong> while scrolling to rotate the
      selected instance.
    </>
  ),
  "node-confirmed-color": (
    <>
      That node just turned green — meaning you've verified its position.
      Nodes start red (auto-placed) whether they came from a prediction or
      you placed them yourself; you only need to click or drag one if its
      position looks wrong. A red node you're happy with is fine to leave
      as-is.
    </>
  ),
  "add-another-instance": (
    <>
      More than one animal in this frame? Right-click → <strong>Add
      Instance</strong> (or <strong>{formatShortcut("$mod+KeyI")}</strong>) to
      place another one, or hold <strong>{formatShortcut("Ctrl")}</strong> and
      drag any node of this instance to clone its pose.
    </>
  ),
  "mark-occluded-invisible": (
    <>
      If a node is hidden or occluded in this frame, right-click it to mark it{" "}
      <strong>not visible</strong> instead of guessing where it is.
    </>
  ),
  "prediction-conversion-lifecycle": (
    <>
      <strong>Yellow</strong> is a prediction. Once you convert it to a user
      label it starts <strong>red</strong> — unconfirmed — even though the
      points already have positions. You don't need to turn every node{" "}
      <strong>green</strong>; only click or drag the ones whose position
      needs fixing, and leave the rest red if they already look right.
    </>
  ),
};

/** How long the hint stays up before auto-dismissing. Longer than a typical
 *  status toast since these are meant to be read, not just glanced at. */
const HINT_DURATION_MS = 12000;

/**
 * Show a labeling hint toast, honoring the "Show Hints During Labeling"
 * setting — the only gate. Safe to call unconditionally from a triggering
 * action; a no-op only when the setting is off.
 */
export function showLabelingHint(id: LabelingHintId): void {
  if (!useAppStore.getState().showLabelingHints) return;

  toast.info("Tip", {
    description: HINT_BODY[id],
    duration: HINT_DURATION_MS,
    // top-center, not the app's default bottom-right — these are meant to be
    // noticed near where you're actually looking (the canvas), and to read
    // as distinct from routine bottom-right status toasts (save/export/etc).
    position: "top-center",
    // Replaces sonner's default info-circle icon (redundant with a second
    // icon otherwise sitting right next to it) rather than adding alongside it.
    icon: "💡",
    // A size step down from the app's regular toasts (they read as more
    // "ambient nudge" than "status update").
    classNames: { title: "text-xs", description: "text-xs leading-snug" },
  });
}

// Module-scoped (not store/persisted) so it resets on every fresh session —
// a full page reload or app relaunch — but stays true for the rest of a
// running session once shown once. Unlike the other hints, these fire on a
// per-NODE transition rather than a per-user-action one, so without a
// session cap they'd repeat once per node placed/dragged (every node on a
// freshly-drawn instance, for instance) instead of teaching the concept once
// and then getting out of the way.
let nodeConfirmedColorShownThisSession = false;
let markOccludedInvisibleShownThisSession = false;

/**
 * Call right after setting `point.complete = true` to nudge on a red→green
 * transition — whether the node came from a prediction
 * (fillMissingPredictedNodes/conversion) or a from-scratch placement.
 * `wasAlreadyComplete` is the point's `complete` value from just before the
 * assignment; only a genuine false→true transition counts (a re-click on an
 * already-green node is a no-op here).
 *
 * Shows at most one hint per call, each at most once per session:
 * `node-confirmed-color` on the first-ever red→green transition, then
 * `mark-occluded-invisible` on the NEXT one (any instance/node) — placement
 * methods always fill every node with a real (if scrambled) position, so
 * there's no reliable "still needs placing" signal to hang this off of
 * instead; the second node a user ever confirms is the earliest point in a
 * real session where nudging toward "right-click it instead if it's
 * occluded" is both relevant and not competing with the red/green
 * explanation for the same toast.
 */
export function hintIfFirstNodeConfirm(wasAlreadyComplete: boolean): void {
  if (wasAlreadyComplete) return;
  if (!nodeConfirmedColorShownThisSession) {
    showLabelingHint("node-confirmed-color");
    nodeConfirmedColorShownThisSession = true;
    return;
  }
  if (!markOccludedInvisibleShownThisSession) {
    showLabelingHint("mark-occluded-invisible");
    markOccludedInvisibleShownThisSession = true;
  }
}

// Same session-scoped reasoning as above — fires on the FIRST prediction ->
// user conversion of the session (double-click, or an "Accept All" bulk
// command), not on every conversion.
let predictionConversionLifecycleShownThisSession = false;

/**
 * Call right after converting a predicted instance into a user instance
 * (`ConvertPredictionToInstance`, or either "Accept All Predictions" bulk
 * command) to explain the full yellow -> red -> green color lifecycle the
 * FIRST time a user ever performs a conversion in this session — a
 * converted prediction already has model-placed points, so it's easy to
 * assume it's "done" without realizing it starts back at red (unconfirmed)
 * same as a from-scratch node. Returns whether it fired, so callers can
 * skip a lower-priority hint at the same moment (mirrors
 * `hintIfFirstInstance`'s return-value convention).
 */
export function hintIfFirstPredictionConversion(): boolean {
  if (predictionConversionLifecycleShownThisSession) return false;
  showLabelingHint("prediction-conversion-lifecycle");
  predictionConversionLifecycleShownThisSession = true;
  return true;
}

/**
 * Call right after creating or converting an instance to nudge on the FIRST
 * ever user instance in a project (`labels` already includes the just-
 * created/converted one at call time) — teaching how to label a SECOND
 * animal in the same frame, since a first-timer who just figured out how to
 * create one instance may not yet know Add Instance can be invoked again, or
 * that Ctrl/Cmd-drag clones one. Counts user instances only — a project can
 * start out full of predictions with zero user labels, so predictions don't
 * count toward "first".
 *
 * Returns whether it actually fired (only ever true on that first-ever
 * instance) so callers can skip a second, frame-based hint at the same
 * moment — see the caller in `commands/editCommands.ts` `AddInstance`: that
 * milestone is exactly the case where a node is about to be dragged and turn
 * green for the first time too, and stacking a third simultaneous toast
 * (`node-confirmed-color`, from `hintIfFirstNodeConfirm`) on top of two
 * instance-creation ones buries the one explaining what red/green even mean.
 */
export function hintIfFirstInstance(labels: Labels | null): boolean {
  if (!labels) return false;
  const totalUserInstances = labels.labeledFrames.reduce(
    (sum, lf) =>
      sum + lf.instances.filter((inst) => !(inst instanceof PredictedInstance)).length,
    0
  );
  if (totalUserInstances === 1) {
    showLabelingHint("add-another-instance");
    return true;
  }
  return false;
}

/**
 * Call right after deselecting `deselectedInstance` (the instance that WAS
 * selected, immediately before calling `setInstance`) to nudge the user
 * toward converting any predictions still left on `frame` (the frame the
 * deselected instance belonged to). Only fires when the deselected instance
 * was itself a user label created from a prediction (`fromPredicted` set) —
 * a purely from-scratch label leaving predictions behind isn't the pitfall
 * this hint is about.
 */
export function hintIfPredictionsRemain(
  deselectedInstance: Instance | null,
  frame: LabeledFrame | null,
): void {
  if (!deselectedInstance || deselectedInstance instanceof PredictedInstance) return;
  if (!deselectedInstance.fromPredicted) return;
  if (!frame) return;
  const stillHasPredictions = frame.instances.some(
    (inst) => inst instanceof PredictedInstance
  );
  if (stillHasPredictions) showLabelingHint("convert-remaining-predictions");
}
