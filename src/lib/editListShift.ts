/**
 * Labels made on a video whose MP4/MOV edit list hides leading frames
 * (sleap-io.js #274) — detection, per-video answers, and the −N frame shift.
 *
 * A clip cut with stream copy (`ffmpeg -ss 1 -i in.mp4 -c copy out.mp4`) keeps a
 * few frames before the cut (decode references) that ffmpeg and SLEAP (Python)
 * never show or count. sleap-io.js ≤ 0.5.17 counted them, so labels made in
 * earlier versions of this app sit `N` frames too late once frames are
 * numbered like ffmpeg (`N` = the backend's `hiddenLeadingFrames`, sleap-io.js
 * ≥ {@link FFMPEG_FRAME_INDEX_IO_VERSION}).
 *
 * Which numbering made what, and so what the shift moves:
 * - **User instances** (drawn here, or a prediction accepted here — accepting
 *   replaces the prediction, and the orphaned link is dropped on save) and
 *   user boxes/centroids/masks/label images/ROIs, negative-frame marks and
 *   suggestions were numbered by the old app → move `N` earlier.
 * - **Predictions** come from SLEAP / sleap-nn in Python → already right, stay.
 * - **A user instance linked to a prediction on the same frame** can't have
 *   come from the old app (see above), so it was made in SLEAP (Python) → it
 *   stays with its prediction, and the link never crosses frames.
 * - Annotations linked to an instance follow that instance.
 *
 * Each video's answer is recorded in `labels.provenance` (which round-trips
 * through the `.slp`, Python sleap-io included), so an answered video is
 * never offered again — not even when another video is still unanswered.
 */

import { LabeledFrame, PredictedInstance, SuggestionFrame } from "@talmolab/sleap-io.js";
import type { VideoBackend } from "@talmolab/sleap-io.js";
import type { Instance, Labels, Video } from "../types";

/** sleap-io.js release that numbers frames like ffmpeg (talmolab/sleap-io.js#290). */
export const FFMPEG_FRAME_INDEX_IO_VERSION = "0.5.18";

/** Provenance key holding the per-video records: `{ [video filename]: VideoFrameIndexState }`. */
export const FRAME_INDEX_PROVENANCE_KEY = "sleap_app_frame_index";

/**
 * A video's recorded state:
 * - `"ffmpeg"`: everything on it was numbered like ffmpeg (no old labels when
 *   checked, or added with an io that numbers like ffmpeg);
 * - `"shifted"`: old labels were shifted;
 * - `"kept"`: the user chose to keep its labels as they were.
 * Any record means "never ask again about this video".
 */
export type VideoFrameIndexState = "ffmpeg" | "shifted" | "kept";

/** Containers that can carry an edit list. */
const EDIT_LIST_EXTENSIONS = new Set(["mp4", "mov", "m4v"]);

function videoPath(video: Video): string {
  return Array.isArray(video.filename) ? (video.filename[0] ?? "") : video.filename;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The video's file name (for messages). */
export function videoName(video: Video): string {
  return basename(videoPath(video)) || "this video";
}

/** True if the video file is an MP4/MOV-family container (can have an edit list). */
export function canHaveEditList(video: Video): boolean {
  const ext = videoPath(video).split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return EDIT_LIST_EXTENSIONS.has(ext);
}

/**
 * True if this backend reports hidden frames at all, i.e. it comes from
 * sleap-io.js ≥ {@link FFMPEG_FRAME_INDEX_IO_VERSION}. Older io numbers frames
 * the old way and can't tell, so nothing may be recorded or offered for it.
 */
export function supportsHiddenFrameDetection(backend: VideoBackend | null | undefined): boolean {
  return backend != null && "hiddenLeadingFrames" in backend;
}

/** Frames the backend says its edit list hides (0 if none or unknown). */
export function hiddenLeadingFramesOfBackend(backend: VideoBackend | null | undefined): number {
  const n = (backend as { hiddenLeadingFrames?: number } | null | undefined)?.hiddenLeadingFrames ?? 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Frames the video's open backend says its edit list hides (0 if none or unknown). */
export function hiddenLeadingFramesOf(video: Video): number {
  return hiddenLeadingFramesOfBackend(video.backend);
}

// ---------------------------------------------------------------------------
// Per-video records (labels.provenance)
// ---------------------------------------------------------------------------

function recordMap(labels: Labels): Record<string, VideoFrameIndexState> | null {
  const raw = labels.provenance?.[FRAME_INDEX_PROVENANCE_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, VideoFrameIndexState>)
    : null;
}

/**
 * The recorded state for `video`, or null. Matched by its file name, then by
 * the name it had in the file before being located elsewhere, then by base
 * name when that is unambiguous (the file was moved and re-saved).
 */
export function getVideoRecord(labels: Labels, video: Video): VideoFrameIndexState | null {
  const map = recordMap(labels);
  if (!map) return null;
  const meta = video.backendMetadata as Record<string, unknown> | undefined;
  for (const key of [videoPath(video), meta?.sourceFilename]) {
    if (typeof key === "string" && key in map) return map[key];
  }
  const base = videoName(video);
  const sameBaseVideos = labels.videos.filter((v) => videoName(v) === base);
  const sameBaseKeys = Object.keys(map).filter((k) => basename(k) === base);
  return sameBaseVideos.length === 1 && sameBaseKeys.length === 1 ? map[sameBaseKeys[0]] : null;
}

/** Record `video`'s state (saved with the project). */
export function setVideoRecord(labels: Labels, video: Video, state: VideoFrameIndexState): void {
  if (!labels.provenance) labels.provenance = {};
  const map = { ...(recordMap(labels) ?? {}) };
  map[videoPath(video)] = state;
  labels.provenance[FRAME_INDEX_PROVENANCE_KEY] = map;
}

// ---------------------------------------------------------------------------
// The shift
// ---------------------------------------------------------------------------

type FrameContents = Pick<
  LabeledFrame,
  "instances" | "centroids" | "bboxes" | "masks" | "labelImages" | "rois"
>;

/** A user instance linked to a prediction on the same frame (made in SLEAP/Python). */
function isLinkedToFramePrediction(inst: Instance, lf: LabeledFrame): boolean {
  if (inst instanceof PredictedInstance) return false;
  const from = inst.fromPredicted;
  return from != null && lf.instances.includes(from);
}

/** Split one frame into what the shift moves and what stays (see the module doc). */
function splitFrame(lf: LabeledFrame): {
  move: FrameContents;
  stay: FrameContents;
  linkedKept: number;
} {
  const stays = (inst: Instance) =>
    inst instanceof PredictedInstance || isLinkedToFramePrediction(inst, lf);
  const stayInstances = new Set(lf.instances.filter(stays));
  // An annotation linked to an instance follows it; otherwise predicted ones stay.
  const annotationStays = (a: object) => {
    const linked = (a as { instance?: Instance | null }).instance;
    if (linked && lf.instances.includes(linked)) return stayInstances.has(linked);
    return Boolean((a as { isPredicted?: boolean }).isPredicted);
  };
  const part = (stay: boolean): FrameContents => {
    const pick = <T extends object>(items: T[] | undefined) =>
      (items ?? []).filter((a) => annotationStays(a) === stay);
    return {
      instances: lf.instances.filter((inst) => stayInstances.has(inst) === stay),
      centroids: pick(lf.centroids),
      bboxes: pick(lf.bboxes),
      masks: pick(lf.masks),
      labelImages: pick(lf.labelImages),
      rois: pick(lf.rois),
    };
  };
  const linkedKept = lf.instances.filter(
    (inst) => !(inst instanceof PredictedInstance) && stayInstances.has(inst)
  ).length;
  return { move: part(false), stay: part(true), linkedKept };
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
  /** User instances that stay with the prediction they're linked to. */
  linkedInstancesKept: number;
}

/** Count what {@link applyLabelShift} would move, without changing anything. */
export function planLabelShift(labels: Labels, video: Video, by: number): LabelShiftPlan {
  const plan: LabelShiftPlan = {
    movedFrames: 0,
    droppedFrames: 0,
    movedSuggestions: 0,
    droppedSuggestions: 0,
    framesWithPredictionsKept: 0,
    linkedInstancesKept: 0,
  };
  if (by <= 0) return plan;
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) continue;
    const { move, stay, linkedKept } = splitFrame(lf);
    if (stay.instances.some((i) => i instanceof PredictedInstance)) plan.framesWithPredictionsKept += 1;
    plan.linkedInstancesKept += linkedKept;
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

/** True if a plan has anything to move or remove. */
export function planHasChanges(plan: LabelShiftPlan): boolean {
  return (
    plan.movedFrames + plan.droppedFrames + plan.movedSuggestions + plan.droppedSuggestions > 0
  );
}

/**
 * True if `video` has anything a shift would move or remove: user-made frame
 * content, a negative mark, or a suggestion.
 */
export function hasShiftableContent(labels: Labels, video: Video): boolean {
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) continue;
    if (lf.isNegative || !isEmpty(splitFrame(lf).move)) return true;
  }
  return labels.suggestions.some((s) => s.video === video);
}

/**
 * Move `video`'s old-numbered labels (see the module doc) `by` frames earlier.
 * Content that would land before frame 0 (it was made on a frame ffmpeg never
 * shows) is removed. Frames left empty are dropped; moved content joins
 * whatever already stays on its new frame. Only this video changes. Mutates
 * `labels` and returns what happened; the caller owns undo and the record.
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
