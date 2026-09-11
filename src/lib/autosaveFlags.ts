/**
 * Runtime feature flags for the incremental (diff-only) autosave.
 *
 * The incremental journal path is OFF by default — the autosave keeps writing a
 * full imageless base snapshot every tick (today's behavior) unless explicitly
 * opted in. Opt-in is a localStorage toggle (works in both the browser and the
 * Tauri WebView) so it can be flipped for manual E2E without a rebuild:
 *
 *   localStorage.setItem("sleap.incrementalAutosave", "1")   // enable
 *   localStorage.removeItem("sleap.incrementalAutosave")     // disable
 *
 * Recovery replay is unconditional (a journal on disk always represents unsaved
 * work), so this flag only gates the WRITE path — with the flag off no journal
 * is ever written, and replay of an absent journal is a harmless no-op.
 */

/** localStorage key that opts a session into incremental-autosave writes. */
export const INCREMENTAL_AUTOSAVE_FLAG_KEY = "sleap.incrementalAutosave";

/** Whether this session should write incremental delta journals (default off). */
export function isIncrementalAutosaveEnabled(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(INCREMENTAL_AUTOSAVE_FLAG_KEY) === "1"
    );
  } catch {
    // Private-mode / storage-denied → treat as off.
    return false;
  }
}
