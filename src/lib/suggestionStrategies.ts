/**
 * Pure, decode-free suggestion-generation strategies.
 *
 * Port of sleap/gui/suggestions.py (PyQt VideoFrameSuggestions) to TypeScript.
 * Each algorithm reads only the data model (Labels/Video and instance points)
 * and returns plain frame-index arrays / SuggestionFrame[]; nothing here decodes
 * video frames (PyQt's image-feature method, which DOES decode, is intentionally
 * omitted — Task 2's UI keeps it disabled).
 *
 * PyQt source line references (sleap/gui/suggestions.py) are noted per method.
 */

import type { Labels, Video, SuggestionFrame } from "../types";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { primaryPointDisplacementSeries } from "./statisticSeries";

export type GenerationMethod =
  | "stride"
  | "random"
  | "frame_chunk"
  | "prediction_score"
  | "velocity"
  | "max_displacement"
  // Decodes frames + clusters them (PCA + k-means); runs via the async
  // orchestrator in lib/imageFeatures.ts, NOT the sync dispatcher below.
  | "image_features";

export interface GenerateParams {
  method: GenerationMethod;
  /** Target set of videos (all videos, or [currentVideo]). */
  videos: Video[];
  /** stride/random per-video count (default 20). */
  perVideo?: number;
  /** Injectable RNG for random sampling (default Math.random). */
  sampleRng?: () => number;
  /** frame_chunk lower bound, 1-based (default 1). */
  frameFrom?: number;
  /** frame_chunk upper bound, 1-based inclusive (default 1000). */
  frameTo?: number;
  /** prediction_score: max score to count as "low" (default 3). */
  scoreLimit?: number;
  /** prediction_score: min qualified instances (default 1). */
  instanceLimitLower?: number;
  /** prediction_score: max qualified instances (default 2). */
  instanceLimitUpper?: number;
  /** velocity: skeleton node index for the displacement series (default 0). */
  nodeIdx?: number;
  /** velocity: relative threshold 0..1 (default 0.1). */
  threshold?: number;
  /** max_displacement: per-track mean-node displacement threshold (default 10). */
  displacementThreshold?: number;
  /** Global frame-range post-filter (1-based `frameFrom`, exclusive-ish upper). */
  frameRange?: { enabled: boolean; frameFrom: number; frameTo: number };
}

/**
 * Sampling kind for {@link sampleFrames}.
 *
 * `stride` and `random` are the PyQt ports. `spread` is ours: stratified
 * (jittered) sampling — see {@link sampleFrames} — for building a seeding pool
 * that covers the whole video without either clumping or aliasing.
 */
export type SamplingMethod = "stride" | "random" | "spread";

/** `len(video)` — frame count from the (already-probed) shape, or 0. */
function videoLength(video: Video): number {
  return video.shape?.[0] ?? 0;
}

/** Euclidean distance between two `[x, y]` points. */
function dist(a: number[], b: number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether an instance is a PredictedInstance with a numeric `.score`. */
function isScoredPredicted(inst: unknown): inst is { score: number } {
  return (
    inst instanceof PredictedInstance &&
    typeof (inst as { score: unknown }).score === "number"
  );
}

/**
 * frame_chunk (suggestions.py:351 `_n_chunk` / `_frame_increment`).
 *
 * For one video: 0-based `range(frameFrom-1, min(frameTo, len(video)))`.
 * `frameFrom > len(video)` -> [] (whole chunk past the end is skipped).
 * `frameFrom > frameTo` -> [].
 *
 * @param frameFrom 1-based inclusive lower bound.
 * @param frameTo   1-based inclusive upper bound.
 */
export function frameChunkFrames(
  video: Video,
  frameFrom: number,
  frameTo: number,
): number[] {
  if (frameFrom > frameTo) return [];
  const len = videoLength(video);
  if (frameFrom > len) return [];
  const start = frameFrom - 1; // to 0-based
  const end = Math.min(frameTo, len); // exclusive upper in 0-based range()
  const out: number[] = [];
  for (let f = start; f < end; f++) out.push(f);
  return out;
}

/**
 * prediction_score (suggestions.py:210 `prediction_score`).
 *
 * For each labeled frame of the video, count the scored PREDICTED instances
 * whose `.score <= scoreLimit` (`nQualified`). Include the frame iff
 * `lower <= nQualified <= upper`. Returns frame indices sorted ascending.
 * (Visibility is NOT enforced — qualification is by `instanceof
 * PredictedInstance` + a numeric `.score`, matching the data model where a
 * PredictedInstance always carries a frame-level score.)
 *
 * NOTE: PyQt's `get_instances_to_show` excludes USED predictions — a predicted
 * instance whose track is already covered by a user instance on that frame. This
 * port counts ALL scored `PredictedInstance`s, so it differs only in the rare
 * user+predicted-same-track case (where PyQt would drop the used prediction).
 * That refinement is intentionally deferred.
 */
export function predictionScoreFrames(
  labels: Labels,
  video: Video,
  scoreLimit: number,
  lower: number,
  upper: number,
): number[] {
  const out: number[] = [];
  for (const lf of labels.find({ video })) {
    let nQualified = 0;
    for (const inst of lf.instances) {
      if (isScoredPredicted(inst) && inst.score <= scoreLimit) nQualified++;
    }
    if (nQualified >= lower && nQualified <= upper) out.push(lf.frameIdx);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * velocity (suggestions.py:277 `velocity`).
 *
 * Uses the primary-node displacement series (anchor = `nodeIdx`) and applies a
 * RELATIVE threshold: with `vals = [...series.values()]`, `min = min(vals)` and
 * `range = max(vals) - min`, a frame qualifies when `(value - min) > range*thr`.
 *
 * NOTE: PyQt computes this over a DENSE per-frame array (`get_track_occupancy`
 * shifted), whereas `primaryPointDisplacementSeries` returns a SPARSE Map keyed
 * only on labeled frames. The min/range are therefore taken over the sparse
 * series' values; the relative-threshold semantics are preserved. Returns the
 * qualifying frame indices (Map keys) sorted ascending.
 */
export function velocityFrames(
  labels: Labels,
  video: Video,
  nodeIdx: number,
  threshold: number,
): number[] {
  const series = primaryPointDisplacementSeries(labels, video, "sum", nodeIdx);
  const vals = [...series.values()];
  if (vals.length === 0) return [];
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min;
  const out: number[] = [];
  for (const [frameIdx, value] of series) {
    if (value - min > span * threshold) out.push(frameIdx);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * max_displacement (suggestions.py:322 `frame_increment` / `max_displacement`).
 *
 * Builds the dense `(frames, tracks, nodes, [x,y])` array via `labels.numpy`,
 * then for each consecutive frame pair computes, per track, the nan-mean over
 * nodes of the per-node euclidean displacement. If ANY track's mean exceeds
 * `displacementThreshold`, the LATER frame index is included.
 *
 * `< 2` frames -> []. NaN nodes are skipped in the per-track mean; a track with
 * no comparable nodes contributes no qualifying displacement. Returns the
 * later-frame indices sorted ascending.
 *
 * NOTE: This detects jumps only between ADJACENT frame indices. `labels.numpy`
 * is a dense `0..maxFrame` array with unlabeled frames NaN-filled, so a jump
 * between two NON-adjacent labeled frames is not detected (the intervening
 * NaN rows break the consecutive diff). This matches PyQt's consecutive-row
 * diff — it is parity-correct, not a defect.
 */
export function maxDisplacementFrames(
  labels: Labels,
  video: Video,
  displacementThreshold: number,
): number[] {
  const arr = labels.numpy({ video });
  if (arr.length < 2) return [];
  const out: number[] = [];
  const nTracks = arr[0]?.length ?? 0;
  for (let f = 1; f < arr.length; f++) {
    let qualifies = false;
    for (let t = 0; t < nTracks; t++) {
      const cur = arr[f]?.[t];
      const prev = arr[f - 1]?.[t];
      if (!cur || !prev) continue;
      let sum = 0;
      let count = 0;
      const nNodes = Math.min(cur.length, prev.length);
      for (let n = 0; n < nNodes; n++) {
        const a = cur[n];
        const b = prev[n];
        if (!a || !b) continue;
        if (
          Number.isNaN(a[0]) ||
          Number.isNaN(a[1]) ||
          Number.isNaN(b[0]) ||
          Number.isNaN(b[1])
        ) {
          continue; // nan node -> excluded from the mean
        }
        sum += dist(a, b);
        count++;
      }
      if (count === 0) continue; // nan-mean of nothing -> NaN -> not > thr
      const meanDisp = sum / count;
      if (meanDisp > displacementThreshold) {
        qualifies = true;
        break;
      }
    }
    if (qualifies) out.push(f);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Candidate-range for sampling: `{ frameFrom, frameTo }` are 1-based; the
 * resulting 0-based inclusive candidate indices are `[frameFrom-1, frameTo-1]`.
 */
export interface CandidateRange {
  frameFrom: number;
  frameTo: number;
}

/**
 * stride/random sampling (suggestions.py:82 `basic_form` / `_strided_indices`).
 *
 * Candidate indices for the video are the candidate range (full
 * `0..len(video)-1`, or `frameFrom-1..frameTo-1` when `candidateRange` is set)
 * MINUS frame indices already present in `labels.suggestions` for that video.
 * Then:
 *  - `"stride"`: `inc = max(1, floor(n / perVideo))`; take
 *    `unique[0], unique[inc], unique[2*inc], …` capped at `perVideo`.
 *  - `"random"`: if `n <= perVideo`, return all candidates; otherwise pick
 *    `perVideo` UNIQUE indices using `rng` (default Math.random; expected to
 *    return `[0, 1)`). Deterministic given a deterministic `rng`.
 *  - `"spread"`: stratified/jittered — split the candidates into `perVideo`
 *    contiguous equal-width bins and take one random frame from each. Bins are
 *    disjoint and ascending, so the picks are unique and evenly distributed by
 *    construction. This is the sampler for building a LABELING pool: pure
 *    `random` clumps (a uniform draw leaves gaps and doubles up by chance, so a
 *    batch can over-sample one stretch of behavior), while pure `stride` is
 *    perfectly periodic and so aliases against anything periodic in the
 *    recording — a stimulus cycle, a rotating arena, a light flicker — sampling
 *    the same phase every time. Jittered bins give both properties: full
 *    coverage, no fixed period.
 *
 * `perVideo <= 0` -> []. Returned indices are sorted ascending.
 */
export function sampleFrames(
  labels: Labels,
  video: Video,
  perVideo: number,
  sampling: SamplingMethod,
  candidateRange: CandidateRange | null,
  rng: () => number = Math.random,
): number[] {
  const len = videoLength(video);
  if (len <= 0) return [];
  // A non-positive request samples nothing.
  if (perVideo <= 0) return [];

  // Candidate 0-based inclusive bounds.
  let lo = 0;
  let hi = len - 1;
  if (candidateRange) {
    lo = Math.max(0, candidateRange.frameFrom - 1);
    hi = Math.min(len - 1, candidateRange.frameTo - 1);
  }
  if (lo > hi) return [];

  // Exclude frames already suggested for this video.
  const existing = new Set<number>();
  for (const s of labels.suggestions ?? []) {
    if (s.video === video) existing.add(s.frameIdx);
  }

  const candidates: number[] = [];
  for (let f = lo; f <= hi; f++) {
    if (!existing.has(f)) candidates.push(f);
  }
  const n = candidates.length;
  if (n === 0) return [];

  if (sampling === "stride") {
    const inc = Math.max(1, Math.floor(n / perVideo));
    const out: number[] = [];
    for (let i = 0; i * inc < n && out.length < perVideo; i++) {
      out.push(candidates[i * inc]);
    }
    return out; // candidates are ascending, so out is ascending
  }

  if (sampling === "spread") {
    if (n <= perVideo) return [...candidates]; // already ascending
    // `n > perVideo`, so every bin is at least one candidate wide.
    const out: number[] = [];
    for (let i = 0; i < perVideo; i++) {
      const lo = Math.floor((i * n) / perVideo);
      const hi = Math.floor(((i + 1) * n) / perVideo); // exclusive
      // The clamp guards a pathological rng() === 1.0 (see below).
      out.push(candidates[Math.min(lo + Math.floor(rng() * (hi - lo)), hi - 1)]);
    }
    return out; // bins ascending + disjoint -> ascending + unique
  }

  // random
  if (n <= perVideo) return [...candidates]; // already ascending
  // Partial Fisher-Yates over a copy: pick `perVideo` unique indices.
  // `rng` is expected to return [0, 1); the Math.min clamp guards against a
  // pathological rng() === 1.0 that would otherwise index out of bounds.
  const pool = [...candidates];
  const picked: number[] = [];
  for (let i = 0; i < perVideo; i++) {
    const j = Math.min(
      i + Math.floor(rng() * (pool.length - i)),
      pool.length - 1,
    );
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
    picked.push(pool[i]);
  }
  picked.sort((a, b) => a - b);
  return picked;
}

/**
 * Split a TOTAL frame budget across videos, proportional to their lengths.
 *
 * `sampleFrames` is per-video by construction, so a caller that wants "N frames
 * for this project" (not "N frames per video") has to divide the budget first —
 * otherwise a 3-video project silently gets 3N. Longer videos earn more of the
 * budget, since they hold more distinct behavior to cover.
 *
 * Videos of unknown/zero length (an unprobed backend) get nothing — sampling
 * them would return [] anyway. Every video that CAN be sampled gets at least 1
 * whenever the budget allows, so a short video is still represented; the
 * leftover after flooring goes to the largest fractional shares
 * (largest-remainder), and if the min-1 floor overshoots — many very short
 * videos next to one long one — the largest allocations give frames back until
 * the total is exact.
 *
 * Returns one count per input video, in input order, summing to `total`
 * (or less only when there are more videos than frames to go around).
 */
export function allocateAcrossVideos(videos: Video[], total: number): number[] {
  const lengths = videos.map(videoLength);
  const out = lengths.map(() => 0);
  if (total <= 0) return out;

  const eligible = lengths
    .map((len, i) => ({ i, len }))
    .filter((e) => e.len > 0);
  if (eligible.length === 0) return out;

  // Fewer frames than videos: one each to the longest, rather than spreading so
  // thin that nothing gets a usable sample.
  if (total <= eligible.length) {
    const byLength = [...eligible].sort((a, b) => b.len - a.len || a.i - b.i);
    for (let k = 0; k < total; k++) out[byLength[k].i] = 1;
    return out;
  }

  const sumLen = eligible.reduce((s, e) => s + e.len, 0);
  const share = new Map<number, number>();
  for (const e of eligible) {
    const exact = (total * e.len) / sumLen;
    share.set(e.i, exact);
    out[e.i] = Math.max(1, Math.floor(exact));
  }
  let spent = out.reduce((s, n) => s + n, 0);

  // Hand out the flooring leftover, largest fractional part first.
  const byRemainder = [...eligible].sort((a, b) => {
    const fa = (share.get(a.i) ?? 0) % 1;
    const fb = (share.get(b.i) ?? 0) % 1;
    return fb - fa || a.i - b.i;
  });
  for (let k = 0; spent < total; k++, spent++) {
    out[byRemainder[k % byRemainder.length].i] += 1;
  }

  // Give back what the min-1 floor overshot, always from the largest allocation
  // and never below 1.
  while (spent > total) {
    let victim = -1;
    for (const e of eligible) {
      if (out[e.i] <= 1) continue;
      if (victim < 0 || out[e.i] > out[victim]) victim = e.i;
    }
    if (victim < 0) break; // every video is already at its floor of 1
    out[victim] -= 1;
    spent -= 1;
  }
  return out;
}

/**
 * Sample a TOTAL of `total` frames across `videos` — the project-wide flavor of
 * {@link sampleFrames}, splitting the budget with {@link allocateAcrossVideos}.
 *
 * Each video's own share still excludes frames already in `labels.suggestions`,
 * so calling this again ADDS a fresh batch that interleaves with the existing
 * pool instead of re-offering frames already queued. A video whose candidates
 * are exhausted simply contributes fewer than its share (the result can come in
 * under `total`); the budget is not redistributed.
 */
export function sampleFramesAcrossVideos(
  labels: Labels,
  videos: Video[],
  total: number,
  sampling: SamplingMethod,
  candidateRange: CandidateRange | null = null,
  rng: () => number = Math.random,
): SuggestionFrame[] {
  const budgets = allocateAcrossVideos(videos, total);
  const out: SuggestionFrame[] = [];
  videos.forEach((video, i) => {
    for (const frameIdx of sampleFrames(
      labels,
      video,
      budgets[i],
      sampling,
      candidateRange,
      rng,
    )) {
      out.push({ video, frameIdx } as SuggestionFrame);
    }
  });
  return out;
}

/** Frame-range descriptor used by the global post-filter and sampling. */
export interface FrameRange {
  enabled: boolean;
  frameFrom: number; // 1-based
  frameTo: number; // 1-based, treated as exclusive upper here
}

/**
 * Global frame-range post-filter (suggestions.py:67-75).
 *
 * When `enabled`, keep frames with `frameFrom-1 <= frameIdx < frameTo`
 * (0-based). When disabled, returns the input unchanged. Applies to
 * velocity/prediction_score/max_displacement only (the dispatcher excludes
 * frame_chunk and stride/random).
 */
export function applyFrameRangePostFilter(
  frames: number[],
  frameRange?: FrameRange,
): number[] {
  if (!frameRange || !frameRange.enabled) return frames;
  const lo = frameRange.frameFrom - 1;
  const hi = frameRange.frameTo;
  return frames.filter((f) => f >= lo && f < hi);
}

/**
 * Dispatch a generation method over the target `params.videos` and return a
 * deduped `SuggestionFrame[]`.
 *
 * - frame_chunk / stride / random are EXEMPT from the global frame-range
 *   post-filter (frame_chunk has its own bounds; sampling uses the range as a
 *   candidate window via `candidateRange`).
 * - velocity / prediction_score / max_displacement get the global
 *   frame-range post-filter applied.
 *
 * Frames are deduped per (video, frameIdx).
 */
export function generateSuggestionFrames(
  labels: Labels,
  params: GenerateParams,
): SuggestionFrame[] {
  const {
    method,
    videos,
    perVideo = 20,
    sampleRng = Math.random,
    frameFrom = 1,
    frameTo = 1000,
    scoreLimit = 3,
    instanceLimitLower = 1,
    instanceLimitUpper = 2,
    nodeIdx = 0,
    threshold = 0.1,
    displacementThreshold = 10,
    frameRange,
  } = params;

  const out: SuggestionFrame[] = [];
  // Dedupe per (video, frameIdx). Key on object identity so distinct videos
  // that aren't (yet) in labels.videos don't collide on a shared index of -1.
  const seen = new Map<Video, Set<number>>();
  const push = (video: Video, frameIdx: number) => {
    let frames = seen.get(video);
    if (!frames) {
      frames = new Set<number>();
      seen.set(video, frames);
    }
    if (frames.has(frameIdx)) return;
    frames.add(frameIdx);
    out.push({ video, frameIdx } as SuggestionFrame);
  };

  // Candidate range for stride/random: the frame range acts as a sampling
  // window (NOT a post-filter) when enabled.
  const candidateRange: CandidateRange | null =
    frameRange?.enabled
      ? { frameFrom: frameRange.frameFrom, frameTo: frameRange.frameTo }
      : null;

  for (const video of videos) {
    let frameIndices: number[];
    switch (method) {
      case "frame_chunk":
        frameIndices = frameChunkFrames(video, frameFrom, frameTo);
        break; // exempt from global post-filter
      case "stride":
        frameIndices = sampleFrames(
          labels,
          video,
          perVideo,
          "stride",
          candidateRange,
          sampleRng,
        );
        break; // exempt from global post-filter
      case "random":
        frameIndices = sampleFrames(
          labels,
          video,
          perVideo,
          "random",
          candidateRange,
          sampleRng,
        );
        break; // exempt from global post-filter
      case "prediction_score":
        frameIndices = applyFrameRangePostFilter(
          predictionScoreFrames(
            labels,
            video,
            scoreLimit,
            instanceLimitLower,
            instanceLimitUpper,
          ),
          frameRange,
        );
        break;
      case "velocity":
        frameIndices = applyFrameRangePostFilter(
          velocityFrames(labels, video, nodeIdx, threshold),
          frameRange,
        );
        break;
      case "max_displacement":
        frameIndices = applyFrameRangePostFilter(
          maxDisplacementFrames(labels, video, displacementThreshold),
          frameRange,
        );
        break;
      default:
        frameIndices = [];
    }
    for (const f of frameIndices) push(video, f);
  }

  return out;
}
