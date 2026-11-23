/**
 * Inference on a project with several skeletons (e.g. a mouse pose skeleton
 * and a 1-node pellet skeleton labeled on one video) — talmolab/sleap-app#99.
 *
 * Rule: a model belongs to the project skeleton whose NODE NAMES equal its own
 * (as a set; order and edges don't matter — merging remaps points by name). The
 * models picked for one skeleton form one sleap-nn run (e.g. centroid +
 * centered-instance for the mice, a centroid model alone for the pellets); each
 * run's predictions are merged under that skeleton only. A model that matches
 * no project skeleton is refused, with the reason.
 *
 * Pure (no stores, no Tauri): the panel and the inference store build on it.
 */

import yaml from "js-yaml";
import {
  LabeledFrame,
  Labels,
  type Instance,
  type PredictedInstance,
  type Skeleton,
} from "@talmolab/sleap-io.js";
import { cropModeOf, headTypeMatches, type CropMode } from "./bboxModels";
import { MODEL_TYPE_LABELS, parseTrainingConfig } from "./metrics/loadModelMetrics";
import { PIPELINE_HEADS } from "./modelDiscovery";
import { sameSkeletonStructure, structuralGroups } from "./skeletonStructure";
import type { InferenceConfig, PipelineType } from "@/stores/inferenceStore";

/** What the app knows about one model directory (from its training_config.yaml). */
export interface ModelInfo {
  path: string;
  /** Active head (`centroid`, `centered_instance`, …), or null when unreadable. */
  headKey: string | null;
  cropMode?: CropMode | null;
  /** Node names of the skeleton the model was trained on; null when unreadable. */
  nodeNames: string[] | null;
}

/** Parse a model's `training_config.yaml` text into a {@link ModelInfo}. */
export function parseModelInfo(path: string, yamlText: string): ModelInfo {
  const cfg = parseTrainingConfig(yamlText);
  let cropMode: CropMode | null = null;
  try {
    cropMode = cropModeOf(yaml.load(yamlText));
  } catch {
    // Unknown crop mode is fine.
  }
  return { path, headKey: cfg.headKey, cropMode, nodeNames: cfg.nodeNames };
}

/** Join a model directory and a filename using the directory's separator. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
}

/**
 * Read a model directory's info through `readText` (the local fs plugin, or a
 * worker's `fs.read` over Connect). Never throws: an unreadable config gives
 * `headKey: null, nodeNames: null`, which the plan reports as a refusal.
 */
export async function readModelInfo(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<ModelInfo> {
  try {
    return parseModelInfo(path, await readText(joinPath(path, "training_config.yaml")));
  } catch {
    return { path, headKey: null, cropMode: null, nodeNames: null };
  }
}

/**
 * Drop cached model reads that failed (config unreadable — e.g. the worker
 * was briefly unreachable) for paths no longer in `keepPaths`, or named in
 * `retry`, so the panel reads them again when they're re-added or retried.
 * Returns `cache` itself when nothing changes.
 */
export function forgetFailedModelReads(
  cache: Record<string, ModelInfo>,
  keepPaths: readonly string[],
  retry: readonly string[] = [],
): Record<string, ModelInfo> {
  const drop = Object.keys(cache).filter(
    (p) => cache[p].nodeNames === null && (retry.includes(p) || !keepPaths.includes(p)),
  );
  if (drop.length === 0) return cache;
  const next = { ...cache };
  for (const p of drop) delete next[p];
  return next;
}

// ── Matching a model to a project skeleton ─────────────────────────────────

/** Same node names, ignoring order (points are remapped by name on merge). */
export function sameNodeNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  if (set.size !== a.length) return false;
  return b.every((n) => set.has(n));
}

/** Display name for a skeleton, by name or position ("Skeleton 2"). */
export function skeletonLabel(skeleton: Skeleton, skeletons: readonly Skeleton[]): string {
  const name = skeleton.name?.trim();
  if (name) return name;
  const idx = skeletons.indexOf(skeleton);
  return `Skeleton ${idx >= 0 ? idx + 1 : "?"}`;
}

/**
 * One representative per structurally distinct skeleton, in project order —
 * identical duplicate skeleton objects (old files) count once. With `inUse`,
 * a group's representative is a skeleton in use when it has one.
 */
export function distinctProjectSkeletons(
  skeletons: readonly Skeleton[],
  inUse?: readonly Skeleton[],
): Skeleton[] {
  return structuralGroups(skeletons).map((g) => g.find((s) => inUse?.includes(s)) ?? g[0]);
}

/**
 * The skeletons a project is using: every skeleton an instance uses, plus the
 * active one (just added, nothing labeled yet). Breaks ties when a model's
 * node names match several project skeletons — e.g. a leftover duplicate that
 * a skeleton edit left unused next to the edited one.
 */
export function skeletonsInUse(
  labels: Pick<Labels, "labeledFrames" | "skeletons">,
  active?: Skeleton | null,
): Skeleton[] {
  const out = new Set<Skeleton>();
  if (active && labels.skeletons.includes(active)) out.add(active);
  for (const lf of labels.labeledFrames) for (const inst of lf.instances) out.add(inst.skeleton);
  return [...out];
}

function listNames(names: readonly string[], max = 4): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown}, … (${names.length} in all)` : shown;
}

export type SkeletonMatch =
  | { ok: true; skeleton: Skeleton }
  | { ok: false; reason: string };

/**
 * The project skeleton a model with `nodeNames` belongs to. Refuses (with a
 * reason) when the names are unknown, match no skeleton, or match several
 * different skeletons. With `inUse` (see {@link skeletonsInUse}), names that
 * match several skeletons go to the one in use when exactly one is.
 */
export function matchModelSkeleton(
  nodeNames: readonly string[] | null,
  skeletons: readonly Skeleton[],
  inUse?: readonly Skeleton[],
): SkeletonMatch {
  if (!nodeNames || nodeNames.length === 0) {
    return {
      ok: false,
      reason: "Couldn't read the model's skeleton from its training_config.yaml.",
    };
  }
  const candidates = distinctProjectSkeletons(skeletons, inUse);
  let matches = candidates.filter((s) => sameNodeNames(s.nodeNames, nodeNames));
  if (matches.length > 1 && inUse) {
    const used = matches.filter((s) => inUse.includes(s));
    if (used.length > 0) matches = used;
  }
  if (matches.length === 1) return { ok: true, skeleton: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `Its nodes match several project skeletons (${matches.map((s) => skeletonLabel(s, skeletons)).join(", ")}). ` +
        "Rename nodes so each skeleton's names are unique to it.",
    };
  }
  // No match: name the closest skeleton and what differs.
  const modelSet = new Set(nodeNames);
  let best: { skeleton: Skeleton; missing: string[]; extra: string[]; score: number } | null = null;
  for (const s of candidates) {
    const names = s.nodeNames;
    const nameSet = new Set(names);
    const missing = names.filter((n) => !modelSet.has(n));
    const extra = nodeNames.filter((n) => !nameSet.has(n));
    const common = names.length - missing.length;
    if (!best || common > best.score) best = { skeleton: s, missing, extra, score: common };
  }
  const modelDesc = `The model's nodes (${listNames(nodeNames)}) don't match any project skeleton.`;
  if (!best || best.score === 0) return { ok: false, reason: modelDesc };
  const parts: string[] = [];
  if (best.missing.length) parts.push(`missing ${listNames(best.missing)}`);
  if (best.extra.length) parts.push(`extra ${listNames(best.extra)}`);
  return {
    ok: false,
    reason: `${modelDesc} Closest: ${skeletonLabel(best.skeleton, skeletons)} (${parts.join("; ")}).`,
  };
}

// ── Pipeline per skeleton ───────────────────────────────────────────────────

/** A pipeline for one skeleton's models; "centroid-only" = a centroid model alone. */
export type SkeletonPipeline = PipelineType | "centroid-only";

export const SKELETON_PIPELINE_LABELS: Record<SkeletonPipeline, string> = {
  "top-down": "Top-Down",
  "bottom-up": "Bottom-Up",
  "single-animal": "Single Animal",
  "top-down-id": "Top-Down + ID",
  "bottom-up-id": "Bottom-Up + ID",
  bbox: "Box Detector",
  "top-down-bbox": "Top-Down (Box Crops)",
  "centroid-only": "Centroid only",
};

const PIPELINE_ORDER: SkeletonPipeline[] = [
  "top-down",
  "top-down-bbox",
  "top-down-id",
  "bottom-up",
  "bottom-up-id",
  "single-animal",
  "bbox",
  "centroid-only",
];

function headsFor(pipeline: SkeletonPipeline): string[] {
  return pipeline === "centroid-only" ? ["centroid"] : PIPELINE_HEADS[pipeline];
}

/**
 * The pipeline a set of models (all for one skeleton) forms: every head the
 * pipeline needs filled by exactly one model, with no model left over. A
 * centroid model alone is "centroid-only" (sleap-nn predicts the anchor point
 * — the whole pose for a 1-node skeleton like a pellet).
 */
export function pipelineForModels(
  models: readonly Pick<ModelInfo, "headKey" | "cropMode">[],
): SkeletonPipeline | null {
  if (models.length === 0 || models.some((m) => !m.headKey)) return null;
  for (const pipeline of PIPELINE_ORDER) {
    const heads = headsFor(pipeline);
    if (heads.length !== models.length) continue;
    const used = new Set<number>();
    const ok = heads.every((h) => {
      const i = models.findIndex((m, j) => !used.has(j) && headTypeMatches(h, m));
      if (i < 0) return false;
      used.add(i);
      return true;
    });
    if (ok) return pipeline;
  }
  return null;
}

/**
 * Auto-pick trained models for a multi-skeleton project: for every project
 * skeleton, the most recently trained complete pipeline among the models
 * whose node names match it. A centroid model alone only for a 1-node
 * skeleton (a pellet) and only when nothing else is complete — on a
 * multi-node skeleton it predicts just the anchor point (see
 * {@link centroidOnlyProblem}). `models` must be sorted most recent first
 * (findTrainedModels).
 */
export function pickModelsForSkeletons(
  models: readonly ModelInfo[],
  skeletons: readonly Skeleton[],
  inUse?: readonly Skeleton[],
): string[] {
  const bySkeleton = new Map<Skeleton, ModelInfo[]>();
  for (const m of models) {
    if (!m.headKey) continue;
    const match = matchModelSkeleton(m.nodeNames, skeletons, inUse);
    if (!match.ok) continue;
    const list = bySkeleton.get(match.skeleton) ?? [];
    list.push(m);
    bySkeleton.set(match.skeleton, list);
  }
  const picked: string[] = [];
  for (const skeleton of distinctProjectSkeletons(skeletons, inUse)) {
    const mine = bySkeleton.get(skeleton) ?? [];
    let best: { paths: string[]; oldest: number } | null = null;
    for (const pipeline of PIPELINE_ORDER) {
      if (pipeline === "centroid-only" && (best || skeleton.nodeNames.length > 1)) break;
      const idx: number[] = [];
      const ok = headsFor(pipeline).every((h) => {
        const i = mine.findIndex((m, j) => !idx.includes(j) && headTypeMatches(h, m));
        if (i < 0) return false;
        idx.push(i);
        return true;
      });
      if (!ok) continue;
      const oldest = Math.max(...idx);
      if (!best || oldest < best.oldest) best = { paths: idx.map((i) => mine[i].path), oldest };
    }
    if (best) picked.push(...best.paths);
  }
  return picked;
}

/**
 * Why a centroid model alone can't run for `skeleton`, or null. sleap-nn
 * (≤ 0.3.5) gives centroid-only instances the anchor point and NaN for every
 * other node — fine for a 1-node skeleton (a pellet), but on a multi-node
 * skeleton it would replace full poses with near-empty ones.
 */
export function centroidOnlyProblem(skeleton: Skeleton, name: string): string | null {
  const n = skeleton.nodeNames.length;
  if (n <= 1) return null;
  return (
    `${name}: a Centroid model alone predicts only one point per instance, but this skeleton has ${n} nodes. ` +
    "Add a Centered Instance model (Centroid only is for 1-node skeletons, like a pellet)."
  );
}

/** The pipeline value an {@link InferenceConfig} carries for a skeleton run. */
export function configPipeline(pipeline: SkeletonPipeline): PipelineType {
  // sleap-nn picks the predictor from the models; the config's pipeline only
  // gates bottom-up-only flags and tracking, where centroid-only = top-down.
  return pipeline === "centroid-only" ? "top-down" : pipeline;
}

// ── The plan the dialog shows and the store runs ───────────────────────────

/** One sleap-nn run: the models for one project skeleton. */
export interface SkeletonRunPlan {
  skeleton: Skeleton;
  skeletonName: string;
  /** Index of `skeleton` in `labels.skeletons`. */
  skeletonIndex: number;
  modelPaths: string[];
  pipeline: SkeletonPipeline | null;
  /** Why these models can't run together, or null when they can. */
  problem: string | null;
}

export interface ModelVerdict {
  path: string;
  /** Matched skeleton's name, or null when refused. */
  skeletonName: string | null;
  /** Why the model was refused, or null when it matched. */
  reason: string | null;
}

export interface MultiSkeletonPlan {
  runs: SkeletonRunPlan[];
  /** One verdict per model, in the order given. */
  models: ModelVerdict[];
  /** Overall reason Run is disabled, or null when every run can go. */
  problem: string | null;
}

function headLabel(m: Pick<ModelInfo, "headKey">): string {
  return m.headKey ? (MODEL_TYPE_LABELS[m.headKey] ?? m.headKey) : "unknown";
}

/** Match every model to a skeleton and group them into one run per skeleton. */
export function planMultiSkeletonInference(
  models: readonly ModelInfo[],
  skeletons: readonly Skeleton[],
  /** Skeletons in use ({@link skeletonsInUse}) — breaks node-name ties. */
  inUse?: readonly Skeleton[],
): MultiSkeletonPlan {
  const verdicts: ModelVerdict[] = [];
  const bySkeleton = new Map<Skeleton, ModelInfo[]>();
  for (const m of models) {
    const match = matchModelSkeleton(m.nodeNames, skeletons, inUse);
    if (!match.ok) {
      verdicts.push({ path: m.path, skeletonName: null, reason: match.reason });
      continue;
    }
    if (!m.headKey) {
      verdicts.push({ path: m.path, skeletonName: null, reason: "Couldn't read the model's type from its training_config.yaml." });
      continue;
    }
    verdicts.push({ path: m.path, skeletonName: skeletonLabel(match.skeleton, skeletons), reason: null });
    const list = bySkeleton.get(match.skeleton) ?? [];
    list.push(m);
    bySkeleton.set(match.skeleton, list);
  }

  const runs: SkeletonRunPlan[] = [];
  for (const [skeleton, group] of bySkeleton) {
    const pipeline = pipelineForModels(group);
    const name = skeletonLabel(skeleton, skeletons);
    runs.push({
      skeleton,
      skeletonName: name,
      skeletonIndex: skeletons.indexOf(skeleton),
      modelPaths: group.map((m) => m.path),
      pipeline,
      problem: !pipeline
        ? `${name}: these models don't form a pipeline (${group.map(headLabel).join(" + ")}). ` +
          "Use e.g. Centroid + Centered Instance, a Bottom-Up model, a Single Instance model, or (for a 1-node skeleton) a Centroid model alone."
        : pipeline === "centroid-only"
          ? centroidOnlyProblem(skeleton, name)
          : null,
    });
  }
  runs.sort((a, b) => a.skeletonIndex - b.skeletonIndex);

  let problem: string | null = null;
  const refused = verdicts.filter((v) => v.reason);
  if (refused.length > 0) {
    problem = `${refused.length} model${refused.length === 1 ? "" : "s"} can't be used — remove ${refused.length === 1 ? "it" : "them"} to run.`;
  } else if (runs.some((r) => r.problem)) {
    problem = runs.find((r) => r.problem)!.problem;
  } else if (runs.length === 0) {
    problem = "Add a model for one of the project's skeletons.";
  }
  return { runs, models: verdicts, problem };
}

/** What the inference store needs per run (serializable; no Skeleton objects). */
export interface SkeletonRunSpec {
  skeletonName: string;
  skeletonIndex: number;
  modelPaths: string[];
  pipeline: SkeletonPipeline;
}

/** The runnable part of a plan (only call when `plan.problem` is null). */
export function runSpecsFromPlan(plan: MultiSkeletonPlan): SkeletonRunSpec[] {
  return plan.runs
    .filter((r): r is SkeletonRunPlan & { pipeline: SkeletonPipeline } => r.pipeline !== null)
    .map((r) => ({
      skeletonName: r.skeletonName,
      skeletonIndex: r.skeletonIndex,
      modelPaths: r.modelPaths,
      pipeline: r.pipeline,
    }));
}

/** The config for one skeleton's run of a multi-skeleton inference. */
export function configForSkeletonRun(config: InferenceConfig, run: SkeletonRunSpec): InferenceConfig {
  return {
    ...config,
    modelPaths: run.modelPaths,
    pipeline: configPipeline(run.pipeline),
    // Kalman node indices point into ONE skeleton's nodes; use all nodes.
    kfNodeIndices: [],
    skeletonRuns: undefined,
  };
}

// ── Targets and input ───────────────────────────────────────────────────────

/**
 * Why `config` can't run on a project with several skeletons, or null when it
 * can. Checked by the inference store before starting (the panel disables Run
 * for the same reasons).
 */
export function multiSkeletonRunProblem(config: InferenceConfig, remote: boolean): string | null {
  if (config.trackOnly) return "Track only with several skeletons isn't supported yet.";
  if (!config.skeletonRuns || config.skeletonRuns.length === 0) {
    return "Add a model whose node names match one of the project's skeletons.";
  }
  if (remote) return remoteMultiSkeletonTargetProblem(config.frameRange);
  return null;
}

/**
 * Inference targets a Connect worker can't run on a multi-skeleton project.
 * sleap-nn (≤ 0.3.5) reads the project's existing instances for these and
 * crashes on a frame that mixes skeletons ("could not broadcast input array"
 * in its labels provider). Locally the app sends sleap-nn a per-skeleton copy
 * instead (see {@link labelsForSkeleton}); a worker reads its own copy of the
 * project file, so those targets are refused there.
 */
const REMOTE_UNSAFE_TARGETS: Record<string, string> = {
  user_labeled: "User labeled frames",
  predicted: "Frames with predictions",
  all_videos: "All videos",
};

/** Why `frameRange` can't run on a worker for a multi-skeleton project, or null. */
export function remoteMultiSkeletonTargetProblem(
  frameRange: InferenceConfig["frameRange"] | string,
): string | null {
  if (typeof frameRange !== "string") return null;
  const label = REMOTE_UNSAFE_TARGETS[frameRange];
  if (!label) return null;
  return `"${label}" can't run on a worker in a project with several skeletons yet. Pick suggested frames, the current video, a range or a random sample — or run on this computer.`;
}

/**
 * A copy of `labels` holding only `skeleton`'s instances (other skeletons'
 * instances and all non-instance annotations dropped), for sleap-nn's input:
 * one model only knows one skeleton, and sleap-nn ≤ 0.3.5 crashes on frames
 * mixing skeletons. Videos, tracks and suggestions are shared (same objects,
 * same order, so `--video_index` still means the same video). Frames left
 * without an instance are dropped unless marked negative, so "user labeled"
 * and "exclude user labeled" mean "labeled with THIS skeleton".
 */
export function labelsForSkeleton(labels: Labels, skeleton: Skeleton): Labels {
  const frames: LabeledFrame[] = [];
  // Identical duplicate skeleton objects (old files) count as this skeleton.
  const used = new Set<Skeleton>([skeleton]);
  for (const lf of labels.labeledFrames) {
    const instances = lf.instances.filter(
      (inst: Instance | PredictedInstance) => sameSkeletonStructure(inst.skeleton, skeleton),
    );
    for (const inst of instances) used.add(inst.skeleton);
    if (instances.length === 0 && !lf.isNegative) continue;
    frames.push(
      new LabeledFrame({
        video: lf.video,
        frameIdx: lf.frameIdx,
        instances,
        isNegative: lf.isNegative,
      }),
    );
  }
  return new Labels({
    videos: labels.videos,
    skeletons: [...used],
    tracks: labels.tracks,
    suggestions: labels.suggestions,
    labeledFrames: frames,
  });
}

/** A filename-safe tag for a skeleton's run output (`mouse`, `skeleton_2`). */
export function skeletonFileTag(name: string): string {
  const tag = name.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return tag || "skeleton";
}

// ── Which frames sleap-nn reads WITH their instances ───────────────────────

/**
 * The labeled frames a run reads from a .slp together with their instances:
 * one video (or every video) and a frame filter. sleap-nn (≤ 0.3.5) crashes
 * on such a frame when it mixes skeletons ("could not broadcast input array"
 * — it pads every instance to the FIRST instance's node count).
 */
export interface InstanceReadScope {
  /** Index into `labels.videos`, or null for every video. */
  videoIndex: number | null;
  /** Which frame indices of that video, or null for all of them. */
  frames: ((frameIdx: number) => boolean) | null;
}

/** Parse a sleap-nn `--frames` value ("10-20" or "1,5,9"). */
export function parseFrameSelection(frames: string): (frameIdx: number) => boolean {
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(frames);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return (i) => i >= a && i <= b;
  }
  const set = new Set(frames.split(",").map((f) => Number(f.trim())));
  return (i) => set.has(i);
}

/**
 * What a local run of `config` reads with instances when sleap-nn is given a
 * .slp, or null when it reads none. Suggested frames come back as fresh empty
 * frames (sleap-nn skips labeled ones), so they read none. A random sample's
 * frames are drawn later, so it counts as its whole video.
 */
export function localRunScope(
  config: Pick<InferenceConfig, "frameRange" | "videoIndex">,
  currentFrameIdx: number,
): InstanceReadScope | null {
  const fr = config.frameRange;
  if (fr === "suggestions") return null;
  const videoIndex = config.videoIndex === "all" ? null : config.videoIndex;
  if (typeof fr === "object") return { videoIndex, frames: (i) => i >= fr.start && i <= fr.end };
  if (fr === "frame") return { videoIndex, frames: (i) => i === currentFrameIdx };
  return { videoIndex, frames: null };
}

/** The same for a Connect track spec (see `buildRemoteTrackSpecs`). */
export function remoteSpecScope(spec: {
  video_index?: number;
  frames?: string;
  frame_filter?: string;
}): InstanceReadScope | null {
  if (spec.frame_filter === "suggested") return null;
  return {
    videoIndex: spec.video_index ?? null,
    frames: spec.frames ? parseFrameSelection(spec.frames) : null,
  };
}

/**
 * True when a frame in `scope` holds instances of two structurally different
 * skeletons — the frames sleap-nn ≤ 0.3.5 can't read from a .slp.
 */
export function scopeHasMixedFrames(labels: Labels, scope: InstanceReadScope | null): boolean {
  if (!scope) return false;
  const video = scope.videoIndex === null ? null : (labels.videos[scope.videoIndex] ?? null);
  if (scope.videoIndex !== null && !video) return false;
  for (const lf of labels.labeledFrames) {
    if (video && lf.video !== video) continue;
    if (scope.frames && !scope.frames(lf.frameIdx)) continue;
    const first = lf.instances[0]?.skeleton;
    if (first && lf.instances.some((inst) => !sameSkeletonStructure(inst.skeleton, first))) return true;
  }
  return false;
}

/** Targets whose meaning is "frames labeled with this skeleton" — always read a per-skeleton copy. */
const LABEL_SCOPED_TARGETS = new Set(["user_labeled", "predicted", "all_videos"]);

/**
 * Whether a local run for one skeleton must read a per-skeleton copy of the
 * project ({@link labelsForSkeleton}) instead of the project file: always for
 * the label-scoped targets (user labeled / predicted / all videos), and
 * otherwise only when the frames it reads with instances mix skeletons.
 * Writing the copy re-serializes the project (embedded images included for a
 * .pkg.slp), so it's skipped whenever the project file is safe to read.
 */
export function runNeedsSkeletonCopy(
  labels: Labels,
  config: Pick<InferenceConfig, "frameRange" | "videoIndex">,
  currentFrameIdx: number,
): boolean {
  if (typeof config.frameRange === "string" && LABEL_SCOPED_TARGETS.has(config.frameRange)) return true;
  return scopeHasMixedFrames(labels, localRunScope(config, currentFrameIdx));
}

/** Why a Connect job reading `scope` can't run on a multi-skeleton project, or null. */
export function remoteMixedFramesProblem(labels: Labels, scope: InstanceReadScope | null): string | null {
  if (!scopeHasMixedFrames(labels, scope)) return null;
  return (
    "This target includes frames that hold instances of several skeletons, which sleap-nn can't read on a worker yet. " +
    "Pick suggested frames, or run on this computer."
  );
}
