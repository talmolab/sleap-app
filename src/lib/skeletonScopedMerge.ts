/**
 * Merging one model's predictions into a project with several skeletons
 * (talmolab/sleap-app#99). The predictions belong to ONE project skeleton —
 * the one whose node names equal the model's — and the "Existing predictions"
 * mode only touches that skeleton's predictions: re-running the mouse model
 * with "replace" must not wipe the pellet predictions on the same frames.
 *
 * Used by `MergePredictions` (editCommands.ts) whenever the project holds
 * several structurally different skeleton objects — even one nothing uses
 * yet: a plain io merge there could wipe another skeleton's predictions.
 * Projects with one skeleton (or identical duplicates) keep the plain merge.
 */

import {
  PredictedInstance,
  SkeletonMatcher,
  type LabeledFrame,
  type Labels,
  type MergeResult,
  type Skeleton,
  type Video,
  type VideoMatcher,
} from "@talmolab/sleap-io.js";
import { frameHasContent } from "@/lib/frameLabeling";
import { matchModelSkeleton, sameNodeNames, skeletonsInUse } from "@/lib/multiSkeletonInference";
import { sameSkeletonStructure, structuralGroups } from "@/lib/skeletonStructure";

type ExistingMode = "clear_all" | "replace" | "keep";

/** Non-instance annotation lists a frame carries (io's ANNOTATION_ATTRS). */
const ANNOTATION_ATTRS = ["centroids", "bboxes", "masks", "labelImages", "rois"] as const;
type AnnotationAttr = (typeof ANNOTATION_ATTRS)[number];

function predictedItems(lf: LabeledFrame, attr: AnnotationAttr): { isPredicted?: boolean }[] {
  const list = (lf as unknown as Record<string, unknown>)[attr];
  return Array.isArray(list) ? (list as { isPredicted?: boolean }[]).filter((a) => a?.isPredicted) : [];
}

function dropPredicted(lf: LabeledFrame, attr: AnnotationAttr): void {
  const rec = lf as unknown as Record<string, unknown>;
  const list = rec[attr];
  if (Array.isArray(list)) rec[attr] = list.filter((a: { isPredicted?: boolean }) => !a?.isPredicted);
}

/** Maps every predictions skeleton onto `target` when their node names agree. */
class NodeNameSkeletonMatcher extends SkeletonMatcher {
  constructor(private readonly target: Skeleton) {
    super("structure");
  }
  override match(selfSkeleton: Skeleton, otherSkeleton: Skeleton): boolean {
    return selfSkeleton === this.target && sameNodeNames(selfSkeleton.nodeNames, otherSkeleton.nodeNames);
  }
}

/**
 * Rename `predictions`' tracks whose names another skeleton's instances use
 * in `project`, so merging by track name never puts a mouse and a pellet on
 * one track. See {@link mergePredictionsForSkeleton}.
 */
function separateTracks(project: Labels, predictions: Labels, target: Skeleton): void {
  const otherNames = new Set<string>();
  for (const lf of project.labeledFrames) {
    for (const inst of lf.instances) {
      if (inst.track && !sameSkeletonStructure(inst.skeleton, target)) otherNames.add(inst.track.name);
    }
  }
  if (otherNames.size === 0) return;
  const prefix = (target.name?.trim() || "skeleton").replace(/\s+/g, "_");
  const renamed = new Set<object>();
  for (const lf of predictions.labeledFrames) {
    for (const inst of lf.instances) {
      const track = inst.track;
      if (!track || renamed.has(track) || !otherNames.has(track.name)) continue;
      let name = `${prefix}_${track.name}`;
      for (let n = 2; otherNames.has(name); n++) name = `${prefix}_${track.name}_${n}`;
      renamed.add(track);
      track.name = name;
    }
  }
}

/** Skeletons the predictions' instances actually use. */
function usedSkeletons(predictions: Labels): Skeleton[] {
  const used = new Set<Skeleton>();
  for (const lf of predictions.labeledFrames) for (const inst of lf.instances) used.add(inst.skeleton);
  return [...used];
}

/**
 * True when `project` holds several structurally different skeleton objects
 * (used or not) — then predictions are only ever merged under ONE skeleton
 * ({@link mergePredictionsForSkeleton}), never with the plain io merge.
 */
export function needsSkeletonScopedMerge(project: Pick<Labels, "skeletons">): boolean {
  return project.skeletons.length > 1 && structuralGroups(project.skeletons).length > 1;
}

/**
 * The project skeleton `predictions` belong to: the one whose node names
 * every skeleton the predictions use shares (ties go to the skeleton in use —
 * see `matchModelSkeleton`). Null when the project needs no scoped merge, the
 * predictions hold no instances, or no single skeleton matches.
 */
export function resolvePredictionsSkeleton(
  project: Labels,
  predictions: Labels,
  active?: Skeleton | null,
): Skeleton | null {
  if (!needsSkeletonScopedMerge(project)) return null;
  const used = usedSkeletons(predictions);
  if (used.length === 0) return null;
  const inUse = skeletonsInUse(project, active);
  let target: Skeleton | null = null;
  for (const sk of used) {
    const match = matchModelSkeleton(sk.nodeNames, project.skeletons, inUse);
    if (!match.ok) return null;
    if (target && target !== match.skeleton) return null;
    target = match.skeleton;
  }
  return target;
}

/** Why `predictions` can't be merged under `target`, or null when they can. */
export function predictionsSkeletonProblem(predictions: Labels, target: Skeleton): string | null {
  for (const sk of usedSkeletons(predictions)) {
    if (!sameNodeNames(sk.nodeNames, target.nodeNames)) {
      return `The predictions' skeleton (${sk.nodeNames.join(", ")}) doesn't match "${target.name ?? "the target skeleton"}".`;
    }
  }
  return null;
}

/**
 * Merge `predictions` into `project` under `target` only:
 *  - every predicted instance is attached to `target` (points remapped by name);
 *  - `replace` drops `target`'s old predictions on the frames the run covered;
 *    `clear_all` drops `target`'s old predictions everywhere; `keep` appends.
 *    Other skeletons' predictions and every user instance stay.
 *  - predicted boxes/centroids/masks are replaced only where the run produced
 *    that kind of annotation.
 *  - tracks stay per skeleton: sleap-nn names tracks `track_0…` in every run,
 *    so a new track whose name a DIFFERENT skeleton's instance already uses is
 *    renamed `<skeleton>_<name>` (e.g. `pellet_track_0`) before merging by
 *    name. Names only this skeleton uses (or nobody) still match by name, so
 *    re-runs and ID models' class tracks keep their tracks.
 * Throws (before changing anything) when a predictions skeleton's node
 * names differ from `target`'s — see {@link predictionsSkeletonProblem}.
 */
export async function mergePredictionsForSkeleton(
  project: Labels,
  predictions: Labels,
  target: Skeleton,
  mode: ExistingMode,
  /** How prediction videos map to project videos (see predictionVideoMatcher). */
  video: VideoMatcher | "basename" = "basename",
): Promise<MergeResult> {
  const problem = predictionsSkeletonProblem(predictions, target);
  if (problem) throw new Error(problem);
  const isTargetPrediction = (inst: unknown): boolean =>
    inst instanceof PredictedInstance && sameSkeletonStructure(inst.skeleton, target);

  // Which project frames the run covered (same video matching the merge
  // itself uses), and which annotation kinds it produced.
  const match = await project.match(predictions, { video, track: "name" });
  const covered = new Map<Video, Set<number>>();
  const producedAttrs = new Set<AnnotationAttr>();
  const producedAttrsByFrame = new Map<string, Set<AnnotationAttr>>();
  for (const lf of predictions.labeledFrames) {
    const video = match.videoMap.get(lf.video) ?? null;
    const attrs = new Set(ANNOTATION_ATTRS.filter((a) => predictedItems(lf, a).length > 0));
    for (const a of attrs) producedAttrs.add(a);
    if (!video) continue;
    let frames = covered.get(video);
    if (!frames) covered.set(video, (frames = new Set()));
    frames.add(lf.frameIdx);
    producedAttrsByFrame.set(`${project.videos.indexOf(video)}:${lf.frameIdx}`, attrs);
  }

  if (mode !== "keep") {
    for (const lf of project.labeledFrames) {
      const onCovered = covered.get(lf.video)?.has(lf.frameIdx) ?? false;
      if (mode === "replace" && !onCovered) continue;
      lf.instances = lf.instances.filter((inst) => !isTargetPrediction(inst));
      const attrs =
        mode === "clear_all"
          ? producedAttrs
          : (producedAttrsByFrame.get(`${project.videos.indexOf(lf.video)}:${lf.frameIdx}`) ?? new Set());
      for (const a of attrs) dropPredicted(lf, a);
    }
    project.labeledFrames = project.labeledFrames.filter(frameHasContent);
  }

  separateTracks(project, predictions, target);

  return project.merge(predictions, {
    skeleton: new NodeNameSkeletonMatcher(target),
    track: "name",
    video,
    frame: "keep_both",
  });
}
