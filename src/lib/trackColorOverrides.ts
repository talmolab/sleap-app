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
