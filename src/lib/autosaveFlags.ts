/**
 * Runtime feature flags for the incremental (diff-only) autosave.
 *
 * The incremental journal path is ON by default: autosave writes a full imageless
 * base snapshot plus an append-only delta journal, so a frame edit persists as a
 * tiny delta instead of a full rewrite. It can be turned OFF (reverting to a full
 * snapshot every tick) with a localStorage toggle (works in both the browser and
 * the Tauri WebView) — no rebuild needed:
 *
 *   localStorage.setItem("sleap.incrementalAutosave", "0")   // disable
 *   localStorage.removeItem("sleap.incrementalAutosave")     // back to default (on)
 *
 * The WRITE path is also capability-gated downstream (browser needs OPFS +
 * FileSystemFileHandle.createWritable — e.g. Safari falls back to no draft), so
 * this flag being on only means "use incremental where supported". Recovery
 * replay is unconditional (a journal on disk always represents unsaved work), and
 * a torn/absent base falls back to the retained previous base (.bak); with the
 * flag off no journal is written and replay of an absent journal is a no-op.
 */

/** localStorage key that opts a session OUT of incremental-autosave writes. */
export const INCREMENTAL_AUTOSAVE_FLAG_KEY = "sleap.incrementalAutosave";

/**
 * Whether this session should write incremental delta journals. Default ON;
 * only an explicit `"0"` opts out. Storage-denied (private mode) keeps the
 * default (on) — the write path is separately capability-gated, so this is safe.
 */
export function isIncrementalAutosaveEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(INCREMENTAL_AUTOSAVE_FLAG_KEY) !== "0";
  } catch {
    return true;
  }
}
