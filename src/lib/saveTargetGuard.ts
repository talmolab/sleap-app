/**
 * Same-file save guard for the browser (OPFS) large-file save path.
 *
 * A browser re-save reads embedded images FROM the opened source while
 * streaming the result INTO the chosen destination. If the destination is the
 * SAME on-disk file as the source, `createWritable()` truncates the only copy,
 * so a mid-save failure zeroes the original. The caller uses this to refuse
 * that case before any bytes are written.
 */

/**
 * True if `destHandle` (the chosen save target) refers to the SAME on-disk file
 * as `source` (the currently-open project).
 *
 * Only decidable when `source` is a durable `FileSystemFileHandle` (opens via
 * the file picker retain one). A bare `File` snapshot (drag-drop) has no
 * identity to compare, so this returns `false` — best effort, since that path
 * can't target the same on-disk file without the user re-picking it anyway. A
 * comparison that throws (unsupported) also yields `false`, so the guard never
 * blocks an otherwise-valid save.
 */
export async function isSameSaveTarget(
  source: FileSystemFileHandle | File,
  destHandle: FileSystemFileHandle,
): Promise<boolean> {
  const maybeHandle = source as Partial<FileSystemFileHandle>;
  if (typeof maybeHandle.isSameEntry !== "function") return false;
  try {
    return await maybeHandle.isSameEntry(destHandle);
  } catch {
    return false;
  }
}
