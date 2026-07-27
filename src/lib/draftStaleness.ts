/**
 * Pure staleness check for resume-after-close.
 *
 * A recoverable labels draft carries a handle to the ORIGINAL file so a later ⌘S
 * can overwrite it in place. But if that file was edited AND saved in another
 * session/tab AFTER this draft was written, the draft is stale relative to disk:
 * silently overwriting in place would clobber the newer on-disk content. Restore
 * uses this to decide whether it's safe to re-link the write handle (fresh) or
 * must force Save-As (stale) — see draftRestore.ts.
 *
 * The draft's own OPFS write time (`savedAt`) is always AFTER the moment we
 * opened the file, so in the normal single-session case the disk file's mtime is
 * older than `savedAt`. A disk mtime meaningfully NEWER than `savedAt` therefore
 * means the file changed on disk since we last saved the draft.
 */

/** Default tolerance (ms) for clock/mtime jitter between the app clock (savedAt)
 *  and the filesystem mtime — below this a "newer" disk file isn't treated as a
 *  real external edit. */
export const DRAFT_STALENESS_SLACK_MS = 2_000;

/**
 * True when the on-disk file (`diskLastModified`, a File.lastModified ms epoch)
 * was modified more than `slackMs` after the draft was saved (`draftSavedAt`, ms
 * epoch) — i.e. the draft is stale relative to what's now on disk.
 */
export function isDraftStaleVsDisk(
  draftSavedAt: number,
  diskLastModified: number,
  slackMs: number = DRAFT_STALENESS_SLACK_MS,
): boolean {
  return diskLastModified - draftSavedAt > slackMs;
}

/** Identity snapshot of the source file recorded when the draft was saved. */
export interface SourceSnapshot {
  /** `File.size` (bytes) of the source when the draft was saved. */
  size?: number;
  /** `File.lastModified` (ms epoch) of the source when the draft was saved. */
  lastModified?: number;
}

/**
 * True when the current on-disk file differs from the snapshot recorded at
 * draft-save — by size OR modification time. A stronger, EXACT replacement for
 * {@link isDraftStaleVsDisk}: both values come from `File` (same clock/source
 * then and now), so it needs no slack, catches size changes, and — unlike the
 * timestamp-vs-savedAt heuristic — closes false-negative holes (an external edit
 * whose mtime lands at/*before* our draft-write clock).
 *
 * Returns false when the snapshot is incomplete (nothing recorded to compare);
 * the caller then falls back to {@link isDraftStaleVsDisk} (drafts written before
 * this snapshot existed).
 *
 * A size-preserving external edit (e.g. an in-place point move by another
 * session) still bumps mtime, so it's caught. A cloud-sync mtime bump with
 * identical content also trips this (a SAFE false positive → just forces
 * Save-As); telling those apart would require hashing the file, which this cheap
 * check intentionally avoids.
 */
export function isSourceChanged(
  recorded: SourceSnapshot,
  current: { size: number; lastModified: number },
): boolean {
  if (recorded.size == null || recorded.lastModified == null) return false;
  return (
    current.size !== recorded.size ||
    current.lastModified !== recorded.lastModified
  );
}
