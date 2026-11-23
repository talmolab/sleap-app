/**
 * Labels made on a video whose MP4/MOV edit list hides leading frames
 * (sleap-io.js #274) — detection and the −N frame shift.
 *
 * A clip cut with stream copy (`ffmpeg -ss 1 -i in.mp4 -c copy out.mp4`) keeps a
 * few frames before the cut (decode references) that ffmpeg and SLEAP (Python)
 * never show or count. sleap-io.js ≤ 0.5.17 counted them, so labels made in
 * earlier versions of this app sit `N` frames too late now that frames are
 * numbered like ffmpeg (`N` = the backend's `hiddenLeadingFrames`).
 *
 * The shift moves everything the USER made on that video back by `N`: user
 * instances, user boxes/centroids/masks/label images/ROIs, negative-frame
 * marks, and suggestions. Predictions stay put: they come from SLEAP / sleap-nn
 * in Python, which always numbered frames like ffmpeg.
 *
 * Projects saved by this version carry {@link FRAME_INDEX_MARKER} in their
 * provenance, so the question is asked only for files saved before the fix.
 */

import { LabeledFrame, PredictedInstance, SuggestionFrame } from "@talmolab/sleap-io.js";
import type { Labels, Video } from "../types";

/**
 * Provenance key + value meaning "this file's frame numbers follow ffmpeg" (i.e.
 * it was saved by a version of the app that skips edit-list-hidden frames).
 * Written into `labels.provenance`, which round-trips through the `.slp`.
 */
export const FRAME_INDEX_MARKER = { key: "sleap_app_frame_index", value: "ffmpeg" } as const;

/** sleap-io.js release that numbers frames like ffmpeg (sleap-io.js #290). */
export const FFMPEG_FRAME_INDEX_IO_VERSION = "0.5.18";

/** Containers that can carry an edit list. */
const EDIT_LIST_EXTENSIONS = new Set(["mp4", "mov", "m4v"]);

/** True if the video file is an MP4/MOV-family container (can have an edit list). */
export function canHaveEditList(video: Video): boolean {
  const name = Array.isArray(video.filename) ? "" : video.filename;
  const ext = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return EDIT_LIST_EXTENSIONS.has(ext);
}

/**
 * Frames the video's edit list hides (0 if none or unknown). Read through a
 * local optional type so this builds against sleap-io.js releases before the
 * field existed (they report nothing, so nothing is offered).
 */
export function hiddenLeadingFramesOf(video: Video): number {
  const backend = video.backend as { hiddenLeadingFrames?: number } | null;
  const n = backend?.hiddenLeadingFrames ?? 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** True if the project file says its frame numbers already follow ffmpeg. */
export function hasFrameIndexMarker(labels: Labels): boolean {
  return labels.provenance?.[FRAME_INDEX_MARKER.key] === FRAME_INDEX_MARKER.value;
}

/** Record that this project's frame numbers follow ffmpeg (saved with the project). */
export function stampFrameIndexMarker(labels: Labels): void {
  if (!labels.provenance) labels.provenance = {};
  labels.provenance[FRAME_INDEX_MARKER.key] = FRAME_INDEX_MARKER.value;
}

type Annotated = { isPredicted?: boolean };
type FrameContents = Pick<
  LabeledFrame,
  "instances" | "centroids" | "bboxes" | "masks" | "labelImages" | "rois"
>;

/** Split one frame's contents into what the shift moves (user-made) and what stays (predicted). */
function splitFrame(lf: LabeledFrame): { move: FrameContents; stay: FrameContents } {
  const pick = <T,>(items: T[] | undefined, predicted: boolean): T[] =>
    (items ?? []).filter((a) => Boolean((a as Annotated).isPredicted) === predicted);
  const part = (predicted: boolean): FrameContents => ({
    instances: lf.instances.filter((inst) => inst instanceof PredictedInstance === predicted),
    centroids: pick(lf.centroids, predicted),
    bboxes: pick(lf.bboxes, predicted),
    masks: pick(lf.masks, predicted),
    labelImages: pick(lf.labelImages, predicted),
    rois: pick(lf.rois, predicted),
  });
  return { move: part(false), stay: part(true) };
}

function isEmpty(c: FrameContents): boolean {
  return (
    c.instances.length === 0 &&
    c.centroids.length === 0 &&
    c.bboxes.length === 0 &&
    c.masks.length === 0 &&
    c.labelImages.length === 0 &&
    c.rois.length === 0
  );
}

/** What a shift of `video` by `by` frames would do. */
export interface LabelShiftPlan {
  /** Labeled frames whose user-made content (or negative mark) moves. */
  movedFrames: number;
  /** Labeled frames whose user-made content sits on a hidden frame and is removed. */
  droppedFrames: number;
  /** Suggestions that move. */
  movedSuggestions: number;
  /** Suggestions on hidden frames, removed. */
  droppedSuggestions: number;
  /** Labeled frames whose predictions stay where they are. */
  framesWithPredictionsKept: number;
}

/** Count what {@link applyLabelShift} would move, without changing anything. */
export function planLabelShift(labels: Labels, video: Video, by: number): LabelShiftPlan {
  const plan: LabelShiftPlan = {
    movedFrames: 0,
    droppedFrames: 0,
    movedSuggestions: 0,
    droppedSuggestions: 0,
    framesWithPredictionsKept: 0,
  };
  if (by <= 0) return plan;
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) continue;
    const { move, stay } = splitFrame(lf);
    if (!isEmpty(stay)) plan.framesWithPredictionsKept += 1;
    if (isEmpty(move) && !lf.isNegative) continue;
    if (lf.frameIdx - by >= 0) plan.movedFrames += 1;
    else plan.droppedFrames += 1;
  }
  for (const s of labels.suggestions) {
    if (s.video !== video) continue;
    if (s.frameIdx - by >= 0) plan.movedSuggestions += 1;
    else plan.droppedSuggestions += 1;
  }
  return plan;
}

/**
 * True if `video` has anything a shift would move or remove: user-made frame
 * content, a negative mark, or a suggestion (predictions never move).
 */
export function hasShiftableContent(labels: Labels, video: Video): boolean {
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) continue;
    if (lf.isNegative || !isEmpty(splitFrame(lf).move)) return true;
  }
  return labels.suggestions.some((s) => s.video === video);
}

/** True if a plan has anything to move or remove. */
export function planHasChanges(plan: LabelShiftPlan): boolean {
  return (
    plan.movedFrames + plan.droppedFrames + plan.movedSuggestions + plan.droppedSuggestions > 0
  );
}

/**
 * Move `video`'s user-made labels, negative marks and suggestions `by` frames
 * earlier; predictions stay. Content that would land before frame 0 (it was
 * made on a frame ffmpeg never shows) is removed. Frames left empty are
 * dropped; moved content joins any predictions already on its new frame. Only
 * this video changes. Mutates `labels` and returns what happened. The caller
 * owns undo (see `ShiftVideoLabelsCommand`).
 */
export function applyLabelShift(labels: Labels, video: Video, by: number): LabelShiftPlan {
  const plan = planLabelShift(labels, video, by);
  if (by <= 0 || !planHasChanges(plan)) return plan;

  // Build this video's frames anew: what stays keeps its index, what moves goes
  // to index − by. Stayed content first, then moved, for a stable order.
  const stays = new Map<number, FrameContents>();
  const moves = new Map<number, { contents: FrameContents; isNegative: boolean }>();
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) continue;
    const { move, stay } = splitFrame(lf);
    if (!isEmpty(stay)) stays.set(lf.frameIdx, stay);
    const target = lf.frameIdx - by;
    if (target >= 0 && (!isEmpty(move) || lf.isNegative)) {
      moves.set(target, { contents: move, isNegative: lf.isNegative });
    }
  }

  const indices = [...new Set([...stays.keys(), ...moves.keys()])].sort((a, b) => a - b);
  const newFrames = indices.map((frameIdx) => {
    const stay = stays.get(frameIdx);
    const moved = moves.get(frameIdx);
    const join = <K extends keyof FrameContents>(key: K) =>
      [...(stay?.[key] ?? []), ...(moved?.contents[key] ?? [])] as FrameContents[K];
    return new LabeledFrame({
      video,
      frameIdx,
      instances: join("instances"),
      isNegative: moved?.isNegative ?? false,
      centroids: join("centroids"),
      bboxes: join("bboxes"),
      masks: join("masks"),
      labelImages: join("labelImages"),
      rois: join("rois"),
    });
  });

  // Splice the new frames in where this video's frames first appeared, keeping
  // every other video's frames (and their order) untouched.
  const rebuilt: LabeledFrame[] = [];
  let inserted = false;
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) {
      rebuilt.push(lf);
    } else if (!inserted) {
      rebuilt.push(...newFrames);
      inserted = true;
    }
  }
  if (!inserted) rebuilt.push(...newFrames);
  labels.labeledFrames = rebuilt;

  // New SuggestionFrame objects (not in-place edits), so an undo snapshot that
  // holds the old array keeps the old frame numbers.
  labels.suggestions = labels.suggestions.flatMap((s) => {
    if (s.video !== video) return [s];
    const frameIdx = s.frameIdx - by;
    if (frameIdx < 0) return [];
    return [new SuggestionFrame({ video, frameIdx, group: s.group, metadata: { ...s.metadata } })];
  });

  labels.reindex();
  return plan;
}

/** A video the open-time check offers to shift. */
export interface EditListCandidate {
  video: Video;
  hidden: number;
  plan: LabelShiftPlan;
}

/**
 * Videos in `labels` whose backend reports hidden leading frames AND that have
 * user-made labels or suggestions to move. Only videos with an open backend can
 * be checked; `uncheckedVideos` counts MP4/MOV videos with something to move
 * that couldn't be (no backend, e.g. the file is missing).
 */
export function findEditListCandidates(labels: Labels): {
  candidates: EditListCandidate[];
  uncheckedVideos: number;
} {
  const candidates: EditListCandidate[] = [];
  let uncheckedVideos = 0;
  for (const video of labels.videos) {
    if (!canHaveEditList(video)) continue;
    if (!video.backend) {
      if (hasShiftableContent(labels, video)) uncheckedVideos += 1;
      continue;
    }
    const hidden = hiddenLeadingFramesOf(video);
    if (hidden === 0) continue;
    const plan = planLabelShift(labels, video, hidden);
    if (planHasChanges(plan)) candidates.push({ video, hidden, plan });
  }
  return { candidates, uncheckedVideos };
}
