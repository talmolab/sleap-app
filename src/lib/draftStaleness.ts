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
