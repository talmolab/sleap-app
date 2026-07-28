/**
 * Pure matcher for the resume-after-close restore graft.
 *
 * Restore attaches the ORIGINAL file's image backends onto the draft's videos.
 * Doing that by array position is unsafe: if a video was removed/reordered since
 * the draft was saved (or the user re-picks a different file), position i no
 * longer refers to the same video, so the wrong images get grafted SILENTLY.
 *
 * Instead we match by a per-video SIGNATURE (identity). Each draft video is
 * paired with the original video that shares its signature; an unmatched draft
 * video gets no backend (blank frames + a warning) rather than the wrong one.
 */

/** The minimal video fields used to identify a video for grafting. `filename`
 *  is a string for regular/embedded videos and a string[] for image sequences. */
export interface VideoIdentity {
  filename?: string | string[] | null;
  /** `[frames, H, W, C]` (or a subset). Includes the frame count at [0], so the
   *  signature discriminates same-named videos of different length. */
  shape?: number[] | null;
}

/** Path-independent identity: `basename(filename) | shape`. Embedded videos may
 *  share a filename (".") so the shape (incl. frame count) adds discrimination;
 *  image sequences use the first frame's basename. */
export function videoSignature(v: VideoIdentity): string {
  const raw = Array.isArray(v.filename)
    ? (v.filename[0] ?? "")
    : (v.filename ?? "");
  const name = raw.split(/[\\/]/).pop() ?? "";
  const shape = Array.isArray(v.shape) ? v.shape.join("x") : "";
  return `${name}|${shape}`;
}

/**
 * For each draft video (by `draftSigs` index), the ORIGINAL video index whose
 * images should be grafted onto it — or `null` when there is no SAFE match.
 *
 * Two regimes, chosen so a mismatch never silently attaches the WRONG footage:
 *
 *  - IDENTICAL sets (same length, same signature at every position) — the common
 *    resume case: a 1:1 positional graft. This is exact even when several videos
 *    share a signature (embedded videos collapse to `.|<shape>`, so same-shape
 *    videos collide), because position pins identity when the sets are identical.
 *
 *  - DIVERGED sets (a video was added/removed/reordered before the draft was
 *    saved, or a different file was re-picked): match ONLY signatures that are
 *    globally unique on BOTH sides — those are unambiguous regardless of order.
 *    A signature that repeats on either side is ambiguous under divergence (a
 *    positional guess could graft the wrong video's images), so it returns `null`
 *    (→ blank frames + the caller's "couldn't match" warning) rather than guess.
 *
 * Each original is grafted onto at most one draft video.
 */
export function buildBackendGraftPlan(
  draftSigs: string[],
  originalSigs: string[],
): (number | null)[] {
  const identical =
    draftSigs.length === originalSigs.length &&
    draftSigs.every((s, i) => s === originalSigs[i]);
  if (identical) return draftSigs.map((_, i) => i);

  const count = (arr: string[], sig: string): number =>
    arr.reduce((n, s) => n + (s === sig ? 1 : 0), 0);
  return draftSigs.map((sig) => {
    // Only a signature that is unique on both sides is an unambiguous match.
    if (count(draftSigs, sig) !== 1 || count(originalSigs, sig) !== 1) return null;
    return originalSigs.indexOf(sig);
  });
}
