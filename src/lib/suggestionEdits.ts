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

/**
 * Return a NEW list = `existing` followed by the entries of `incoming` that
 * aren't already present (same video reference AND frameIdx) — also deduping
 * duplicates within `incoming`. Backs the "Add" (append) generation mode and
 * "Add all labeled frames". Neither input is mutated.
 */
export function mergeSuggestions(
  existing: readonly SuggestionFrame[],
  incoming: readonly SuggestionFrame[]
): SuggestionFrame[] {
  const out: SuggestionFrame[] = [...existing];
  for (const s of incoming) {
    if (!suggestionExists(out, s.video, s.frameIdx)) out.push(s);
  }
  return out;
}

/**
 * Return a NEW list with `list`'s elements in random order (Fisher–Yates),
 * driven by an injectable `rng` returning floats in [0, 1) (`Math.random`, or a
 * seeded {@link import("./seededRng").mulberry32} for reproducible tests).
 * Sequential suggestion order nudges users to over-label one video; shuffling
 * spreads the work. Input is not mutated.
 */
export function shuffleSuggestions(
  list: readonly SuggestionFrame[],
  rng: () => number
): SuggestionFrame[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Return a NEW list keeping only the suggestions `isLabeled` marks true — i.e.
 * drop suggestions for frames with no user labeling, keeping the annotated ones.
 * Input is not mutated.
 */
export function removeUnlabeledSuggestions(
  list: readonly SuggestionFrame[],
  isLabeled: (s: SuggestionFrame) => boolean
): SuggestionFrame[] {
  return list.filter(isLabeled);
}

/**
 * Map user-labeled frames to suggestion entries `{ video, frameIdx }`, dropping
 * predicted-only / empty frames (`isUserLabeled === false`). `labeledFrames` is
 * typically `labels.labeledFrames`; merge the result into the existing list to
 * "add all labeled frames to suggestions".
 */
export function userLabeledFramesAsSuggestions(
  labeledFrames: readonly {
    video: Video;
    frameIdx: number;
    isUserLabeled: boolean;
  }[]
): SuggestionFrame[] {
  return labeledFrames
    .filter((lf) => lf.isUserLabeled)
    .map((lf) => ({ video: lf.video, frameIdx: lf.frameIdx }) as SuggestionFrame);
}
