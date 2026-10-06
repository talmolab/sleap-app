/**
 * Unit tests for the ZScore anomaly path of the QC detector (Phase 1).
 *
 * The ZScoreDetector sigmoid case is ported from github.com/alexwu-z/sleap-qc-webapp
 * (src/lib/qc/checks/checks.test.js), a lab JS port of Python `sleap.qc` intended
 * for integration into sleap-app. The remaining cases (cleanFeatureRow, the
 * 18-feature vector, fit-mask reference selection, scoreInstance, attribute-
 * Curvature) exercise the LabelQCDetector feature-assembly on a synthetic
 * skeleton + poses — the reference suite only covers these via a real .slp
 * fixture through the io adapter, which lands in the io-adapter step.
 *
 * GMM, frame-level checks, chirality, ordering and pose-split are Phase 2.
 */
import { describe, it, expect } from "../bun-test";
import {
  ZScoreDetector,
  cleanFeatureRow,
  LabelQCDetector,
  V3_FEATURE_NAMES,
} from "@/lib/analyze/qc/detector";
import { SkeletonAnalyzer } from "@/lib/analyze/qc/skeleton";
import { BASELINE_FEATURE_NAMES } from "@/lib/analyze/qc/baseline";
import type { Pose } from "@/lib/analyze/qc/util";

// 5-node chain 0-1-2-3-4; a maxChainLength of 5 turns the "auto" curvature on.
const N = 5;
const analyzer = () =>
  new SkeletonAnalyzer(N, [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
const cleanInstances = (): Pose[] =>
  Array.from({ length: 30 }, (_, t) =>
    Array.from({ length: N }, (_, i) => [
      i * 10 + Math.sin(t * 7 + i) * 0.3,
      Math.cos(t * 3 + i) * 0.3,
    ]),
  );
const chainPose = (): Pose => Array.from({ length: N }, (_, i) => [i * 10, 0]);

describe("ZScoreDetector", () => {
  it("maps max|z| through a sigmoid centered on the threshold", () => {
    const d = new ZScoreDetector(3.0).fit([[-1], [1]]); // mean 0, std 1
    expect(d.scoreOne([3])).toBeCloseTo(0.5, 6); // z = 3 = threshold -> 0.5
    expect(d.scoreOne([0])).toBeLessThan(0.1);
  });

  it("returns NaN for a vector containing NaN", () => {
    const d = new ZScoreDetector(3.0).fit([[-1], [1]]);
    expect(Number.isNaN(d.scoreOne([Number.NaN]))).toBe(true);
  });
});

describe("cleanFeatureRow", () => {
  it("maps NaN->0, +Inf->10, -Inf->-10, keeps finite", () => {
    expect(
      cleanFeatureRow([Number.NaN, Infinity, -Infinity, 2.5]),
    ).toEqual([0, 10, -10, 2.5]);
  });
});

describe("V3_FEATURE_NAMES", () => {
  it("names the 6 V3 features in order", () => {
    expect(V3_FEATURE_NAMES).toEqual([
      "max_curvature",
      "curvature_std",
      "visibility_pattern_score",
      "nn_distance",
      "hull_area_zscore",
      "hull_compactness",
    ]);
  });
});

describe("LabelQCDetector — feature assembly", () => {
  it("extractFeatures builds the 18-dim vector (12 baseline + 6 V3)", () => {
    const det = new LabelQCDetector().fitFeatures(cleanInstances(), analyzer());
    expect(det.featureNames).toEqual([
      ...BASELINE_FEATURE_NAMES,
      ...V3_FEATURE_NAMES,
    ]);
    expect(det.featureNames).toHaveLength(18);
    const v = det.extractFeatures(chainPose());
    expect(v).toHaveLength(18);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
  });

  it("fitFeatures with a mask fits on the subset but scores ALL instances", () => {
    const instances = cleanInstances();
    const n = instances.length;
    const mask = instances.map((_, i) => i % 2 === 0);
    const det = new LabelQCDetector().fitFeatures(instances, analyzer(), mask);
    expect(det.rawMatrix).toHaveLength(n); // scored over ALL
    expect(det.fitRows).toEqual(
      instances.map((_, i) => i).filter((i) => i % 2 === 0),
    );
    expect(det.fitRawMatrix).toHaveLength(det.fitRows.length);
    // null mask === all
    const all = new LabelQCDetector().fitFeatures(instances, analyzer(), null);
    expect(all.fitRows).toHaveLength(n);
  });

  it("scoreInstance returns a [0,1] score + contributions keyed by featureNames", () => {
    const det = new LabelQCDetector().fit({
      instances: cleanInstances(),
      analyzer: analyzer(),
    });
    const r = det.scoreInstance(chainPose());
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(Object.keys(r.contributions).sort()).toEqual(
      [...det.featureNames].sort(),
    );
  });

  it("a wildly off pose scores higher than a clean one", () => {
    const det = new LabelQCDetector().fit({
      instances: cleanInstances(),
      analyzer: analyzer(),
    });
    const clean = det.scoreInstance(chainPose()).score;
    const broken = chainPose();
    broken[0] = [-5000, 3000]; // yank a node far away
    expect(det.scoreInstance(broken).score).toBeGreaterThan(clean);
  });

  it("attributeCurvature blames the buckled joint when curvature is on", () => {
    const det = new LabelQCDetector().fitFeatures(cleanInstances(), analyzer());
    const pose = chainPose();
    pose[2] = [20, 30]; // buckle the 1-2-3 joint
    const a = det.attributeCurvature(pose);
    expect(a?.kind).toBe("angle");
    expect(a?.nodes[0]).toBe(2);
  });

  it("attributeCurvature is null for a short skeleton (curvature off)", () => {
    const shortAnalyzer = new SkeletonAnalyzer(3, [
      [0, 1],
      [1, 2],
    ]);
    const shortInstances: Pose[] = Array.from({ length: 20 }, () => [
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    const det = new LabelQCDetector().fitFeatures(shortInstances, shortAnalyzer);
    expect(det.attributeCurvature([[0, 0], [10, 0], [20, 5]])).toBeNull();
  });
});
