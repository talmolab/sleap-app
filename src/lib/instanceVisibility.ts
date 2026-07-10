/**
 * Pure per-instance visibility logic (no React/canvas deps), ported from
 * SLEAP PyQt `sleap/gui/state.py` (instance_visible / instance_shows_non_visible
 * / compute_qc_visibility). Single source of truth shared by the Instances panel
 * (which sets the state) and the overlay renderer (which applies it). Keyed by
 * instance OBJECT identity, matching upstream's `id(instance)`.
 */
import type { Instance } from "@/types";

export type QcMode =
  | "manual"
  | "selected_only"
  | "all_visible_only"
  | "all_plus_selected_invisible";

/** (label, mode) pairs — the View-panel Select and View menu both build from
 *  this one array so the two selectors cannot drift. */
export const QC_MODE_CHOICES: ReadonlyArray<readonly [string, QcMode]> = [
  ["Manual", "manual"],
  ["Only selected (with hidden points)", "selected_only"],
  ["All instances, visible points only", "all_visible_only"],
  ["All visible + selected hidden points", "all_plus_selected_invisible"],
] as const;

/** [visible, showOccluded] for one instance. */
export type QcVisibility = [visible: boolean, showOccluded: boolean];

/** The subset of store state the visibility predicates read. */
export interface VisibilitySlice {
  showInstances: boolean;
  hiddenInstances: Set<Instance>;
  viewOnlyInstance: Instance | null;
  showNonVisibleOverride: Map<Instance, boolean>;
}

/** Is the instance drawn at all? Global Hide wins; then view-only; then hidden set. */
export function instanceVisible(s: VisibilitySlice, instance: Instance): boolean {
  if (!s.showInstances) return false;
  if (s.viewOnlyInstance) return instance === s.viewOnlyInstance;
  return !s.hiddenInstances.has(instance);
}

/** Are the instance's occluded/NaN nodes drawn? Per-instance override beats global. */
export function instanceShowsNonVisible(
  s: Pick<VisibilitySlice, "showNonVisibleOverride">,
  instance: Instance,
  globalDefault: boolean,
): boolean {
  const v = s.showNonVisibleOverride.get(instance);
  return v === undefined ? globalDefault : v;
}

/**
 * Map a QC display mode + selection -> {instance: [visible, showOccluded]}.
 * Empty map = the "manual" sentinel (leave the per-instance transient state alone).
 * Global `globalShowNonVisible` is a MASTER GATE: occluded nodes only draw when it
 * is on. Selection-relative modes fall back to the first instance so the canvas
 * is never blank.
 */
export function computeQcVisibility(
  mode: QcMode,
  selected: Instance | null,
  instances: Instance[],
  globalShowNonVisible: boolean,
): Map<Instance, QcVisibility> {
  const out = new Map<Instance, QcVisibility>();
  if (mode === "manual") return out;

  let sel: Instance | null =
    selected && instances.includes(selected) ? selected : null;
  if (
    !sel &&
    instances.length > 0 &&
    (mode === "selected_only" || mode === "all_plus_selected_invisible")
  ) {
    sel = instances[0];
  }

  for (const inst of instances) {
    const isSel = inst === sel;
    const showSelOccluded = isSel && globalShowNonVisible;
    if (mode === "selected_only") out.set(inst, [isSel, showSelOccluded]);
    else if (mode === "all_visible_only") out.set(inst, [true, false]);
    else if (mode === "all_plus_selected_invisible")
      out.set(inst, [true, showSelOccluded]);
    else out.set(inst, [true, false]); // unknown mode -> safe "all visible"
  }
  return out;
}
