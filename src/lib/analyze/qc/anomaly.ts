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
 * Two statistical scores per instance, each with its own flag threshold (as in
 * the reference): the ZScore anomaly score (flag ≥ 0.7), and, once there are at
 * least 50 reference poses, the GMM score (flag ≥ 0.95, the least typical 5%).
 * {@link anomalyVerdict} combines them. Frame-level checks, chirality, ordering
 * and pose-split live in the rule-based labelQc.ts, not here.
 */
import type { Labels, LabeledFrame, Instance } from "@/types";
import {
  LabelQCDetector,
  yieldToEvent,
  type AsyncComputeOptions,
} from "./detector";
import { analyzerFromSkeleton } from "./skeletonIo";
import { makeQCConfig, type QcConfig } from "./config";
import { topIssue, confidence, issueForFeature, DIRECTIONAL_FEATURES } from "./explain";
import type { AttributionEntry } from "./baseline";
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
  /**
   * Skeleton node indices behind `topIssue` (an edge's two ends, a joint and
   * its two neighbors, a swapped L/R pair, an isolated node…), for the canvas
   * to circle. Empty when the dominant feature isn't about particular nodes
   * (visibility rate, bounding-box size, distance to the nearest pose).
   */
  issueNodes: number[];
  /**
   * How to draw `issueNodes`: "edge" = the two nodes' connecting line,
   * "angle" = the joint `issueNodes[0]` and its arms to `[1]` and `[2]`,
   * "node" = ring each node. null when `issueNodes` is empty.
   */
  issueKind: "edge" | "angle" | "node" | null;
  /**
   * Whether the measurement behind `topIssue` is larger (+1) or smaller (-1)
   * than in the other labels; 0 when unknown or not meaningful.
   */
  issueDir: number;
  /** Raw per-feature values, keyed by feature name (18 entries). */
  contributions: Record<string, number>;
  /**
   * GMM score in [0,1]: the share of reference poses more typical than this one.
   * null when the GMM didn't run (fewer than 50 reference poses, or disabled).
   */
  gmmScore: number | null;
  /** "Improbable pose · <issue>" when the GMM flags this instance, else null. */
  gmmIssue: string | null;
  /** Skeleton node index the GMM blames when it flags this instance; -1 if none; null otherwise. */
  gmmNode: number | null;
}

export interface AnomalyResult {
  instances: AnomalyInstance[];
  featureNames: string[];
  /** GMM flag threshold (e.g. 0.95); null when the GMM didn't run. */
  gmmThreshold: number | null;
}

/** How one instance reads once both scores are combined. */
export interface AnomalyVerdict {
  flagged: boolean;
  /** Which check(s) flagged it. */
  by: "anomaly" | "gmm" | "both" | null;
  /** The higher of the scores that cleared their thresholds (else the anomaly score). */
  score: number;
  confidence: "high" | "medium" | "low";
  issue: string;
}

/**
 * Combine the anomaly and GMM scores, as the reference's sidebar does: an
 * instance is flagged if either clears its own threshold. The issue comes from
 * the anomaly explanation when the anomaly check fired, otherwise from the GMM.
 */
export function anomalyVerdict(
  a: AnomalyInstance,
  anomalyThreshold: number,
  gmmThreshold: number | null,
): AnomalyVerdict {
  const aFlag = a.score >= anomalyThreshold;
  const gFlag = gmmThreshold != null && a.gmmScore != null && a.gmmScore >= gmmThreshold;
  const by = aFlag && gFlag ? "both" : aFlag ? "anomaly" : gFlag ? "gmm" : null;
  const score = Math.max(aFlag ? a.score : 0, gFlag ? (a.gmmScore as number) : 0) || a.score;
  return {
    flagged: aFlag || gFlag,
    by,
    score,
    confidence: confidence(score),
    issue: !aFlag && gFlag ? (a.gmmIssue ?? "Improbable pose") : a.topIssue,
  };
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

/** GMM score, issue and blamed node for one matrix row. */
function scoreGmmRow(
  det: LabelQCDetector,
  row: number,
  pose: Pose,
): Pick<AnomalyInstance, "gmmScore" | "gmmIssue" | "gmmNode"> {
  const gmm = det.gmm;
  if (!gmm) return { gmmScore: null, gmmIssue: null, gmmNode: null };
  const clean = det.cleanMatrix[row];
  const s = gmm.scoreOne(clean);
  const gmmScore = Number.isFinite(s) ? s : 0;
  if (gmmScore < gmm.flagThreshold) return { gmmScore, gmmIssue: null, gmmNode: null };
  // Flagged: name the feature it finds most off, and the node whose removal helps most.
  const feature = det.featureNames[gmm.worstFeature(clean).index] ?? null;
  const sub = issueForFeature(feature);
  const nn = det.rawMatrix[row][det.featureNames.indexOf("nn_distance")] ?? null;
  return {
    gmmScore,
    gmmIssue: sub ? `Improbable pose · ${sub}` : "Improbable pose",
    gmmNode: det.gmmWorstNode(pose, nn),
  };
}

/** The nodes behind the dominant feature of a pose, how to draw them, and the direction. */
function issueFor(
  det: LabelQCDetector,
  pose: Pose,
  feature: string | null,
  contributions: Record<string, number>,
): Pick<AnomalyInstance, "issueNodes" | "issueKind" | "issueDir"> {
  if (!feature) return { issueNodes: [], issueKind: null, issueDir: 0 };
  let entry: AttributionEntry | null | undefined;
  try {
    entry =
      feature === "max_curvature"
        ? det.attributeCurvature(pose)
        : (det.baseline.attribute(pose) as Record<string, AttributionEntry | undefined>)[feature];
  } catch {
    entry = null;
  }
  const nodes = entry?.nodes ?? [];
  return {
    issueNodes: nodes,
    issueKind: nodes.length === 0 ? null : (entry?.kind ?? "node"),
    // The max_* features carry their sign on the attribution, the area ones in
    // `contributions`. (A curvature's sign is which way it bends: not here.)
    issueDir: DIRECTIONAL_FEATURES.has(feature)
      ? Math.sign(entry?.dir ?? contributions[feature] ?? 0) || 0
      : 0,
  };
}

/** Turn one matrix row into a scored instance. Pure over a fitted detector. */
function scoreRow(
  det: LabelQCDetector,
  row: number,
  pose: Pose,
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
  const top = topIssue(contributions);
  return {
    videoIdx,
    frameIdx,
    instIdx,
    score,
    confidence: confidence(score),
    topIssue: top.issue,
    ...issueFor(det, pose, top.feature, contributions),
    contributions,
    ...scoreGmmRow(det, row, pose),
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
    for (let instIdx = 0; instIdx < f.count; instIdx++, row++)
      instances.push(scoreRow(det, row, allPoses[row], f.videoIdx, f.frameIdx, instIdx));
  return { instances, featureNames: det.featureNames, gmmThreshold: det.gmm?.flagThreshold ?? null };
}

/**
 * Chunked-async twin of {@link scoreLabelsAnomaly}: builds the feature matrix and
 * scores in batches that yield to the event loop, so the UI never freezes on a
 * large project. Reports progress (0..1) and honors an AbortSignal. Produces the
 * same instances/scores as the sync version.
 *
 * Phases (progress): pose gather is a short up-front pass (≈0–5%), the expensive
 * feature matrix (≈5–80%), the GMM fit (≈80–90%, only with 50+ reference poses),
 * then scoring (≈90–100%).
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
    onProgress: (f) => onProgress?.(0.05 + f * 0.75),
  });
  det.fitZScore();
  await det.fitGmmAsync({ signal, onProgress: (f) => onProgress?.(0.8 + f * 0.1) });

  const instances: AnomalyInstance[] = [];
  const n = allPoses.length || 1;
  let row = 0;
  for (const f of frames) {
    for (let instIdx = 0; instIdx < f.count; instIdx++) {
      if (signal?.aborted)
        throw new DOMException("QC analysis cancelled", "AbortError");
      instances.push(scoreRow(det, row, allPoses[row], f.videoIdx, f.frameIdx, instIdx));
      row++;
      if (row % (batchSize * 8) === 0) {
        onProgress?.(0.9 + (row / n) * 0.1);
        await yieldToEvent();
      }
    }
  }
  onProgress?.(1);
  return { instances, featureNames: det.featureNames, gmmThreshold: det.gmm?.flagThreshold ?? null };
}
