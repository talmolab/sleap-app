/**
 * Phase-1 anomaly orchestrator: fit the QC detector over a whole `Labels` and
 * score every instance, emitting per-instance score + confidence + top-issue +
 * raw feature contributions.
 *
 * This is the app-facing entry point for the statistical Label-QC engine. It
 * mirrors the reference's `computeAnomalyUnit` path (github.com/alexwu-z/sleap-qc-webapp),
 * NOT the simpler `fitAndScoreLabels` path: instances are scored from the
 * pre-built feature matrix, whose fit rows carry leave-one-out nn-distances.
 * (`scoreInstance` re-extracts and would self-match every reference instance,
 * zeroing the nn_distance feature.) Pose extraction is the only io touch, via
 * `instance.numpy({ invisibleAsNaN: true })` — the engine's NaN=invisible
 * contract, which is also io 0.5.13's default.
 *
 * Frame-level checks (count/negative/duplicates), GMM, chirality, ordering and
 * pose-split are Phase 2.
 */
import type { Labels, LabeledFrame, Instance } from "@/types";
import {
  LabelQCDetector,
  yieldToEvent,
  type AsyncComputeOptions,
} from "./detector";
import { analyzerFromSkeleton } from "./skeletonIo";
import { makeQCConfig, type QcConfig } from "./config";
import { topIssue, confidence } from "./explain";
import type { Pose } from "./util";

/** One scored instance, keyed by (videoIdx, frameIdx, instIdx). */
export interface AnomalyInstance {
  videoIdx: number;
  frameIdx: number;
  instIdx: number;
  /** Anomaly score in [0,1] (sigmoid of max |z| across the 18 features). */
  score: number;
  confidence: "high" | "medium" | "low";
  /** Readable dominant issue (e.g. "Unusual joint angle"). */
  topIssue: string;
  /** Raw per-feature values, keyed by feature name (18 entries). */
  contributions: Record<string, number>;
}

export interface AnomalyResult {
  instances: AnomalyInstance[];
  featureNames: string[];
}

export interface AnomalyOptions {
  config?: QcConfig;
  /**
   * Which instances of a frame to score. Default: user (human-labeled)
   * instances only — QC targets labels, not predictions, matching PyQt's
   * `user_instances`. Pass a selector to override (e.g. to QC predictions).
   */
  getInstances?: (lf: LabeledFrame) => Instance[];
}

/** Evenly-spaced boolean mask selecting exactly `max` of `n` instances. */
function capReference(n: number, max: number): boolean[] {
  const out = new Array<boolean>(n).fill(false);
  const stride = n / max;
  for (let k = 0; k < max; k++) out[Math.floor(k * stride)] = true;
  return out;
}

interface FrameRef {
  videoIdx: number;
  frameIdx: number;
  count: number;
}

/** Walk the labels once: frames (in a stable order) + the flat pose list whose
 *  row order aligns with the feature matrix. Shared by the sync + async paths. */
function gather(
  labels: Labels,
  pick: (lf: LabeledFrame) => Instance[],
): { frames: FrameRef[]; allPoses: Pose[] } {
  const frames: FrameRef[] = [];
  const allPoses: Pose[] = [];
  labels.videos.forEach((video, videoIdx) => {
    for (const lf of labels.find({ video })) {
      const poses = pick(lf).map((inst) => inst.numpy({ invisibleAsNaN: true }));
      frames.push({ videoIdx, frameIdx: lf.frameIdx, count: poses.length });
      allPoses.push(...poses);
    }
  });
  return { frames, allPoses };
}

/** Turn one matrix row into a scored instance. Pure over a fitted detector. */
function scoreRow(
  det: LabelQCDetector,
  row: number,
  videoIdx: number,
  frameIdx: number,
  instIdx: number,
): AnomalyInstance {
  const s = det.detector ? det.detector.scoreOne(det.cleanMatrix[row]) : 0;
  const score = Number.isFinite(s) ? s : 0;
  const contributions: Record<string, number> = {};
  det.featureNames.forEach(
    (n, j) => (contributions[n] = det.rawMatrix[row][j] ?? 0),
  );
  return {
    videoIdx,
    frameIdx,
    instIdx,
    score,
    confidence: confidence(score),
    topIssue: topIssue(contributions).issue,
    contributions,
  };
}

/** Cap the fit reference on large files (NN is O(ref²)); null => score all as fit. */
function fitMaskFor(config: QcConfig, n: number): boolean[] | null {
  const max = config.maxReferenceSize ?? 4000;
  return n > max ? capReference(n, max) : null;
}

/** Fit the QC detector over `labels` and score every (selected) instance.
 *  Synchronous — fine for small projects and unit tests; large projects should
 *  use {@link scoreLabelsAnomalyAsync} to keep the UI responsive. */
export function scoreLabelsAnomaly(
  labels: Labels,
  { config = makeQCConfig(), getInstances }: AnomalyOptions = {},
): AnomalyResult {
  if (!labels.skeletons?.length)
    throw new Error("Labels must have at least one skeleton");
  const analyzer = analyzerFromSkeleton(labels.skeletons[0]);
  const pick = getInstances ?? ((lf: LabeledFrame) => lf.userInstances);
  const { frames, allPoses } = gather(labels, pick);

  const det = new LabelQCDetector(config).fit({
    instances: allPoses,
    analyzer,
    fitMask: fitMaskFor(config, allPoses.length),
  });

  const instances: AnomalyInstance[] = [];
  let row = 0;
  for (const f of frames)
    for (let instIdx = 0; instIdx < f.count; instIdx++)
      instances.push(scoreRow(det, row++, f.videoIdx, f.frameIdx, instIdx));
  return { instances, featureNames: det.featureNames };
}

/**
 * Chunked-async twin of {@link scoreLabelsAnomaly}: builds the feature matrix and
 * scores in batches that yield to the event loop, so the UI never freezes on a
 * large project. Reports progress (0..1) and honors an AbortSignal. Produces the
 * same instances/scores as the sync version.
 *
 * Phases (progress): pose gather is a short up-front pass (≈0–5%), the expensive
 * feature matrix (≈5–90%), then scoring (≈90–100%).
 */
export async function scoreLabelsAnomalyAsync(
  labels: Labels,
  {
    config = makeQCConfig(),
    getInstances,
    onProgress,
    signal,
    batchSize = 256,
  }: AnomalyOptions & AsyncComputeOptions = {},
): Promise<AnomalyResult> {
  if (!labels.skeletons?.length)
    throw new Error("Labels must have at least one skeleton");
  const analyzer = analyzerFromSkeleton(labels.skeletons[0]);
  const pick = getInstances ?? ((lf: LabeledFrame) => lf.userInstances);
  const { frames, allPoses } = gather(labels, pick);
  onProgress?.(0.05);

  const det = new LabelQCDetector(config);
  await det.fitFeaturesAsync(allPoses, analyzer, fitMaskFor(config, allPoses.length), {
    signal,
    batchSize,
    onProgress: (f) => onProgress?.(0.05 + f * 0.85),
  });
  det.fitZScore();

  const instances: AnomalyInstance[] = [];
  const n = allPoses.length || 1;
  let row = 0;
  for (const f of frames) {
    for (let instIdx = 0; instIdx < f.count; instIdx++) {
      if (signal?.aborted)
        throw new DOMException("QC analysis cancelled", "AbortError");
      instances.push(scoreRow(det, row++, f.videoIdx, f.frameIdx, instIdx));
      if (row % (batchSize * 8) === 0) {
        onProgress?.(0.9 + (row / n) * 0.1);
        await yieldToEvent();
      }
    }
  }
  onProgress?.(1);
  return { instances, featureNames: det.featureNames };
}
