/**
 * Training-dialog checks that mirror PyQt SLEAP's per-head form
 * (`sleap/gui/learning/dialog.py`, `TrainingEditorWidget`):
 *
 * - which heads crop around each animal (and so get the "Analyze Sizes..."
 *   button and the crop-size warnings), and
 * - which heads actually use negative (background) frames.
 *
 * Pure, so the dialog and the tests share one definition.
 */
import type { Labels } from "@talmolab/sleap-io.js";
import {
  computeInstanceSizeStats,
  resolveEffectiveCropSize,
  type CropSizeHyperparamsLike,
} from "@/lib/modelStats";

/** Heads that crop around each animal (PyQt: `head in ("centered_instance", "multi_class_topdown")`). */
const CROP_HEAD_TYPES = new Set(["centered_instance", "multi_class_topdown"]);

/** True for heads that train on crops around each animal. */
export function isCropHead(headType: string): boolean {
  return CROP_HEAD_TYPES.has(headType);
}

/**
 * True for heads where sleap-nn's `use_negative_frames` has an effect. The
 * cropping heads ignore negative frames (there is no animal to crop around),
 * so PyQt hides the two fields on those tabs (`_setup_negative_frames_visibility`).
 */
export function usesNegativeFrames(headType: string): boolean {
  return !CROP_HEAD_TYPES.has(headType);
}

/** Below this many pixels (after input scaling) centered-instance models do poorly. */
export const MIN_EFFECTIVE_CROP_PX = 100;

/**
 * The inline warnings PyQt shows for a cropping head
 * (`TrainingEditorWidget.get_config_warnings`):
 *
 * 1. the crop the model actually sees — crop size times input scaling — is
 *    under 100 px, and
 * 2. an explicit crop size is smaller than the largest labeled animal, so
 *    animals get cut off.
 *
 * Crop size is in original-image pixels (sleap-nn crops first, then resizes
 * by `scale`), so the "Auto" size used for check 1 is computed at scale 1.0
 * and then scaled, exactly like PyQt's `compute_crop_size_from_cfg`.
 * Returns `[]` for heads that don't crop and when there are no labels.
 */
export function cropSizeWarnings(
  headType: string,
  hp: CropSizeHyperparamsLike,
  labels: Labels | null,
): string[] {
  if (!isCropHead(headType) || !labels) return [];
  const warnings: string[] = [];

  const unscaledCrop =
    hp.cropSize ?? resolveEffectiveCropSize(labels, { ...hp, scale: 1.0 }).cropSize;
  if (unscaledCrop != null) {
    const effective = Math.floor(unscaledCrop * hp.scale);
    if (effective < MIN_EFFECTIVE_CROP_PX) {
      warnings.push(
        `The centered instance model's input crop will be only ${effective}px after input scaling, ` +
          "but these models perform poorly below 100px. Set Input Scaling to 1.0 and Crop Size to Auto.",
      );
    }
  }

  if (hp.cropSize != null) {
    const maxBbox = computeInstanceSizeStats(labels)?.maxBboxDim ?? 0;
    if (maxBbox > 0 && hp.cropSize < maxBbox) {
      warnings.push(
        `Crop size (${Math.floor(hp.cropSize)}px) is smaller than the largest labeled instance ` +
          `(${Math.round(maxBbox)}px), so instances will be clipped. Increase the crop size or set it to Auto.`,
      );
    }
  }

  return warnings;
}
