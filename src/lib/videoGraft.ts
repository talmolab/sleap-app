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
  /** Sorted, de-duplicated embedded frame numbers (sleap-io
   *  `Video.embeddedFrameIndices`), or `null`/omitted for an external video or a
   *  closed/lazy backend. Drives the frame-index digest that hardens the
   *  otherwise shape-only embedded signature — see {@link videoSignature}. */
  embeddedFrameIndices?: number[] | null;
  /** Provenance hint: the SOURCE video's filename (sleap-io
   *  `Video.originalVideo?.filename`). SECONDARY only — verified unreliable in
   *  triage (it can be the CONTAINER path when the source filename is "."), so
   *  the frame-index digest is the primary discriminator and a "." / `.slp`
   *  container value here is dropped. */
  sourceName?: string | string[] | null;
}

/** Section separator for the optional discriminators appended to an embedded
 *  signature. `::` never occurs in a shape string (`NxNxN…`) and external
 *  signatures never carry sections, so it splits base ⇄ discriminators cleanly. */
const SIG_SEP = "::";

/**
 * Cheap, stable digest of a sorted embedded frame-index SET: `count.first.last.hash`
 * where `hash` is a 32-bit FNV-1a rolling hash over the indices. Two videos with
 * the SAME embedded frames produce the SAME digest; any change to the count or the
 * membership changes it (with overwhelming probability). Returns `null` for an
 * empty/absent set so the caller can fall back to a shape-only signature.
 *
 * `Video.embeddedFrameIndices` is already sorted+de-duplicated, so the digest is
 * order-canonical and round-trips identically across save → restore.
 */
export function frameIndexDigest(
  indices: readonly number[] | null | undefined,
): string | null {
  if (!indices || indices.length === 0) return null;
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (const n of indices) {
    const v = n | 0;
    h = Math.imul(h ^ (v & 0xffff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xffff), 0x01000193);
  }
  const hash = (h >>> 0).toString(36);
  return `${indices.length}.${indices[0]}.${indices[indices.length - 1]}.${hash}`;
}

/** The SOURCE video's basename when it is a real per-video name, else `null`.
 *  Drops "." (sleap-io resolves it to the CONTAINER path) and any `.slp`/`.pkg.slp`
 *  container — neither is a trustworthy provenance discriminator. */
function realSourceBasename(raw?: string | string[] | null): string | null {
  const s = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const name = s.split(/[\\/]/).pop() ?? "";
  if (!name || name === "." || /\.slp$/i.test(name)) return null;
  return name;
}

/**
 * Path-independent identity: `basename(filename) | shape` for external videos and
 * image sequences (their filename is a real, stable per-video name), but for
 * EMBEDDED (pkg.slp) videos a shape-only base HARDENED with a frame-index digest
 * (and an optional source-name hint).
 *
 * Embedded videos have no per-video filename of their own — sleap-io resolves
 * `Video.filename` to the CONTAINING `.slp` file, which is the original pkg on a
 * fresh open but the OPFS labels-draft after a restore. Including that container
 * path would make the SAME video sign differently before vs. after a restore, so
 * a post-restore ⌘S records draft-prefixed signatures that no longer match the
 * re-opened original and restore aborts ("none of the draft's videos were
 * found"). We therefore drop the filename for embedded videos, keeping the shape
 * (frames+H+W+C) — which round-trips identically. An embedded video is detected
 * by an explicit `embedded` flag OR a `.slp`/`.pkg.slp` container filename (a
 * real video/image name never has that extension).
 *
 * Shape alone is DANGEROUSLY weak on the null-handle re-pick / graft path: a user
 * picking the WRONG file with the SAME dimensions would sign identically and get
 * silently-wrong footage. So an embedded signature ALSO carries, when available:
 *  - `::f<digest>` — a {@link frameIndexDigest} of the embedded frame SET (PRIMARY:
 *    two same-shape pkgs almost always embed different frame numbers), and
 *  - `::s<basename>` — the source video's real filename (SECONDARY hint).
 * Each section is OPTIONAL and OMITTED when unavailable (lazy/deferred backend,
 * "." / container provenance, or an old manifest), so a video missing a section
 * still matches a counterpart that has it — the digest only STRENGTHENS matching,
 * never breaks a legitimate graft (see {@link buildBackendGraftPlan}).
 */
export function videoSignature(v: VideoIdentity): string {
  const raw = Array.isArray(v.filename)
    ? (v.filename[0] ?? "")
    : (v.filename ?? "");
  const name = raw.split(/[\\/]/).pop() ?? "";
  const shape = Array.isArray(v.shape) ? v.shape.join("x") : "";
  const isEmbedded = v.embedded === true || /\.slp$/i.test(name);
  if (!isEmbedded) return `${name}|${shape}`; // external: shape(+name), unchanged
  let sig = `|${shape}`;
  const digest = frameIndexDigest(v.embeddedFrameIndices);
  if (digest) sig += `${SIG_SEP}f${digest}`;
  const src = realSourceBasename(v.sourceName);
  if (src) sig += `${SIG_SEP}s${src}`;
  return sig;
}

/** Parsed signature: the structural `base` (used for matching) plus the optional
 *  richer discriminators (used only to VETO an otherwise-matching pair). */
interface ParsedSignature {
  base: string;
  frameDigest?: string;
  sourceName?: string;
}

function parseSignature(sig: string): ParsedSignature {
  const at = sig.indexOf(SIG_SEP);
  if (at < 0) return { base: sig }; // external, or an old shape-only embedded sig
  const parsed: ParsedSignature = { base: sig.slice(0, at) };
  for (const part of sig.slice(at + SIG_SEP.length).split(SIG_SEP)) {
    if (part.startsWith("f")) parsed.frameDigest = part.slice(1);
    else if (part.startsWith("s")) parsed.sourceName = part.slice(1);
  }
  return parsed;
}

/** Whether two parsed signatures' richer discriminators DISAGREE. A discriminator
 *  present on both sides that differs is a conflict; a discriminator missing on
 *  either side is a wildcard (compatible) — so a lazy/old counterpart never
 *  triggers a false mismatch. */
function identitiesConflict(a: ParsedSignature, b: ParsedSignature): boolean {
  if (a.frameDigest && b.frameDigest && a.frameDigest !== b.frameDigest)
    return true;
  if (a.sourceName && b.sourceName && a.sourceName !== b.sourceName) return true;
  return false;
}

/**
 * For each draft video (by `draftSigs` index), the ORIGINAL video index whose
 * images should be grafted onto it — or `null` when there is no SAFE match.
 *
 * Matching runs on the STRUCTURAL base (`basename|shape` external, `|shape`
 * embedded) in two regimes, then a VETO on the richer discriminators, so a
 * mismatch never silently attaches the WRONG footage:
 *
 *  - IDENTICAL bases (same length, same base at every position) — the common
 *    resume case: a 1:1 positional graft. This is exact even when several videos
 *    share a base (same-shape embedded videos collapse to `|<shape>`), because
 *    position pins identity when the sets are identical.
 *
 *  - DIVERGED bases (a video was added/removed/reordered before the draft was
 *    saved, or a different file was re-picked): match ONLY bases that are globally
 *    unique on BOTH sides — those are unambiguous regardless of order. A base that
 *    repeats on either side is ambiguous under divergence, so it returns `null`.
 *
 * VETO: a proposed pair is dropped when its frame-index digest OR source name
 * DISAGREES (see {@link identitiesConflict}). This is what catches a wrong-but-
 * same-shape re-pick that the shape-only base would have grafted silently. A
 * discriminator missing on either side is a wildcard, so a lazy/deferred backend
 * or an old (shape-only) manifest never causes a false mismatch — the digest only
 * strengthens matching. A vetoed video is left blank + surfaces the caller's
 * "couldn't match" warning rather than getting the wrong images.
 *
 * Each original is grafted onto at most one draft video.
 */
export function buildBackendGraftPlan(
  draftSigs: string[],
  originalSigs: string[],
): (number | null)[] {
  const draft = draftSigs.map(parseSignature);
  const original = originalSigs.map(parseSignature);
  const dBases = draft.map((p) => p.base);
  const oBases = original.map((p) => p.base);

  const count = (arr: string[], b: string): number =>
    arr.reduce((n, s) => n + (s === b ? 1 : 0), 0);
  const identical =
    dBases.length === oBases.length && dBases.every((b, i) => b === oBases[i]);
  const proposal: (number | null)[] = identical
    ? dBases.map((_, i) => i)
    : dBases.map((b) =>
        count(dBases, b) !== 1 || count(oBases, b) !== 1
          ? null
          : oBases.indexOf(b),
      );

  return proposal.map((j, i) =>
    j != null && identitiesConflict(draft[i], original[j]) ? null : j,
  );
}
