/**
 * The QC verdict layer: turn raw feature contributions into a human-readable
 * "what does QC think is wrong" (top issue), plus confidence + top contributors.
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/explain.js`, itself a port of `sleap/qc/results.py`), a lab
 * JS port of Python `sleap.qc` intended for integration into sleap-app.
 */

/** Scale raw features to a comparable ~0-5 range before picking the dominant one. */
const SCALE_FACTORS: Record<string, number> = {
  max_centroid_distance: 30.0,
  centroid_distance_std: 10.0,
  nn_distance: 10.0,
  max_curvature: 1.0,
  curvature_std: 1.0,
  visibility_rate: 0.3,
  visibility_pattern_score: 0.3,
  has_isolated_invisible: 0.3,
  min_symmetry_consistency: 5.0,
};

const ISSUE_MAP: Record<string, string> = {
  max_edge_zscore: "Unusual edge length",
  mean_edge_zscore: "Unusual proportions",
  max_angle_zscore: "Unusual joint angle",
  mean_angle_zscore: "Unusual pose structure",
  max_pairwise_zscore: "Unusual node spacing",
  mean_pairwise_zscore: "Unusual scale",
  bbox_area_zscore: "Unusual scale",
  max_centroid_distance: "Isolated node",
  centroid_distance_std: "Inconsistent spacing",
  min_symmetry_consistency: "Likely L/R swap",
  visibility_rate: "Unusual visibility",
  has_isolated_invisible: "Isolated invisible node",
  visibility_pattern_score: "Unusual visibility pattern",
  nn_distance: "Unusual pose shape",
  max_curvature: "Unusual curvature",
  hull_area_zscore: "Unusual pose extent",
  pose_split_score: "Split pose / chimera",
};

/** The dominant feature -> issue label. */
export interface TopIssue {
  feature: string | null;
  issue: string;
}

/** The dominant feature -> issue label. Returns { feature, issue }. */
export function topIssue(
  contributions: Record<string, number> | null | undefined,
): TopIssue {
  const entries = contributions ? Object.entries(contributions) : [];
  if (!entries.length) return { feature: null, issue: "Unknown" };
  let best: string | null = null;
  let bestVal = -Infinity;
  for (const [feat, val] of entries) {
    // min_symmetry_consistency = 1.0 means "no symmetry info" -> ignore.
    const norm =
      feat === "min_symmetry_consistency" && val === 1.0
        ? 0
        : val / (SCALE_FACTORS[feat] ?? 1.0);
    if (norm > bestVal) {
      bestVal = norm;
      best = feat;
    }
  }
  return {
    feature: best,
    issue: best != null ? (ISSUE_MAP[best] ?? `High ${best}`) : "Unknown",
  };
}

/** The readable issue label for a single feature name (used for the GMM's worst-dimension). */
export const issueForFeature = (feature: string | null): string | null =>
  feature ? (ISSUE_MAP[feature] ?? `High ${feature}`) : null;

/**
 * Features whose dominant deviation is a *signed* z-score, so
 * "increased"/"decreased" (vs the learned mean) is meaningful. The area features
 * are signed directly in `contributions`; the max_* features are |z| there, so
 * their sign comes from `BaselineFeatureExtractor.attribute`.
 */
export const DIRECTIONAL_FEATURES = new Set<string>([
  "max_edge_zscore",
  "max_angle_zscore",
  "max_pairwise_zscore",
  "bbox_area_zscore",
  "hull_area_zscore",
]);

/** Append "(increased)"/"(decreased)" to a z-score issue when its direction is known. */
export function withDirection(issue: string, dir: number): string {
  if (!dir) return issue;
  return `${issue} (${dir > 0 ? "increased" : "decreased"})`;
}

/** Confidence bucket from the anomaly score (mirrors Python). */
export const confidence = (score: number): "high" | "medium" | "low" =>
  score > 0.8 ? "high" : score > 0.5 ? "medium" : "low";

/** Top-k contributing features (name, value), highest first. */
export const topContributions = (
  contributions: Record<string, number> | null | undefined,
  k = 3,
): [string, number][] =>
  Object.entries(contributions ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, k);
