/**
 * Pure helpers for the "Merge into Project" feature (File ▸ Merge into Project…).
 *
 * Kept free of React / store / io-call side effects so they are unit-testable in
 * isolation. The actual merge runs through sleap-io.js `Labels.merge` in
 * {@link file://./../commands/mergeProjectCommands.ts}; the preview uses the
 * non-mutating `Labels.match`. This module only:
 *   - maps the dialog's strategy radio to io's `FrameStrategy` string,
 *   - summarizes a `MatchResult` into the preview panel's counts, and
 *   - formats a `MergeResult` into the result toast line.
 *
 * See docs / memory `project_merge_into_project_design` for the locked A2 scope.
 */

import type { MatchResult, MergeResult } from "@talmolab/sleap-io.js";

/** The four conflict-resolution choices the dialog exposes. */
export type MergeStrategyChoice = "smart" | "keep_both" | "new_wins" | "base_wins";

export interface MergeStrategyOption {
  value: MergeStrategyChoice;
  label: string;
  hint: string;
}

/** Radio options, in display order (Smart is the default/first). */
export const MERGE_STRATEGY_OPTIONS: MergeStrategyOption[] = [
  {
    value: "smart",
    label: "Smart / auto",
    hint: "Recommended — keep both unless they are the same instance",
  },
  { value: "keep_both", label: "Keep both", hint: "Keep every instance from both files" },
  { value: "new_wins", label: "New wins", hint: "On conflict, keep the incoming instance" },
  { value: "base_wins", label: "Base wins", hint: "On conflict, keep this project's instance" },
];

/**
 * Map a UI strategy choice to sleap-io.js's `FrameStrategy` string (the raw
 * value passed as `merge`'s `frame` option). "new/base wins" map to
 * keep_new/keep_original — on a per-frame conflict io keeps that side's
 * instance.
 */
export function mergeStrategyToFrameStrategy(choice: MergeStrategyChoice): string {
  switch (choice) {
    case "smart":
      return "auto";
    case "keep_both":
      return "keep_both";
    case "new_wins":
      return "keep_new";
    case "base_wins":
      return "keep_original";
  }
}

/** Structural preview derived from a non-mutating `Labels.match`. */
export interface MatchPreview {
  videosMatched: number;
  videosNew: number;
  /** Basenames of the incoming videos with no match (appended as new). */
  newVideoNames: string[];
  skeletonsMatched: number;
  skeletonsNew: number;
  tracksMatched: number;
  tracksNew: number;
  /** A2 locks: an unmatched skeleton BLOCKS the merge (no silent 2-skeleton project). */
  skeletonBlocked: boolean;
}

/** Basename of a Video filename (string, or first element of an image-seq list). */
function videoBasename(filename: unknown): string {
  const s = Array.isArray(filename)
    ? String(filename[0] ?? "")
    : String(filename ?? "");
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** Reduce a `MatchResult` to the dialog's preview counts. */
export function summarizeMatch(match: MatchResult): MatchPreview {
  return {
    videosMatched: match.nVideosMatched,
    videosNew: match.unmatchedVideos.length,
    newVideoNames: match.unmatchedVideos.map((v) =>
      videoBasename((v as { filename?: unknown }).filename)
    ),
    skeletonsMatched: match.nSkeletonsMatched,
    skeletonsNew: match.unmatchedSkeletons.length,
    tracksMatched: match.nTracksMatched,
    tracksNew: match.unmatchedTracks.length,
    skeletonBlocked: isMergeBlockedBySkeleton(match),
  };
}

/**
 * A2 rule: the incoming skeleton must match this project's structurally. An
 * unmatched skeleton would otherwise be appended as a SECOND skeleton (a
 * franken-project) under io's default CONTINUE error mode, so we block instead.
 * Node-union reconciliation (stock PyQt's behavior) is deferred.
 */
export function isMergeBlockedBySkeleton(match: MatchResult): boolean {
  return !match.allSkeletonsMatched;
}

/** Concise toast line summarizing a completed merge. */
export function mergeResultSummary(result: MergeResult): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  let msg = `Merged ${plural(result.instancesAdded, "instance")} across ${plural(
    result.framesMerged,
    "frame"
  )}`;
  if (result.conflicts.length > 0) {
    msg += `, ${plural(result.conflicts.length, "conflict")} resolved`;
  }
  if (result.errors.length > 0) {
    msg += `, ${plural(result.errors.length, "error")}`;
  }
  return `${msg}.`;
}
