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
  /** Optional explicit override: when true, the video is signed by SHAPE ALONE
   *  (see {@link videoSignature}). Usually inferred from a `.slp` container
   *  filename, so callers need not set it. */
  embedded?: boolean;
}

/**
 * Path-independent identity: `basename(filename) | shape` for external videos and
 * image sequences (their filename is a real, stable per-video name), but SHAPE
 * ALONE for EMBEDDED (pkg.slp) videos.
 *
 * Embedded videos have no per-video filename of their own — sleap-io resolves
 * `Video.filename` to the CONTAINING `.slp` file, which is the original pkg on a
 * fresh open but the OPFS labels-draft after a restore. Including that container
 * path would make the SAME video sign differently before vs. after a restore, so
 * a post-restore ⌘S records draft-prefixed signatures that no longer match the
 * re-opened original and restore aborts ("none of the draft's videos were
 * found"). We therefore drop the filename for embedded videos, keeping only the
 * shape (frames+H+W+C) — which round-trips identically. An embedded video is
 * detected by an explicit `embedded` flag OR a `.slp`/`.pkg.slp` container
 * filename (a real video/image name never has that extension).
 */
export function videoSignature(v: VideoIdentity): string {
  const raw = Array.isArray(v.filename)
    ? (v.filename[0] ?? "")
    : (v.filename ?? "");
  const name = raw.split(/[\\/]/).pop() ?? "";
  const shape = Array.isArray(v.shape) ? v.shape.join("x") : "";
  const isEmbedded = v.embedded === true || /\.slp$/i.test(name);
  return isEmbedded ? `|${shape}` : `${name}|${shape}`;
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
