/**
 * Phase-2 sweep actions that span the store and the command system, shared by
 * the keyboard shortcut and the sweep UI buttons so they behave identically
 * everywhere.
 *
 * Two different "this one is no good" verdicts live here, and they are NOT
 * interchangeable:
 *
 *  - REJECT — a FALSE POSITIVE from the locator: the model claimed an animal
 *    where there isn't one, so there is nothing to label. It deletes the
 *    offending detection rather than flagging it, because the data model has no
 *    per-centroid "rejected" state (`isNegative` is frame-level, which would
 *    wrongly suppress the real animals sharing that frame). One consequence
 *    worth knowing: the centroid pipeline merges with `replace_predictions`, so
 *    re-running the locator re-predicts from scratch and a rejected detection
 *    can come back.
 *
 *  - SKIP — the detection is RIGHT but the animal isn't labelable (occluded,
 *    tangled, half out of frame). The centroid stays, so the locator keeps its
 *    true positive; only the keypoint work is written off. See
 *    {@link markInstanceDecided} for how that is recorded.
 */

import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useActiveLearningStore } from "@/stores/activeLearningStore";
import { commandContext, BeginEdit, DeleteCentroid, DeleteSelectedInstance } from "@/commands";
import { toast } from "@/lib/notify";
import {
  buildWorkList,
  markInstanceDecided,
  passDims,
  nodeIndicesForPass,
  resolveItemInstance,
  type PassItem,
} from "./passEngine";

/** Is the store currently framed on this work item's video + frame? */
function onItemFrame(item: PassItem): boolean {
  const s = useAppStore.getState();
  return (
    !!s.labels &&
    s.frameIdx === item.frameIdx &&
    s.labels.videos[item.videoIdx] === s.video
  );
}

/** Does this instance have any point the user actually placed? */
function hasPlacedPoints(inst: { points: { visible: boolean; complete: boolean }[] }): boolean {
  for (let i = 0; i < inst.points.length; i++) {
    const p = inst.points[i];
    if (p.complete || p.visible) return true;
  }
  return false;
}

/**
 * Skip the WHOLE instance under the sweep cursor: write off every keypoint on
 * this animal and move to the next one still needing work.
 *
 * For the pose that just isn't worth labeling — badly occluded, tangled with a
 * neighbour, half out of frame. `s` only skips the current NODE and leaves it
 * undecided, so a resume walks straight back into the same bad animal, node by
 * node, for every pass; this decides all of them at once.
 *
 * The centroid is left alone on purpose (that's the difference from
 * {@link rejectCurrentPassItem}) — the locator was right that there's an animal
 * there, and deleting the annotation would teach it otherwise. Recorded via
 * {@link markInstanceDecided}, so it holds across a resume AND a save/reload,
 * and `⌘Z` puts it back.
 *
 * Like reject, this snaps to the item's frame and re-verifies it landed before
 * mutating: `setFrameIdx` clamps to the video's frame count, so on a deferred
 * video whose count is still a stand-in the target frame can clamp elsewhere and
 * we would write the skip onto the wrong frame's instance.
 *
 * The work list is NOT rebuilt — nothing is added or removed, so every index
 * stays valid (unlike reject, which splices).
 *
 * @returns true if the instance was skipped.
 */
export function skipCurrentPassItem(): boolean {
  const s0 = useAppStore.getState();
  if (s0.labelingMode !== "keypointPass") return false;

  const cursor = s0.passCursor;
  if (!cursor || !s0.labels) return false;
  const item = s0.passWorkList[cursor.itemIdx];
  if (!item) return false;

  if (!onItemFrame(item)) {
    s0.syncPassSelection();
    if (!onItemFrame(item)) {
      toast.error("Couldn't navigate to that frame — nothing was skipped.");
      return false;
    }
  }

  const s = useAppStore.getState();
  if (!s.labels) return false;
  const inst = resolveItemInstance(s.labels, item);
  if (!inst) {
    toast.error("Couldn't resolve that instance — nothing was skipped.");
    return false;
  }

  commandContext.execute(BeginEdit);
  markInstanceDecided(inst);
  s.markChanged();
  s.touchFrame();
  s.bumpOverlayVersion();

  // Forward from here, not from the start: an earlier node the labeler chose to
  // leave with `s` is still undecided, and snapping back to it would undo the
  // whole point of moving on.
  const more = useAppStore.getState().passJumpToUnlabeled({ from: "cursor" });
  if (!more) toast.success("Skipped — nothing left to label.");
  return true;
}

/**
 * Reject the locator detection under the sweep cursor as a false positive, then
 * continue at the next thing still needing a decision.
 *
 * Only PREDICTED items can be rejected — a human's own seed is deleted
 * deliberately from the Instances panel, not "rejected" here.
 *
 * Like the Phase-3 accept, this snaps back to the item's frame and RE-VERIFIES
 * it landed before deleting anything: `setFrameIdx` clamps to the video's frame
 * count, so on a deferred video whose count is still a stand-in the target frame
 * can clamp elsewhere and we would delete on the wrong frame. If it can't land,
 * it bails without deleting.
 *
 * After the delete the work list is REBUILT rather than patched: every later
 * `instanceIdx` on that frame shifts by one when an instance is spliced out, so
 * a surviving list would point at the wrong instances.
 *
 * @param options.includePredicted - the sweep's current include-predictions
 *   setting, so the rebuilt list matches the one the user started with.
 * @returns true if a detection was rejected.
 */
export function rejectCurrentPassItem(options: { includePredicted?: boolean } = {}): boolean {
  const s0 = useAppStore.getState();
  if (s0.labelingMode !== "keypointPass") return false;

  const cursor = s0.passCursor;
  const config = useActiveLearningStore.getState().config;
  if (!cursor || !s0.labels || !config || !s0.skeleton) return false;

  const item = s0.passWorkList[cursor.itemIdx];
  if (!item) return false;
  if (!item.predicted) {
    toast.info("Only locator predictions can be rejected — this one you seeded yourself.");
    return false;
  }

  if (!onItemFrame(item)) {
    s0.syncPassSelection();
    if (!onItemFrame(item)) {
      toast.error("Couldn't navigate to that frame — nothing was deleted.");
      return false;
    }
  }

  const s = useAppStore.getState();
  if (!s.labels) return false;
  const inst = resolveItemInstance(s.labels, item);

  if (item.centroidIdx !== null) {
    // Separate-annotation mode: the detection IS the centroid. Drop the paired
    // pose instance too when it is still empty (nothing to preserve); if the
    // user already placed points on it, keep their work and remove only the
    // centroid.
    commandContext.execute(DeleteCentroid, { centroidIdx: item.centroidIdx });
    if (inst && !hasPlacedPoints(inst)) {
      useAppStore.getState().setInstance(inst);
      commandContext.execute(DeleteSelectedInstance);
    }
  } else {
    // Anchor-node mode: the detection is a single-node PredictedInstance.
    if (!(inst instanceof PredictedInstance)) {
      toast.info("That item is already a user label — nothing to reject.");
      return false;
    }
    useAppStore.getState().setInstance(inst);
    commandContext.execute(DeleteSelectedInstance);
  }

  // Rebuild: indices shifted underneath the old list.
  const after = useAppStore.getState();
  if (!after.labels || !after.skeleton) return true;
  const names = after.skeleton.nodes.map((n) => n.name);
  const workList = buildWorkList(after.labels, config, {
    includePredicted: options.includePredicted ?? true,
  });
  if (workList.length === 0) {
    after.exitKeypointPassMode();
    toast.success("Rejected — nothing left to label.");
    return true;
  }
  const dims = passDims(config, workList, names);
  const nodeIndices = config.labelKeypoints.passes.map((p) => nodeIndicesForPass(p, names));
  after.enterKeypointPassMode({
    workList,
    dims,
    nodeIndices,
    zoomWindow: after.passZoomWindow,
  });
  useAppStore.getState().passJumpToUnlabeled();
  return true;
}
