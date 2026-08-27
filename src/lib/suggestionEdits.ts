/**
 * Pure, React-free helpers for editing a suggestion list (#159).
 *
 * `labels.suggestions` is a plain `SuggestionFrame[]`, used structurally as
 * `{ video, frameIdx }`. These helpers never mutate their input; the
 * list-returning functions always return a new array. Videos are compared by
 * reference (`===`) and frame indices by `===`.
 */

import type { SuggestionFrame, Video } from "../types";

/** True if `list` already has a suggestion for this exact (video, frameIdx). */
export function suggestionExists(
  list: readonly SuggestionFrame[],
  video: Video,
  frameIdx: number
): boolean {
  return list.some((s) => s.video === video && s.frameIdx === frameIdx);
}

/**
 * Return a NEW list with { video, frameIdx } appended — unless it already exists
 * (same video reference AND same frameIdx), in which case return a shallow copy
 * unchanged. The appended entry is constructed as `{ video, frameIdx }`.
 */
export function addSuggestionFrame(
  list: readonly SuggestionFrame[],
  video: Video,
  frameIdx: number
): SuggestionFrame[] {
  if (suggestionExists(list, video, frameIdx)) return [...list];
  return [...list, { video, frameIdx } as SuggestionFrame];
}

/** Return a NEW list with the element at `idx` removed; out-of-range idx → shallow copy unchanged. */
export function removeSuggestionAt(
  list: readonly SuggestionFrame[],
  idx: number
): SuggestionFrame[] {
  if (idx < 0 || idx >= list.length) return [...list];
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}

/**
 * Return a NEW list = `existing` with every entry from `generated` appended,
 * skipping any (video, frameIdx) pair already present -- whether that's in
 * `existing` already, or a duplicate within `generated` itself. Used so
 * re-running "Generate" (or generating with a different method/target)
 * accumulates onto whatever suggestions the user already has (manually added
 * ones included) instead of silently discarding them.
 */
export function mergeSuggestionFrames(
  existing: readonly SuggestionFrame[],
  generated: readonly SuggestionFrame[]
): SuggestionFrame[] {
  const merged = [...existing];
  for (const s of generated) {
    if (!suggestionExists(merged, s.video, s.frameIdx)) {
      merged.push(s);
    }
  }
  return merged;
}

export interface LabeledSummary {
  labeled: number;
  total: number;
  pct: number;
}

/**
 * total = flags.length; labeled = count of true;
 * pct = total ? (labeled / total) * 100 : 0 (NOT pre-rounded).
 */
export function labeledSummary(flags: readonly boolean[]): LabeledSummary {
  const total = flags.length;
  let labeled = 0;
  for (const f of flags) if (f) labeled++;
  const pct = total ? (labeled / total) * 100 : 0;
  return { labeled, total, pct };
}
