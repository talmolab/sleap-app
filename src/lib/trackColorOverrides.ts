/**
 * Per-track color overrides — pure helpers.
 *
 * Track color overrides are a LOCAL, per-project viewing preference (persisted
 * via the appStore `persist` whitelist, never written into the `.slp`). The
 * store holds them as `Record<projectKey, Record<trackName, hexColor>>`; these
 * helpers resolve the project key and the active override map.
 */

/** Stable empty map so an absent project's overrides keep a referentially
 * stable value (avoids churning React deps / redraw effects). */
export const EMPTY_TRACK_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Namespace key for a project's overrides. Desktop loads pass a real filesystem
 * path (unique); browser loads pass only a filename (see loadProject.ts). Falls
 * back to a shared sentinel for a never-saved project. Empty strings count as
 * absent. The token-bearing `?open=<url>` is intentionally NOT used as a key.
 */
export function resolveProjectKey(
  projectPath: string | null | undefined,
  filename: string | null | undefined,
): string {
  return projectPath || filename || "__unsaved__";
}

/**
 * The active project's override map (track name → hex), or a stable empty map.
 */
export function getActiveTrackOverrides(
  overrides: Record<string, Record<string, string>> | null | undefined,
  projectPath: string | null | undefined,
  filename: string | null | undefined,
): Record<string, string> {
  if (!overrides) return EMPTY_TRACK_OVERRIDES;
  return overrides[resolveProjectKey(projectPath, filename)] ?? EMPTY_TRACK_OVERRIDES;
}

/** Max number of projects whose overrides are retained (LRU by recency). */
export const MAX_TRACK_COLOR_PROJECTS = 50;

/**
 * Immutably set `trackName`'s override to `hex` under `projectKey`, bumping that
 * project to most-recent (last key) so the LRU cap evicts genuinely stale
 * projects first. See {@link capTrackColorOverrides}.
 */
export function setTrackColorOverride(
  overrides: Record<string, Record<string, string>>,
  projectKey: string,
  trackName: string,
  hex: string,
): Record<string, Record<string, string>> {
  const { [projectKey]: existing, ...rest } = overrides;
  return {
    ...rest,
    [projectKey]: { ...(existing ?? {}), [trackName]: hex },
  };
}

/**
 * Immutably move a track's override from `oldName` to `newName` (used when a
 * track is renamed, so its color follows). The renamed track's color wins if
 * `newName` already had one. No-op (same reference) when `oldName` has none.
 */
export function renameTrackColorOverride(
  overrides: Record<string, Record<string, string>>,
  projectKey: string,
  oldName: string,
  newName: string,
): Record<string, Record<string, string>> {
  const submap = overrides[projectKey];
  if (!submap || !(oldName in submap)) return overrides;
  const nextSub = { ...submap };
  const val = nextSub[oldName];
  delete nextSub[oldName];
  nextSub[newName] = val;
  return { ...overrides, [projectKey]: nextSub };
}

/**
 * Immutably drop overrides for track names not in `validNames` (used on project
 * load to clear entries for deleted tracks). Drops the project entry when empty.
 * No-op (same reference) when nothing needs pruning or the project is absent.
 */
export function pruneTrackColorOverrides(
  overrides: Record<string, Record<string, string>>,
  projectKey: string,
  validNames: readonly string[],
): Record<string, Record<string, string>> {
  const submap = overrides[projectKey];
  if (!submap) return overrides;
  const valid = new Set(validNames);
  const kept: Record<string, string> = {};
  let removed = false;
  for (const [name, hex] of Object.entries(submap)) {
    if (valid.has(name)) kept[name] = hex;
    else removed = true;
  }
  if (!removed) return overrides;
  const next = { ...overrides };
  if (Object.keys(kept).length === 0) delete next[projectKey];
  else next[projectKey] = kept;
  return next;
}

/**
 * Immutably keep only the most-recent `cap` projects (by key order, which
 * {@link setTrackColorOverride} maintains as recency), evicting the oldest.
 * No-op (same reference) when under the cap.
 */
export function capTrackColorOverrides(
  overrides: Record<string, Record<string, string>>,
  cap: number = MAX_TRACK_COLOR_PROJECTS,
): Record<string, Record<string, string>> {
  const keys = Object.keys(overrides);
  if (keys.length <= cap) return overrides;
  const keep = keys.slice(keys.length - cap);
  const next: Record<string, Record<string, string>> = {};
  for (const k of keep) next[k] = overrides[k];
  return next;
}

/**
 * Immutably remove `trackName`'s override under `projectKey`. Drops the project
 * entry entirely once its last override is removed. No-op (returns the same
 * reference) when the entry is absent.
 */
export function resetTrackColorOverride(
  overrides: Record<string, Record<string, string>>,
  projectKey: string,
  trackName: string,
): Record<string, Record<string, string>> {
  const submap = overrides[projectKey];
  if (!submap || !(trackName in submap)) return overrides;
  const nextSub = { ...submap };
  delete nextSub[trackName];
  const next = { ...overrides };
  if (Object.keys(nextSub).length === 0) {
    delete next[projectKey];
  } else {
    next[projectKey] = nextSub;
  }
  return next;
}
