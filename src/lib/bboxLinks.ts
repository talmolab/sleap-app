/**
 * Keep bounding boxes' `instance` and `track` references valid when commands
 * remove, replace or retrack instances, or delete tracks.
 *
 * A box links to a pose instance (`box.instance`) and may carry a track. The
 * link is saved as an index into the frame's instances, so a link to an
 * instance that is no longer on the frame is written as -1: the pose and its
 * box are no longer paired. sleap-nn's `topdown_bbox` pipeline then crops that
 * instance from its keypoints instead of from its box.
 */
import { PredictedInstance, type Labels, type LabeledFrame, type Track } from "@talmolab/sleap-io.js";

/**
 * Fix links on `lf` after instances were removed or replaced. A box linked to
 * an instance that is gone moves to the user instance made from it
 * (`fromPredicted`), for example after a prediction is converted, and
 * otherwise loses its link. Returns how many boxes changed.
 */
export function repairBboxLinks(lf: LabeledFrame): number {
  if (lf.bboxes.length === 0) return 0;
  const present = new Set(lf.instances);
  let changed = 0;
  for (const box of lf.bboxes) {
    const linked = box.instance;
    if (!linked || present.has(linked)) continue;
    box.instance =
      lf.instances.find(
        (inst) => !(inst instanceof PredictedInstance) && inst.fromPredicted === linked,
      ) ?? null;
    changed++;
  }
  return changed;
}

/** {@link repairBboxLinks} on every frame of the project. */
export function repairAllBboxLinks(labels: Labels): number {
  let changed = 0;
  for (const lf of labels.labeledFrames) changed += repairBboxLinks(lf);
  return changed;
}

/** Boxes on `lf` that are linked to an instance take that instance's track. */
export function syncLinkedBboxTracks(lf: LabeledFrame): void {
  for (const box of lf.bboxes) {
    if (box.instance) box.track = box.instance.track ?? null;
  }
}

/** Clear `box.track` wherever it is one of `tracks` (every track when `null`). */
export function clearBboxTracks(labels: Labels, tracks: Set<Track> | null): void {
  for (const lf of labels.labeledFrames) {
    for (const box of lf.bboxes) {
      if (box.track && (tracks === null || tracks.has(box.track))) box.track = null;
    }
  }
}

/** Tracks that at least one box is on. */
export function tracksUsedByBboxes(labels: Labels): Set<Track> {
  const used = new Set<Track>();
  for (const lf of labels.labeledFrames) {
    for (const box of lf.bboxes) if (box.track) used.add(box.track);
  }
  return used;
}
