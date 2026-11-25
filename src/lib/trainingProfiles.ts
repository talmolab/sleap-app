import baselineMediumRfCentroid from "@/assets/training_profiles/baseline_medium_rf.centroid.yaml?raw";
import baselineLargeRfCentroid from "@/assets/training_profiles/baseline_large_rf.centroid.yaml?raw";
import baselineMediumRfTopdown from "@/assets/training_profiles/baseline_medium_rf.topdown.yaml?raw";
import baselineLargeRfTopdown from "@/assets/training_profiles/baseline_large_rf.topdown.yaml?raw";
import baselineMediumRfBottomup from "@/assets/training_profiles/baseline_medium_rf.bottomup.yaml?raw";
import baselineLargeRfBottomup from "@/assets/training_profiles/baseline_large_rf.bottomup.yaml?raw";
import baselineMediumRfSingle from "@/assets/training_profiles/baseline_medium_rf.single.yaml?raw";
import baselineLargeRfSingle from "@/assets/training_profiles/baseline_large_rf.single.yaml?raw";
import baselineMultiClassBottomup from "@/assets/training_profiles/baseline.multi_class_bottomup.yaml?raw";
import baselineMultiClassTopdown from "@/assets/training_profiles/baseline.multi_class_topdown.yaml?raw";
import baselineBboxCenternet from "@/assets/training_profiles/baseline.bbox_centernet.yaml?raw";
import baselineBboxSsd from "@/assets/training_profiles/baseline.bbox_ssd.yaml?raw";
import baselineMediumRfTopdownBbox from "@/assets/training_profiles/baseline_medium_rf.topdown_bbox.yaml?raw";
import baselineLargeRfTopdownBbox from "@/assets/training_profiles/baseline_large_rf.topdown_bbox.yaml?raw";
import type { ModelType } from "@/stores/trainingStore";
import type { BackboneProfileRecommendation } from "@/lib/modelStats";

export interface BaselineProfile {
  filename: string;
  headType: string;
  /** Display label for config-picker dropdowns, e.g. "Preset: Centered Instance (Medium RF)". */
  label: string;
  content: string;
}

export const BASELINE_PROFILES: BaselineProfile[] = [
  { filename: "baseline_medium_rf.centroid.yaml", headType: "centroid", label: "Preset: Centroid (Medium RF)", content: baselineMediumRfCentroid },
  { filename: "baseline_large_rf.centroid.yaml", headType: "centroid", label: "Preset: Centroid (Large RF)", content: baselineLargeRfCentroid },
  { filename: "baseline_medium_rf.topdown.yaml", headType: "centered_instance", label: "Preset: Centered Instance (Medium RF)", content: baselineMediumRfTopdown },
  { filename: "baseline_large_rf.topdown.yaml", headType: "centered_instance", label: "Preset: Centered Instance (Large RF)", content: baselineLargeRfTopdown },
  { filename: "baseline_medium_rf.bottomup.yaml", headType: "bottomup", label: "Preset: Bottom-Up (Medium RF)", content: baselineMediumRfBottomup },
  { filename: "baseline_large_rf.bottomup.yaml", headType: "bottomup", label: "Preset: Bottom-Up (Large RF)", content: baselineLargeRfBottomup },
  { filename: "baseline_medium_rf.single.yaml", headType: "single_instance", label: "Preset: Single Instance (Medium RF)", content: baselineMediumRfSingle },
  { filename: "baseline_large_rf.single.yaml", headType: "single_instance", label: "Preset: Single Instance (Large RF)", content: baselineLargeRfSingle },
  { filename: "baseline.multi_class_bottomup.yaml", headType: "multi_class_bottomup", label: "Preset: Multi-Class Bottom-Up", content: baselineMultiClassBottomup },
  { filename: "baseline.multi_class_topdown.yaml", headType: "multi_class_topdown", label: "Preset: Multi-Class Top-Down", content: baselineMultiClassTopdown },
  // Box detectors: one "bbox" slot, the detector style picked by preset
  // (CenterNet first, so it's the default).
  { filename: "baseline.bbox_centernet.yaml", headType: "bbox", label: "Preset: Box Detector (CenterNet)", content: baselineBboxCenternet },
  { filename: "baseline.bbox_ssd.yaml", headType: "bbox", label: "Preset: Box Detector (SSD)", content: baselineBboxSsd },
  { filename: "baseline_medium_rf.topdown_bbox.yaml", headType: "centered_instance_bbox", label: "Preset: Centered Instance, Box Crops (Medium RF)", content: baselineMediumRfTopdownBbox },
  { filename: "baseline_large_rf.topdown_bbox.yaml", headType: "centered_instance_bbox", label: "Preset: Centered Instance, Box Crops (Large RF)", content: baselineLargeRfTopdownBbox },
];

/**
 * Map a (modelType, slot) pair to the headType used for baseline profile lookup.
 * Slot "centroid" maps directly. Slot "centered_instance" is the crop-stage
 * model of a two-stage pipeline: "centered_instance_bbox" (box crops) in a
 * top-down-box pipeline, "multi_class_topdown" (poses + identity) in a
 * top-down-ID pipeline, else "centered_instance"; slot "bbox" is the "bbox"
 * detector family (see lib/bboxModels.ts — match trained runs with
 * `headTypeMatches`). Slot "config" depends on the pipeline modelType.
 */
export function slotToHeadType(modelType: ModelType, slot: string): string {
  if (slot === "centroid") return "centroid";
  if (slot === "bbox") return "bbox";
  if (slot === "centered_instance") {
    if (modelType === "top_down_bbox") return "centered_instance_bbox";
    if (modelType === "top_down_id") return "multi_class_topdown";
    return "centered_instance";
  }
  // slot === "config" — map from the pipeline's model type
  switch (modelType) {
    case "single_animal":
      return "single_instance";
    case "bottom_up":
      return "bottomup";
    case "bottom_up_id":
      return "multi_class_bottomup";
    default:
      return slot;
  }
}

export function getBaselineProfilesForHead(headType: string): BaselineProfile[] {
  return BASELINE_PROFILES.filter((p) => p.headType === headType);
}

export function getDefaultProfileForHead(headType: string): BaselineProfile | undefined {
  return BASELINE_PROFILES.find((p) => p.headType === headType);
}

/**
 * Like getDefaultProfileForHead, but picks the Medium/Large RF variant based
 * on a size-derived recommendation (see recommendBackboneProfile in
 * modelStats.ts) instead of always defaulting to Medium. Head types with
 * only one profile (e.g. multi-class heads, which have no RF variants)
 * ignore the recommendation and fall back to the single available profile.
 */
export function getRecommendedProfileForHead(
  headType: string,
  recommendation: BackboneProfileRecommendation | null,
): BaselineProfile | undefined {
  const profiles = getBaselineProfilesForHead(headType);
  if (profiles.length <= 1) return profiles[0];
  const tier = recommendation?.tier ?? "medium";
  return profiles.find((p) => p.filename.includes(`${tier}_rf`)) ?? profiles[0];
}
