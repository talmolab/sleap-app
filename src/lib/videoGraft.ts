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
 * signature matches — or `null` when the original has no such video. Matches by
 * content (so a reorder still pairs correctly); each original is consumed at
 * most once (duplicate signatures pair first-come-first-served).
 */
export function buildBackendGraftPlan(
  draftSigs: string[],
  originalSigs: string[],
): (number | null)[] {
  const used = new Array<boolean>(originalSigs.length).fill(false);
  return draftSigs.map((sig) => {
    const idx = originalSigs.findIndex((s, i) => !used[i] && s === sig);
    if (idx === -1) return null;
    used[idx] = true;
    return idx;
  });
}
