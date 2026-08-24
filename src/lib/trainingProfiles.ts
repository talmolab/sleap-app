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
import type { ModelType } from "@/stores/trainingStore";

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
];

/**
 * Map a (modelType, slot) pair to the headType used for baseline profile lookup.
 * Slots "centroid" and "centered_instance" map directly.
 * Slot "config" depends on the pipeline modelType.
 */
export function slotToHeadType(modelType: ModelType, slot: string): string {
  if (slot === "centroid") return "centroid";
  if (slot === "centered_instance") return "centered_instance";
  // slot === "config" — map from the pipeline's model type
  switch (modelType) {
    case "single_animal":
      return "single_instance";
    case "bottom_up":
      return "bottomup";
    case "bottom_up_id":
      return "multi_class_bottomup";
    case "top_down_id":
      return "multi_class_topdown";
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
