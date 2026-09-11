/**
 * QC engine configuration — defaults + "auto" feature toggles.
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp (`src/lib/qc/checks/config.js`,
 * itself a port of `sleap/qc/config.py`). Phase 1 consumes only the anomaly /
 * feature-vector fields; the GMM / duplicate / chain fields are carried for
 * fidelity and the Phase-2 detectors.
 */
export interface QcConfig {
  useGmm: boolean;
  /** "auto" => enable for chains >= 5 nodes. */
  useCurvature: boolean | "auto";
  /** "auto" => enable when symmetry pairs exist. */
  useSymmetry: boolean | "auto";
  /** "auto" => enable when symmetry pairs exist (skeleton or name-inferred). */
  useChirality: boolean | "auto";

  /** Anomaly flag threshold on `sigmoid(maxZ - 3)`. */
  instanceThreshold: number;
  duplicateIouThreshold: number;
  duplicateNodeOverlapRatio: number;
  duplicateNodeDistanceThreshold: number;

  gmmNComponents: number;
  gmmMinSamples: number;
  gmmPercentileThreshold: number;

  /**
   * Cap the fit/reference set (baseline stats, NN reference, GMM) on large files
   * — NN is O(ref²), so an uncapped reference makes huge datasets infeasible. All
   * instances are still scored against this sampled reference.
   */
  maxReferenceSize: number;

  /** Which instances define the "normal" reference: "all" labeled, or "user". */
  baselineSource: "all" | "user";

  /** User-declared ordered chains (node-name sequences) for chain-ordering. */
  orderedChains: string[][];
}

export function makeQCConfig(overrides: Partial<QcConfig> = {}): QcConfig {
  return {
    useGmm: true,
    useCurvature: "auto",
    useSymmetry: "auto",
    useChirality: "auto",

    instanceThreshold: 0.7,
    duplicateIouThreshold: 0.5,
    duplicateNodeOverlapRatio: 0.8,
    duplicateNodeDistanceThreshold: 10.0,

    gmmNComponents: 5,
    gmmMinSamples: 50,
    gmmPercentileThreshold: 5.0,

    maxReferenceSize: 4000,
    baselineSource: "all",
    orderedChains: [],
    ...overrides,
  };
}

export const shouldUseCurvature = (
  config: QcConfig,
  maxChainLength: number,
): boolean =>
  typeof config.useCurvature === "boolean"
    ? config.useCurvature
    : maxChainLength >= 5;
