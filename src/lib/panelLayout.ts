/**
 * Pure layout logic for the right sidebar panel strip (issue #135).
 *
 * This module is intentionally dependency-free (no React, no store, no panel
 * components) so it can be the single source of truth for the default panel
 * order and be unit-tested without a DOM. `appStore` and `AppShell` import
 * from here; the React descriptors live in `panelRegistry.tsx`.
 */

/**
 * Canonical default order and full membership of the sidebar panels. This is
 * the single source of truth: the store seeds `panelOrder` from it, "Reset to
 * defaults" restores it, and `reconcilePanelOrder` uses it to know which ids
 * are valid. A test asserts the `PANELS` registry's ids match this set exactly.
 */
export const DEFAULT_PANEL_ORDER = [
  "videos",
  "skeleton",
  "instances",
  "view",
  "suggestions",
  "frames",
  "training",
  "inference",
  "environment",
  "connect",
  "notifications",
  "debug",
] as const;

/**
 * Reconcile a persisted `panelOrder` against the current panel set: drop ids
 * that no longer exist and append any panels added since the blob was written.
 * Without this, a stored order from an older build silently hides newly-added
 * panels (the default zustand merge replaces the array wholesale).
 */
export function reconcilePanelOrder(stored?: readonly string[] | null): string[] {
  const known = new Set<string>(DEFAULT_PANEL_ORDER);
  const kept = (stored ?? []).filter((id) => known.has(id));
  const missing = DEFAULT_PANEL_ORDER.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

/** Drop unknown/duplicate ids from a persisted hidden-panels set. */
export function reconcileHiddenPanels(stored?: readonly string[] | null): string[] {
  const known = new Set<string>(DEFAULT_PANEL_ORDER);
  return [...new Set((stored ?? []).filter((id) => known.has(id)))];
}

/**
 * Move `fromId` to `toId`'s position within `order`, operating on the FULL
 * order by id. Callers must pass ids (not filtered render indices) — once the
 * strip hides panels, a rendered index no longer maps to a `panelOrder` index.
 * Returns a copy; a no-op (same id, or either id missing) returns order unchanged.
 */
export function reorderById(
  order: readonly string[],
  fromId: string,
  toId: string,
): string[] {
  if (fromId === toId) return [...order];
  const next = [...order];
  const from = next.indexOf(fromId);
  const to = next.indexOf(toId);
  if (from === -1 || to === -1) return [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The first visible panel in `order`, treating `excluding` as also hidden.
 * Used to auto-switch the active panel when the user hides the active one.
 * Returns null when nothing else is visible (the "allow empty" case).
 */
export function nextVisiblePanel(
  order: readonly string[],
  hidden: readonly string[],
  excluding: string,
): string | null {
  const hiddenSet = new Set(hidden);
  hiddenSet.add(excluding);
  return order.find((id) => !hiddenSet.has(id)) ?? null;
}
