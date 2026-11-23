/**
 * Compare model predictions: the pure part.
 *
 * The user picks prediction `.slp` files (one per model) and the app draws each
 * model's poses over the current video in its own colour, like Lightning Pose's
 * multi-model view. Nothing is written to the project (Accept, in a later PR, is
 * the one exception and goes through the command system).
 *
 * This module decides, for one loaded prediction file:
 * - which of its videos is the project's current video ({@link matchVideo}):
 *   same path first, else same file name with the same frame count and frame
 *   size;
 * - whether its skeleton has the project's node names ({@link checkSkeleton}):
 *   order and edges may differ, the set of names may not;
 * - the model's name ({@link modelNameFromProvenance}): the model folder(s) in
 *   the file's provenance, else the file name;
 * - the poses per frame ({@link extractPoses}), reordered to the project's node
 *   order so every model's node `i` is the same body part.
 *
 * Everything here is synchronous and takes plain data, so it is unit-tested
 * without a canvas or a file system.
 */

import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { Labels, Skeleton, Video } from "@/types";
import type { RGB } from "@/lib/colorPalettes";
import { PoseStoreBuilder, type PoseFrames, type PoseStore } from "./poseStore";

/** One model's pose on one frame, in the project's node order. */
export interface OverlayPose {
  /** `[x0, y0, x1, y1, …]` in source-frame pixels; NaN where the node is missing. */
  xy: Float64Array;
  /** Instance score, when the file has one. */
  score: number | null;
  /** Track name, when the instance has a track. */
  trackName: string | null;
}

/** What we know about the project video we compare against. */
export interface TargetVideo {
  /** `video.filename` (an image sequence's first image for an image video). */
  path: string;
  /** Frames in the video, when known. */
  frameCount: number | null;
  /** Frame height and width in pixels, when known. */
  height: number | null;
  width: number | null;
}

/** Colours for up to eight models; no red (red marks disagreement). */
export const MODEL_COLORS: RGB[] = [
  [0, 200, 255], // cyan
  [255, 70, 200], // magenta
  [140, 230, 40], // lime
  [255, 160, 0], // orange
  [165, 120, 255], // violet
  [255, 235, 60], // yellow
  [0, 190, 150], // teal
  [235, 235, 235], // white
];

/** The first colour no loaded model uses yet (cycles once all are taken). */
export function nextModelColor(used: readonly RGB[], count: number): RGB {
  const free = MODEL_COLORS.find((c) => !used.some((u) => u[0] === c[0] && u[1] === c[1] && u[2] === c[2]));
  return free ?? MODEL_COLORS[count % MODEL_COLORS.length];
}

/** Forward slashes, no trailing slash. Paths from Windows files use backslashes. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The last path segment (either separator). */
export function pathBaseName(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

/** A video's first filename (an image video stores a list). */
export function videoPath(video: Video): string {
  const f = video.filename;
  return Array.isArray(f) ? (f[0] ?? "") : f;
}

/** Frame count and size from a video's shape, or from its stored metadata. */
export function videoDims(video: Video): Pick<TargetVideo, "frameCount" | "height" | "width"> {
  let shape: unknown = null;
  try {
    shape = video.shape;
  } catch {
    shape = null;
  }
  if (!Array.isArray(shape)) {
    const meta = video.backendMetadata?.shape;
    shape = Array.isArray(meta) ? meta : null;
  }
  const s = shape as unknown[] | null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return {
    frameCount: s ? num(s[0]) : null,
    height: s ? num(s[1]) : null,
    width: s ? num(s[2]) : null,
  };
}

/** The {@link TargetVideo} for a project video. */
export function targetFromVideo(video: Video): TargetVideo {
  return { path: videoPath(video), ...videoDims(video) };
}

export type VideoMatch =
  | {
      ok: true;
      video: Video;
      /**
       * "path": same path. "name": same file name and at least one of frame
       * count / height / width known on both sides and equal. "probable": same
       * file name, nothing contradicts it, but nothing confirms it either
       * (neither side recorded comparable sizes) — shown, not ticked.
       */
      by: "path" | "name" | "probable";
    }
  | { ok: false; reason: string };

function describeDims(d: Pick<TargetVideo, "frameCount" | "height" | "width">): string {
  const size = d.width && d.height ? `${d.width}×${d.height}` : "unknown size";
  const n = d.frameCount ? `${d.frameCount} frames` : "unknown length";
  return `${size}, ${n}`;
}

/** Both known and different. Unknown on either side doesn't count against a match. */
function differs(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a !== b;
}

/** Both known and equal. */
function agrees(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a === b;
}

/**
 * Which of `videos` is the target video: the one with the same path, else one
 * with the same file name whose frame count and frame size don't contradict
 * the target's (a value the file didn't record doesn't count against it).
 * A name match with no size confirming it is only "probable".
 */
export function matchVideo(videos: readonly Video[], target: TargetVideo): VideoMatch {
  const want = normalizePath(target.path);
  const byPath = videos.find((v) => normalizePath(videoPath(v)) === want);
  if (byPath) return { ok: true, video: byPath, by: "path" };

  const name = pathBaseName(target.path);
  const sameName = videos.filter((v) => pathBaseName(videoPath(v)) === name);
  let probable: Video | null = null;
  for (const v of sameName) {
    const d = videoDims(v);
    if (
      !differs(d.frameCount, target.frameCount) &&
      !differs(d.height, target.height) &&
      !differs(d.width, target.width)
    ) {
      const confirmed =
        agrees(d.frameCount, target.frameCount) || agrees(d.height, target.height) || agrees(d.width, target.width);
      if (confirmed) return { ok: true, video: v, by: "name" };
      probable ??= v;
    }
  }
  if (probable) return { ok: true, video: probable, by: "probable" };
  if (sameName.length > 0) {
    return {
      ok: false,
      reason: `Has a video named ${name}, but it is ${describeDims(videoDims(sameName[0]))}; this video is ${describeDims(target)}`,
    };
  }
  const names = videos.map((v) => pathBaseName(videoPath(v)));
  if (names.length === 0) return { ok: false, reason: "Has no videos" };
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? `, +${names.length - 3} more` : "");
  return { ok: false, reason: `Doesn't contain this video (has ${shown})` };
}

export type SkeletonCheck =
  | {
      ok: true;
      skeleton: Skeleton;
      /** `nodeMap[i]` = index in the file's skeleton of the project's node `i`. */
      nodeMap: number[];
    }
  | { ok: false; reason: string };

/**
 * Whether `skeleton` has exactly the project's node names (any order, any
 * edges). Returns the index map from project order to file order, or the
 * reason it can't be compared, e.g. "Skeleton differs: missing nodes thorax,
 * abdomen".
 */
export function checkSkeleton(projectNodeNames: readonly string[], skeleton: Skeleton): SkeletonCheck {
  const fileNames = skeleton.nodes.map((n) => n.name);
  const missing = projectNodeNames.filter((n) => !fileNames.includes(n));
  const extra = fileNames.filter((n) => !projectNodeNames.includes(n));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing node${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`extra node${extra.length > 1 ? "s" : ""} ${extra.join(", ")}`);
    return { ok: false, reason: `Skeleton differs: ${parts.join("; ")}` };
  }
  return { ok: true, skeleton, nodeMap: projectNodeNames.map((n) => fileNames.indexOf(n)) };
}

/**
 * The model's display name: the model folder(s) recorded in the file's
 * provenance (`model_paths`, written by sleap-nn and SLEAP), joined with " + "
 * for a two-stage pipeline; else the file name without `.slp`.
 */
export function modelNameFromProvenance(provenance: Record<string, unknown> | null | undefined, fileName: string): string {
  const raw = provenance?.model_paths ?? provenance?.model_path;
  const paths = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).filter(
    (p): p is string => typeof p === "string" && p.trim() !== ""
  );
  const names = paths
    .map((p) => {
      const n = normalizePath(p.trim());
      const base = pathBaseName(n);
      // A path to a checkpoint or config names its folder.
      if (/\.(ckpt|h5|keras|json|ya?ml|onnx|pt)$/i.test(base)) {
        const dir = n.slice(0, n.length - base.length - 1);
        return pathBaseName(dir) || base;
      }
      return base;
    })
    .filter((n) => n !== "");
  if (names.length > 0) return [...new Set(names)].join(" + ");
  return pathBaseName(fileName).replace(/\.slp$/i, "");
}

/**
 * Predicted instances of `video`, grouped by frame, reordered to the project's
 * nodes, in a compact {@link PoseStore} (one flat array per model rather than
 * an array per pose; see poseStore.ts for why).
 */
export function extractPoses(labels: Labels, video: Video, nodeMap: readonly number[]): PoseStore {
  const n = nodeMap.length;
  const lfs = labels.labeledFrames.filter((lf) => lf.video === video);
  let capacity = 0;
  for (const lf of lfs) capacity += lf.instances.length;
  const b = new PoseStoreBuilder(n, capacity);
  for (const lf of lfs) {
    for (const inst of lf.instances) {
      if (!(inst instanceof PredictedInstance)) continue;
      // numpy() reads io's columnar storage directly (no per-point view objects);
      // hidden points come back as NaN.
      const pts = inst.numpy({ invisibleAsNaN: true });
      const score = Number.isFinite(inst.score) ? inst.score : null;
      const off = b.begin(lf.frameIdx, score, inst.track?.name ?? null);
      const xy = b.buffer;
      for (let i = 0; i < n; i++) {
        const p = pts[nodeMap[i]];
        const ok = p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
        xy[off + 2 * i] = ok ? p[0] : NaN;
        xy[off + 2 * i + 1] = ok ? p[1] : NaN;
      }
    }
  }
  return b.build();
}

/** A prediction file checked against the project: usable, with poses, or not, with the reason. */
export type CandidateAnalysis =
  | {
      ok: true;
      name: string;
      frames: PoseFrames;
      /** Frames that have at least one predicted pose. */
      frameCount: number;
      /** The file's video was found by path or only by file name. */
      matchedBy: "path" | "name" | "probable";
    }
  | { ok: false; name: string; reason: string };

/**
 * Check one loaded prediction file against the project's current video and
 * node names, and pull out its poses when it fits.
 */
export function analyzePredictionFile(
  labels: Labels,
  fileName: string,
  target: TargetVideo,
  projectNodeNames: readonly string[]
): CandidateAnalysis {
  const name = modelNameFromProvenance(labels.provenance, fileName);
  const vm = matchVideo(labels.videos, target);
  if (!vm.ok) return { ok: false, name, reason: vm.reason };

  // The skeleton(s) the predictions on this video use; files nearly always have one.
  const used: Skeleton[] = [];
  let anyPredicted = false;
  for (const lf of labels.labeledFrames) {
    if (lf.video !== vm.video) continue;
    for (const inst of lf.instances) {
      if (!(inst instanceof PredictedInstance)) continue;
      anyPredicted = true;
      if (!used.includes(inst.skeleton)) used.push(inst.skeleton);
    }
  }
  if (!anyPredicted) return { ok: false, name, reason: "No predictions for this video" };
  if (used.length > 1) {
    return { ok: false, name, reason: "Predictions use more than one skeleton" };
  }
  const sk = checkSkeleton(projectNodeNames, used[0]);
  if (!sk.ok) return { ok: false, name, reason: sk.reason };

  const frames = extractPoses(labels, vm.video, sk.nodeMap);
  return { ok: true, name, frames, frameCount: frames.size, matchedBy: vm.by };
}

/**
 * SLEAP / sleap-nn write a run's predictions on its own train/val/test split
 * next to the checkpoint (`models/<run>/labels_pr.train.slp`, `labels_pr.val.0.slp`).
 * Those only cover the labeled frames in that split, so they aren't a
 * whole-video comparison: listed, not ticked by default.
 */
export function isTrainingSplitFile(fileName: string): boolean {
  return /^labels_(pr|gt)\.(train|val|test)(\.\d+)?\.slp$/i.test(pathBaseName(fileName));
}

/** "name", or "name (2)", "name (3)", … when another model already uses it. */
export function uniqueModelName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  let i = 2;
  while (taken.includes(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}
