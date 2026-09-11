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
import { LabelQCDetector } from "./detector";
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
  /** Which instances of a frame to score (default: all). */
  getInstances?: (lf: LabeledFrame) => Instance[];
}

/** Fit the QC detector over `labels` and score every (selected) instance. */
export function scoreLabelsAnomaly(
  labels: Labels,
  { config = makeQCConfig(), getInstances }: AnomalyOptions = {},
): AnomalyResult {
  if (!labels.skeletons?.length)
    throw new Error("Labels must have at least one skeleton");
  const analyzer = analyzerFromSkeleton(labels.skeletons[0]);
  const pick = getInstances ?? ((lf: LabeledFrame) => lf.instances);
  const toPose = (inst: Instance): Pose => inst.numpy({ invisibleAsNaN: true });

  // Gather frames + a flat pose list in a stable order; the matrix row index
  // aligns with this flat order.
  const frames: { videoIdx: number; frameIdx: number; count: number }[] = [];
  const allPoses: Pose[] = [];
  labels.videos.forEach((video, videoIdx) => {
    for (const lf of labels.find({ video })) {
      const poses = pick(lf).map(toPose);
      frames.push({ videoIdx, frameIdx: lf.frameIdx, count: poses.length });
      allPoses.push(...poses);
    }
  });

  const det = new LabelQCDetector(config).fit({ instances: allPoses, analyzer });
  const scorer = det.detector; // set by fit()
  const { featureNames, rawMatrix, cleanMatrix } = det;

  const instances: AnomalyInstance[] = [];
  let row = 0;
  for (const f of frames) {
    for (let instIdx = 0; instIdx < f.count; instIdx++) {
      const s = scorer ? scorer.scoreOne(cleanMatrix[row]) : 0;
      const score = Number.isFinite(s) ? s : 0;
      const contributions: Record<string, number> = {};
      featureNames.forEach((n, j) => (contributions[n] = rawMatrix[row][j] ?? 0));
      instances.push({
        videoIdx: f.videoIdx,
        frameIdx: f.frameIdx,
        instIdx,
        score,
        confidence: confidence(score),
        topIssue: topIssue(contributions).issue,
        contributions,
      });
      row++;
    }
  }
  return { instances, featureNames };
}
