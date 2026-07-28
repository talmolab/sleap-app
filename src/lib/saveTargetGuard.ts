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
 * When `source` is a durable `FileSystemFileHandle` (file-picker opens retain
 * one), compare by identity (`isSameEntry`). When it's a bare `File` (drag-drop
 * opens), there is no handle identity, but the user CAN still navigate the save
 * picker to the original file — so compare the destination's file against the
 * source by (name, size, lastModified) as a best-effort match. Either check errs
 * SAFE: a false positive only prompts the user to pick a different filename,
 * never blocks an otherwise-valid save (any throw / unsupported → `false`).
 */
export async function isSameSaveTarget(
  source: FileSystemFileHandle | File,
  destHandle: FileSystemFileHandle,
): Promise<boolean> {
  const maybeHandle = source as Partial<FileSystemFileHandle>;
  if (typeof maybeHandle.isSameEntry === "function") {
    try {
      return await maybeHandle.isSameEntry(destHandle);
    } catch {
      return false;
    }
  }
  // Bare File (drag-drop): compare against the destination's current file.
  if (source instanceof File) {
    try {
      const dest = await destHandle.getFile();
      return (
        dest.name === source.name &&
        dest.size === source.size &&
        dest.lastModified === source.lastModified
      );
    } catch {
      return false;
    }
  }
  return false;
}
