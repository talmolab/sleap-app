export type ExistingPredictionsMode = "clear_all" | "replace" | "keep";

/**
 * Merge mode for the Nth result of one multi-run inference. "Clear all" strips
 * every prediction project-wide, so only the first merge may do it — later ones
 * would wipe what the earlier runs just added.
 */
export function mergeModeForRun(
  mode: ExistingPredictionsMode,
  runIndex: number,
): ExistingPredictionsMode {
  return mode === "clear_all" && runIndex > 0 ? "replace" : mode;
}
