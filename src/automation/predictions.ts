/**
 * Predictions as the Claude connector sees them (prediction review): which
 * predicted instances are worth a look, and stable ids to point at them.
 *
 * A prediction is a candidate when the model was unsure of it — its instance
 * score or a node's score is below a threshold — or when, with two or more
 * models shown in Compare Model Predictions, those models place one of its
 * nodes far apart. Predictions the user already dealt with are left out: one
 * a user instance on the frame was made from (`fromPredicted`), and one that
 * overlaps a user instance (the animal is labeled already).
 *
 * Id format: `v{videoIdx}:f{frameIdx}:p{predIdx}:{hash}`, where `predIdx`
 * indexes the frame's predicted instances and `hash` is a short hash of the
 * prediction's pose. Accepting one prediction shifts the others' indices, so
 * an id is resolved by its hash (the index is a hint, and for reading).
 */
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { modelOverlayLayers, shownModelsShareTracks } from "@/hooks/useModelOverlayFrame";
import {
  findDisagreements,
  groupAcrossModels,
  matchPoses,
  nodeSpreads,
  type GroupMember,
} from "@/lib/modelOverlay/matching";
import { poseFingerprint } from "@/stores/proposalStore";
import { AutomationError } from "./errors";
import { requireLabels } from "./qcFlags";
import type { Instance, LabeledFrame, Labels, PredictedInstance, Video } from "@/types";

/** Default cut-offs: below these, the model was unsure. */
export const DEFAULT_MAX_INSTANCE_SCORE = 0.5;
export const DEFAULT_MAX_NODE_SCORE = 0.5;

const PRED_ID = /^v(\d+):f(\d+):p(\d+):([0-9a-f]{6})$/;

/** 24-bit FNV-1a of a pose fingerprint, as 6 hex digits. */
export function poseHash(fingerprint: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < fingerprint.length; i++) {
    h ^= fingerprint.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h ^ (h >>> 24)) & 0xffffff).toString(16).padStart(6, "0");
}

export function makePredictionId(videoIdx: number, frameIdx: number, predIdx: number, inst: Instance): string {
  return `v${videoIdx}:f${frameIdx}:p${predIdx}:${poseHash(poseFingerprint(inst))}`;
}

export interface ParsedPredictionId {
  videoIdx: number;
  frameIdx: number;
  predIdx: number;
  hash: string;
}

export function parsePredictionId(id: string): ParsedPredictionId {
  const m = PRED_ID.exec(id);
  if (!m) {
    throw new AutomationError(
      "BAD_INPUT",
      `"${id}" is not a prediction id. Prediction ids look like "v0:f120:p1:3fa2c1"; get them from list_predictions_to_review.`,
    );
  }
  return { videoIdx: Number(m[1]), frameIdx: Number(m[2]), predIdx: Number(m[3]), hash: m[4] };
}

export interface PredictionTarget {
  /** The id as it is now (its index may differ from the one asked for). */
  id: string;
  videoIdx: number;
  frameIdx: number;
  /** Index into the frame's predicted instances, now. */
  predIdx: number;
  lf: LabeledFrame;
  instance: PredictedInstance;
}

/** The prediction an id points at, or UNKNOWN_PREDICTION. */
export function findPrediction(labels: Labels, id: string): PredictionTarget {
  const { videoIdx, frameIdx, predIdx, hash } = parsePredictionId(id);
  const video = labels.videos[videoIdx];
  const lf = video ? labels.find({ video, frameIdx })[0] : undefined;
  const preds = lf?.predictedInstances ?? [];
  const hashOf = (pi: Instance) => poseHash(poseFingerprint(pi));
  let at = preds[predIdx] && hashOf(preds[predIdx]) === hash ? predIdx : -1;
  if (at < 0) at = preds.findIndex((pi) => hashOf(pi) === hash);
  if (!lf || at < 0) {
    throw new AutomationError(
      "UNKNOWN_PREDICTION",
      `No prediction "${id}" any more: it was accepted, deleted, or replaced by a new inference run. Call list_predictions_to_review for the current list.`,
    );
  }
  return {
    id: makePredictionId(videoIdx, frameIdx, at, preds[at]),
    videoIdx,
    frameIdx,
    predIdx: at,
    lf,
    instance: preds[at],
  };
}

/** `[x0, y0, …]` of an instance's placed, visible nodes (NaN elsewhere). */
export function poseXy(inst: Instance): Float64Array {
  const out = new Float64Array(inst.points.length * 2);
  inst.points.forEach((p, i) => {
    const ok = p.visible !== false && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
    out[2 * i] = ok ? p.xy[0] : NaN;
    out[2 * i + 1] = ok ? p.xy[1] : NaN;
  });
  return out;
}

/** Predictions a user instance on the frame was made from, or overlaps (the same animal). */
export function handledPredictions(lf: LabeledFrame): Set<PredictedInstance> {
  const preds = lf.predictedInstances;
  const users = lf.userInstances;
  const out = new Set<PredictedInstance>();
  if (preds.length === 0 || users.length === 0) return out;
  for (const u of users) if (u.fromPredicted) out.add(u.fromPredicted as PredictedInstance);
  const match = matchPoses(users.map(poseXy), preds.map(poseXy));
  match.forEach((t) => {
    if (t >= 0) out.add(preds[t]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Compare Models disagreement

/** One model's placement of each node of the prediction's animal. */
export interface ModelPlacement {
  model: string;
  /** `[x0, y0, …]` in source-frame pixels, project node order; NaN where the model has none. */
  xy: Float64Array;
}

export interface PredictionDisagreement {
  /** The models that placed this animal. */
  models: ModelPlacement[];
  /** Nodes whose spread across models exceeds the threshold. */
  nodes: { node: number; spreadPx: number }[];
}

/** The models compared on `video`: the shown ones, as the ▶/◀ disagreement steps use. */
export function comparedModels(video: Video): OverlayModel[] {
  const s = useModelOverlayStore.getState();
  if (s.labels !== useAppStore.getState().labels) return [];
  return s.models.filter((m) => m.visible && m.video === video);
}

interface FrameGroups {
  layers: ReturnType<typeof modelOverlayLayers>;
  /** Animals with at least one node over the threshold. */
  groups: { members: GroupMember[]; mean: Float64Array; spread: Float64Array }[];
}

/** The disagreeing animals on one frame (null when none). */
function frameGroups(models: OverlayModel[], video: Video, frameIdx: number, threshold: number): FrameGroups | null {
  const layers = modelOverlayLayers(models, video, frameIdx);
  if (layers.length < 2) return null;
  const groups = groupAcrossModels(layers, shownModelsShareTracks(models, video));
  const flagged = new Set(findDisagreements(layers, groups, threshold).map((d) => d.group));
  if (flagged.size === 0) return null;
  return {
    layers,
    groups: [...flagged].map((gi) => ({ members: groups[gi], ...nodeSpreads(layers, groups[gi]) })),
  };
}

/** Frames where two or more of `models` have poses. */
function comparedFrames(models: OverlayModel[]): number[] {
  const counts = new Map<number, number>();
  for (const m of models) for (const f of m.frames.keys()) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([f]) => f);
}

/**
 * Per video, per frame: the disagreeing animals. A whole-video scan, so it is
 * kept until the models, their visibility or the threshold change.
 */
let disagreementCache: {
  models: OverlayModel[];
  threshold: number;
  byVideo: Map<Video, Map<number, FrameGroups>>;
} | null = null;

function disagreementsFor(video: Video): Map<number, FrameGroups> {
  const s = useModelOverlayStore.getState();
  if (!disagreementCache || disagreementCache.models !== s.models || disagreementCache.threshold !== s.threshold) {
    disagreementCache = { models: s.models, threshold: s.threshold, byVideo: new Map() };
  }
  let byFrame = disagreementCache.byVideo.get(video);
  if (!byFrame) {
    byFrame = new Map();
    const models = comparedModels(video);
    if (models.length >= 2) {
      for (const f of comparedFrames(models)) {
        const g = frameGroups(models, video, f, s.threshold);
        if (g) byFrame.set(f, g);
      }
    }
    disagreementCache.byVideo.set(video, byFrame);
  }
  return byFrame;
}

/** Forget cached disagreements (tests). */
export function clearDisagreementCache(): void {
  disagreementCache = null;
}

/**
 * For each disagreeing animal on the frame, the project prediction it is
 * (matched on mean node distance, as Accept in Compare Models matches).
 * Animals with no matching prediction are counted in `unmatched`.
 */
function matchFrameDisagreements(
  video: Video,
  lf: LabeledFrame | undefined,
  fg: FrameGroups,
): { byPrediction: Map<PredictedInstance, PredictionDisagreement>; unmatched: number } {
  const byPrediction = new Map<PredictedInstance, PredictionDisagreement>();
  const preds = lf?.predictedInstances ?? [];
  if (preds.length === 0) return { byPrediction, unmatched: fg.groups.length };
  const models = comparedModels(video);
  const threshold = useModelOverlayStore.getState().threshold;
  const match = matchPoses(
    fg.groups.map((g) => g.mean),
    preds.map(poseXy),
  );
  let unmatched = 0;
  match.forEach((t, gi) => {
    if (t < 0) {
      unmatched++;
      return;
    }
    const g = fg.groups[gi];
    const nodes: { node: number; spreadPx: number }[] = [];
    g.spread.forEach((s, node) => {
      if (Number.isFinite(s) && s > threshold) nodes.push({ node, spreadPx: s });
    });
    byPrediction.set(preds[t], {
      models: g.members.map((m) => {
        const layer = fg.layers[m.layer];
        return {
          model: models.find((x) => x.id === layer.modelId)?.name ?? layer.modelId,
          xy: layer.poses[m.pose].xy,
        };
      }),
      nodes,
    });
  });
  return { byPrediction, unmatched };
}

/** How the compared models placed this prediction's animal, if they disagree on it. */
export function predictionDisagreement(lf: LabeledFrame, inst: PredictedInstance): PredictionDisagreement | null {
  const fg = disagreementsFor(lf.video).get(lf.frameIdx);
  if (!fg) return null;
  return matchFrameDisagreements(lf.video, lf, fg).byPrediction.get(inst) ?? null;
}

// ---------------------------------------------------------------------------
// Candidates

export interface PredictionCandidate {
  id: string;
  videoIdx: number;
  frameIdx: number;
  predIdx: number;
  instance: PredictedInstance;
  track: string | null;
  instanceScore: number | null;
  /** Instance score below the threshold. */
  lowInstance: boolean;
  /** Placed nodes scored below the node threshold. */
  lowNodes: { node: number; score: number }[];
  /** Nodes the model didn't place. */
  unplaced: number[];
  disagreement: PredictionDisagreement | null;
}

export interface CandidateOptions {
  maxInstanceScore?: number;
  maxNodeScore?: number;
  /** Include Compare Models disagreement (default true). */
  disagreement?: boolean;
  videoIdx?: number;
}

export interface Quantiles {
  p10: number;
  median: number;
  p90: number;
}

export interface CandidateList {
  candidates: PredictionCandidate[];
  /** Predicted instances looked at (those the user hasn't dealt with). */
  reviewed: number;
  /** Disagreeing animals Compare Models found that match no project prediction. */
  unmatchedDisagreements: number;
  /** Instance and node scores across those predictions, to pick thresholds by. */
  scoreSummary: { instance: Quantiles | null; node: Quantiles | null };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** p10 / median / p90 of `xs` (larger sets are sampled down to ~100k values first). */
export function quantiles(xs: number[]): Quantiles | null {
  if (xs.length === 0) return null;
  const step = Math.max(1, Math.floor(xs.length / 100_000));
  const s = (step === 1 ? [...xs] : xs.filter((_, i) => i % step === 0)).sort((a, b) => a - b);
  const q = (f: number) => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 1000) / 1000;
  return { p10: q(0.1), median: q(0.5), p90: q(0.9) };
}

/** Every prediction worth Claude's look, unsorted. */
export function listPredictionCandidates(opts: CandidateOptions = {}): CandidateList {
  const labels = requireLabels();
  const maxInst = opts.maxInstanceScore ?? DEFAULT_MAX_INSTANCE_SCORE;
  const maxNode = opts.maxNodeScore ?? DEFAULT_MAX_NODE_SCORE;
  const videoIdxOf = new Map(labels.videos.map((v, i) => [v, i]));
  const instScores: number[] = [];
  const nodeScores: number[] = [];
  const candidates: PredictionCandidate[] = [];
  let reviewed = 0;
  let unmatchedDisagreements = 0;

  const disagreeing = new Map<Video, Map<number, FrameGroups>>();
  if (opts.disagreement !== false) {
    labels.videos.forEach((v, i) => {
      if (opts.videoIdx !== undefined && opts.videoIdx !== i) return;
      const d = disagreementsFor(v);
      if (d.size > 0) disagreeing.set(v, d);
    });
  }
  const framesSeen = new Set<string>();

  for (const lf of labels.labeledFrames) {
    const videoIdx = videoIdxOf.get(lf.video) ?? -1;
    if (videoIdx < 0 || (opts.videoIdx !== undefined && videoIdx !== opts.videoIdx)) continue;
    const preds = lf.predictedInstances;
    if (preds.length === 0) continue;
    const handled = handledPredictions(lf);
    const fg = disagreeing.get(lf.video)?.get(lf.frameIdx);
    let dis: Map<PredictedInstance, PredictionDisagreement> | null = null;
    if (fg) {
      framesSeen.add(`${videoIdx}:${lf.frameIdx}`);
      const m = matchFrameDisagreements(lf.video, lf, fg);
      dis = m.byPrediction;
      unmatchedDisagreements += m.unmatched;
    }
    preds.forEach((inst, predIdx) => {
      if (handled.has(inst)) return;
      reviewed++;
      const instanceScore = finite(inst.score) ? inst.score : null;
      if (instanceScore !== null) instScores.push(instanceScore);
      const lowNodes: { node: number; score: number }[] = [];
      const unplaced: number[] = [];
      inst.points.forEach((p, node) => {
        if (!Number.isFinite(p.xy[0]) || !Number.isFinite(p.xy[1])) {
          unplaced.push(node);
          return;
        }
        if (!finite(p.score)) return;
        nodeScores.push(p.score);
        if (p.score < maxNode) lowNodes.push({ node, score: p.score });
      });
      const lowInstance = instanceScore !== null && instanceScore < maxInst;
      const disagreement = dis?.get(inst) ?? null;
      if (!lowInstance && lowNodes.length === 0 && !disagreement) return;
      candidates.push({
        id: makePredictionId(videoIdx, lf.frameIdx, predIdx, inst),
        videoIdx,
        frameIdx: lf.frameIdx,
        predIdx,
        instance: inst,
        track: inst.track?.name ?? null,
        instanceScore,
        lowInstance,
        lowNodes,
        unplaced,
        disagreement,
      });
    });
  }
  // Disagreeing animals on frames with no predictions in the project at all.
  for (const [video, byFrame] of disagreeing) {
    const vi = videoIdxOf.get(video)!;
    for (const [f, fg] of byFrame) if (!framesSeen.has(`${vi}:${f}`)) unmatchedDisagreements += fg.groups.length;
  }
  return {
    candidates,
    reviewed,
    unmatchedDisagreements,
    scoreSummary: { instance: quantiles(instScores), node: quantiles(nodeScores) },
  };
}

export type CandidateOrder = "score" | "disagreement" | "frame";

/** The lowest score that made it a candidate (instance or node); Infinity when only disagreement did. */
export function candidateConfidence(c: PredictionCandidate): number {
  let s = Infinity;
  if (c.lowInstance && c.instanceScore !== null) s = c.instanceScore;
  for (const n of c.lowNodes) s = Math.min(s, n.score);
  return s;
}

const maxSpread = (c: PredictionCandidate) => Math.max(0, ...(c.disagreement?.nodes.map((n) => n.spreadPx) ?? []));

/**
 * "score": least confident first, then disagreement-only ones by spread;
 * "disagreement": widest spread first, then by score; "frame": video, frame.
 */
export function sortCandidates(cs: PredictionCandidate[], order: CandidateOrder = "score"): PredictionCandidate[] {
  const byFrame = (a: PredictionCandidate, b: PredictionCandidate) =>
    a.videoIdx - b.videoIdx || a.frameIdx - b.frameIdx || a.predIdx - b.predIdx;
  const byScore = (a: PredictionCandidate, b: PredictionCandidate) => {
    const sa = candidateConfidence(a);
    const sb = candidateConfidence(b);
    if (sa === sb) return 0;
    return sa === Infinity ? 1 : sb === Infinity ? -1 : sa - sb;
  };
  const bySpread = (a: PredictionCandidate, b: PredictionCandidate) => maxSpread(b) - maxSpread(a);
  const cmp =
    order === "frame"
      ? byFrame
      : order === "disagreement"
        ? (a: PredictionCandidate, b: PredictionCandidate) => bySpread(a, b) || byScore(a, b) || byFrame(a, b)
        : (a: PredictionCandidate, b: PredictionCandidate) => byScore(a, b) || bySpread(a, b) || byFrame(a, b);
  return [...cs].sort(cmp);
}
