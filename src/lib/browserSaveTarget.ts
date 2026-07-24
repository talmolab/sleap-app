/**
 * Decide whether a browser SLP save should overwrite the already-opened file in
 * place (via its retained `FileSystemFileHandle`) instead of prompting a
 * Save-As dialog.
 *
 * In-place is the default for a plain Save when we hold a writable handle to the
 * opened file — matching a native / PyQt save that writes back to the same path.
 * Save-As (`forceDialog`) must always prompt so the user can pick a new
 * destination, and a plain Save with no retained handle (e.g. a drag-drop open,
 * which yields none) also falls back to the picker.
 */

export function shouldOverwriteOpenedFile(opts: {
  forceDialog: boolean;
  hasHandle: boolean;
}): boolean {
  return !opts.forceDialog && opts.hasHandle;
}
