/**
 * Pure logic for the "Set Overlay Models" picker (#283): which head-type slots a
 * chosen pipeline needs, filtering the scanned model catalog per slot, validating
 * completeness, resolving the ordered model paths to hand to the sidecar, and the
 * user-facing reason a folder can't fill a slot.
 *
 * No Tauri / filesystem / React here — the dialog wires this to `readDir` +
 * {@link detectModelHead} and to `spawnOverlayServe`; this module is unit-tested
 * standalone (mirrors the `instanceSizeCore.ts` pattern).
 */

/** Overlay pipelines the picker offers. `bottom-up` is defined but disabled in the
 *  UI this round (needs a sidecar confmap path + PAF rendering). */
export type OverlayPipeline = "top-down" | "single-animal" | "bottom-up";

/** The ordered head slots each pipeline requires. Slot === required head key. */
export const PIPELINE_SLOTS: Record<OverlayPipeline, string[]> = {
  "top-down": ["centroid", "centered_instance"],
  "single-animal": ["single_instance"],
  "bottom-up": ["bottomup"],
};

/** A trained model discovered on disk (or via Browse…), classified by head. */
export interface ModelCatalogEntry {
  /** Absolute model-directory path (handed to the sidecar). */
  path: string;
  /** Display name (directory basename / run name). */
  runName: string;
  /** Head key from {@link detectModelHead}, e.g. "centroid". */
  head: string;
}

/** Slot head → chosen model path (undefined/"" = unfilled). */
export type OverlaySelection = Record<string, string | undefined>;

export interface SelectionValidation {
  complete: boolean;
  /** Slot heads still unfilled (empty when complete). */
  missing: string[];
}

/** Lowercase, human-readable noun for a head type (used in messages). */
export function headTypeLabel(head: string): string {
  switch (head) {
    case "centroid":
      return "centroid";
    case "centered_instance":
      return "centered-instance";
    case "single_instance":
      return "single-animal";
    case "bottomup":
      return "bottom-up";
    case "multi_class_bottomup":
      return "multi-class bottom-up";
    case "multi_class_topdown":
      return "multi-class top-down";
    default:
      return head.replace(/_/g, "-");
  }
}

/** Title-cased slot heading, e.g. "Centroid model". */
export function slotLabel(head: string): string {
  const l = headTypeLabel(head);
  return `${l.charAt(0).toUpperCase()}${l.slice(1)} model`;
}

/** Catalog entries whose head fits this slot. */
export function slotOptions(catalog: ModelCatalogEntry[], slotHead: string): ModelCatalogEntry[] {
  return catalog.filter((e) => e.head === slotHead);
}

/** Whether every required slot for `pipeline` holds a (non-empty) path. */
export function validateSelection(
  pipeline: OverlayPipeline,
  selection: OverlaySelection,
): SelectionValidation {
  const missing = PIPELINE_SLOTS[pipeline].filter((slot) => !selection[slot]);
  return { complete: missing.length === 0, missing };
}

/** Filled slot paths in canonical slot order (unfilled slots dropped). */
export function resolveModelPaths(
  pipeline: OverlayPipeline,
  selection: OverlaySelection,
): string[] {
  return PIPELINE_SLOTS[pipeline]
    .map((slot) => selection[slot])
    .filter((p): p is string => !!p);
}

/** Why a folder with head `folderHead` can't fill a `slotHead` slot; null if it fits. */
export function rejectReason(slotHead: string, folderHead: string | null): string | null {
  if (folderHead === null) return "Couldn't detect a model type in that folder.";
  if (folderHead === slotHead) return null;
  return `That's a ${headTypeLabel(folderHead)} model; this slot needs a ${headTypeLabel(slotHead)} model.`;
}
