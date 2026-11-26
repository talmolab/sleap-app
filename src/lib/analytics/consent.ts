/**
 * Whether usage data may be shared at all. Pure, and a leaf, so the menu, the
 * store and the client can all ask the same question the same way.
 *
 * Two independent gates, both of which must be open:
 *
 *   the user   `usageDataEnabled(preference)` — the Help ▸ Share Usage Data
 *              setting, defaulting to on unless the browser asks otherwise.
 *   the build  `analyticsAllowedInThisBuild()` — never from a dev server or an
 *              automated browser, whatever the setting says.
 */

/** The stored setting: `true`/`false` once the user has chosen, `null` before. */
export type UsageDataPreference = boolean | null;

interface TrackingSignals {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
}

/**
 * The browser is configured to ask sites not to track (Global Privacy Control,
 * or the older Do Not Track). Neither is a legal requirement for first-party
 * product analytics, but someone who set one has told us what they want, and
 * it costs nothing to listen.
 */
export function browserAsksNotToBeTracked(
  signals: TrackingSignals | undefined = typeof navigator !== "undefined"
    ? (navigator as unknown as TrackingSignals)
    : undefined,
): boolean {
  return signals?.globalPrivacyControl === true || signals?.doNotTrack === "1";
}

/**
 * Whether sharing is on for this user. An explicit choice always wins — in
 * either direction, so a user with Do Not Track set can still opt in. With no
 * choice made yet, sharing is on unless the browser asked not to be tracked.
 */
export function usageDataEnabled(
  preference: UsageDataPreference,
  signals?: TrackingSignals,
): boolean {
  return preference ?? !browserAsksNotToBeTracked(signals);
}

/** `localStorage` flag that turns reporting on in a dev build and logs every batch. */
export const DEBUG_FLAG = "sleap.analytics.debug";

export function analyticsDebugEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_FLAG) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether this build reports at all, regardless of the user's setting.
 *
 * Off under `bun run dev` / `bun run tauri:dev` (which is also how the
 * Playwright suite runs the app) and in any automated browser, so development
 * and test traffic never reaches the dataset. `DEV` is compared against `true`
 * for the reason given in lib/docsUrl.ts: `bun test` puts a string there.
 *
 * To exercise the real pipeline from a dev build, set
 * `localStorage["sleap.analytics.debug"] = "1"` and reload, usually together
 * with `VITE_ANALYTICS_URL` pointing at a local service.
 */
export function analyticsAllowedInThisBuild(): boolean {
  if (analyticsDebugEnabled()) return true;
  if (import.meta.env?.DEV === true) return false;
  if (typeof navigator !== "undefined" && navigator.webdriver === true) return false;
  return true;
}
