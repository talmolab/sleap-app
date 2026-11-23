/**
 * Labels ▸ Custom Instance Delete... — port of PyQt SLEAP's `DeleteDialog`
 * (`sleap/gui/dialogs/delete.py`, menu item at `app.py:911`).
 *
 * The dialog reads as a sentence: "Delete [instance type] in [frames] with
 * [track]". The option lists and their wording are PyQt's, verbatim, and so
 * are the rules for when an option appears:
 *   - "all videos" only when the project has more than one video;
 *   - the two clip options only when a frame range is selected on the seekbar;
 *   - the "with" row only when the project has tracks.
 *
 * One deliberate difference: PyQt's "current video except for selected clip"
 * code also deletes in every OTHER video (`lf.video != video or ...`), which
 * contradicts its own label. Here it means what it says: this video only.
 */

import {
  PredictedInstance,
  type Instance,
  type LabeledFrame,
  type Labels,
  type Track,
  type Video,
} from "@talmolab/sleap-io.js";

export const INSTANCE_TYPE_OPTIONS = [
  "predicted instances",
  "user instances",
  "all instances",
] as const;
export type InstanceTypeOption = (typeof INSTANCE_TYPE_OPTIONS)[number];

export type FramesOption =
  | "current frame"
  | "current video"
  | "all videos"
  | "selected clip"
  | "current video except for selected clip";

/** PyQt's "in" menu for this project / selection. */
export function framesOptions(
  videoCount: number,
  hasFrameRange: boolean
): FramesOption[] {
  const out: FramesOption[] = ["current frame", "current video"];
  if (videoCount > 1) out.push("all videos");
  if (hasFrameRange) {
    out.push("selected clip", "current video except for selected clip");
  }
  return out;
}

export const TRACK_ANY = "any track identity (including none)";
export const TRACK_NONE = "no track identity set";

/** PyQt's "with" menu: the two fixed choices, then every track by name. */
export function trackOptions(tracks: readonly Track[]): string[] {
  if (tracks.length === 0) return [];
  return [TRACK_ANY, TRACK_NONE, ...tracks.map((t) => t.name)];
}

/** What the dialog picked. `track` is a Track, or "any"/"none". */
export interface CustomDeleteChoice {
  instanceType: InstanceTypeOption;
  frames: FramesOption;
  track: Track | "any" | "none";
}

/** Where the user is: the current video/frame and the seekbar selection. */
export interface CustomDeleteScope {
  video: Video | null;
  frameIdx: number;
  /** Inclusive [start, end] seekbar selection, or null. */
  frameRange: [number, number] | null;
}

/** PyQt's `inst_condition`. */
function matches(inst: Instance, choice: CustomDeleteChoice): boolean {
  const predicted = inst instanceof PredictedInstance;
  if (choice.instanceType === "predicted instances" && !predicted) return false;
  if (choice.instanceType === "user instances" && predicted) return false;
  if (choice.track === "none") return inst.track == null;
  if (choice.track !== "any") return inst.track === choice.track;
  return true;
}

/** The labeled frames PyQt's "in" choice covers. */
function framesFor(
  labels: Labels,
  scope: CustomDeleteScope,
  frames: FramesOption
): LabeledFrame[] {
  const { video, frameIdx, frameRange } = scope;
  const inClip = (lf: LabeledFrame) =>
    !!frameRange && lf.frameIdx >= frameRange[0] && lf.frameIdx <= frameRange[1];
  switch (frames) {
    case "current frame":
      return labels.labeledFrames.filter(
        (lf) => lf.video === video && lf.frameIdx === frameIdx
      );
    case "current video":
      return labels.labeledFrames.filter((lf) => lf.video === video);
    case "all videos":
      return labels.labeledFrames;
    case "selected clip":
      return labels.labeledFrames.filter((lf) => lf.video === video && inClip(lf));
    case "current video except for selected clip":
      return labels.labeledFrames.filter(
        (lf) => lf.video === video && !inClip(lf)
      );
  }
}

/** Every (frame, instance) the choice deletes — PyQt's `get_frames_instances`. */
export function customDeleteTargets(
  labels: Labels,
  scope: CustomDeleteScope,
  choice: CustomDeleteChoice
): Array<[LabeledFrame, Instance]> {
  const out: Array<[LabeledFrame, Instance]> = [];
  for (const lf of framesFor(labels, scope, choice.frames)) {
    for (const inst of lf.instances) {
      if (matches(inst, choice)) out.push([lf, inst]);
    }
  }
  return out;
}

/** Is `track` still used by any instance or annotation in the project? */
export function trackInUse(labels: Labels, track: Track): boolean {
  for (const lf of labels.labeledFrames) {
    if (lf.instances.some((i) => i.track === track)) return true;
    const annotations = [
      ...lf.bboxes,
      ...lf.centroids,
      ...lf.masks,
      ...lf.labelImages,
      ...lf.rois,
    ] as Array<{ track?: Track | null }>;
    if (annotations.some((a) => a.track === track)) return true;
  }
  return false;
}
