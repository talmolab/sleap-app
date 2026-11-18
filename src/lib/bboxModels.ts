/**
 * Box-detector model family (sleap-nn >= 0.3.5): which head keys are box
 * detectors, and how a trained run's head is matched to a config slot.
 *
 * sleap-nn has two detector heads (`BBOX_MODEL_TYPES` in
 * sleap_nn/config/model_config.py), `bbox_centernet` and `bbox_ssd`. The app
 * treats them as one slot ("bbox") whose detector style is picked by preset,
 * so a slot's head type is sometimes a family rather than one head key:
 *
 * - `"bbox"`: either detector head.
 * - `"centered_instance_bbox"`: a centered-instance model that crops each
 *   animal to its box (`data_config.preprocessing.crop_mode: bbox`), the second
 *   stage of sleap-nn's `topdown_bbox_*` pipelines.
 * - `"centered_instance"`: a centered-instance model with fixed-size crops (the
 *   classic top-down second stage). A box-crop model can't follow a centroid
 *   model (sleap-nn: "Box-scaled crops need a stage 1 that reports boxes"), so
 *   the two are kept apart.
 *
 * Pure (no store / Tauri imports) so discovery and tests can use it.
 */

/** sleap-nn head keys of the box-detector family. */
export const BBOX_HEAD_KEYS = ["bbox_centernet", "bbox_ssd"] as const;

export type BboxHeadKey = (typeof BBOX_HEAD_KEYS)[number];

/** Whether a sleap-nn head key is a box detector. */
export function isBboxHeadKey(key: string | null | undefined): key is BboxHeadKey {
  return key === "bbox_centernet" || key === "bbox_ssd";
}

/** How a centered-instance model cuts its crops (`preprocessing.crop_mode`). */
export type CropMode = "fixed" | "bbox";

/**
 * The crop mode a training config's YAML (already parsed) sets. sleap-nn's
 * default, and the only option before 0.3.5, is `fixed`.
 */
export function cropModeOf(doc: unknown): CropMode {
  const pre = (doc as { data_config?: { preprocessing?: { crop_mode?: unknown } } } | null)
    ?.data_config?.preprocessing;
  return pre?.crop_mode === "bbox" ? "bbox" : "fixed";
}

/**
 * Whether a trained run (its active head key and, when known, its crop mode)
 * can fill a slot of `headType` — a real head key, or one of the families
 * above. `cropMode: null` means unknown and matches either centered-instance
 * kind.
 */
export function headTypeMatches(
  headType: string,
  run: { headKey: string | null; cropMode?: CropMode | null },
): boolean {
  const cropMode = run.cropMode ?? null;
  switch (headType) {
    case "bbox":
      return isBboxHeadKey(run.headKey);
    case "centered_instance_bbox":
      return run.headKey === "centered_instance" && cropMode !== "fixed";
    case "centered_instance":
      return run.headKey === "centered_instance" && cropMode !== "bbox";
    default:
      return run.headKey === headType;
  }
}
