/**
 * Pure path-candidate helpers for the external-video resolver (`resolveVideos.ts`):
 * single-file candidate generation (`getVideoPathCandidates`) and the
 * Locate-folder flow (`resolveImageFramesInFolder`). ImageVideo/external
 * resolution during load is handled upstream by sleap-io.js's FsResolver.
 *
 * The central idea is the **trailing-tail graft**: media saved on one machine and
 * reopened on another often keeps its *sub*folder structure while its root moves
 * (e.g. a `.slp` saved on Linux at `/home/u/proj/raw/img.jpg`, reopened on a
 * Windows mount where the images now live at `L:\proj\raw\img.jpg`). Grafting
 * progressively longer trailing segments of the stored path onto a base
 * directory reaches the file wherever the shared tail re-roots — the same
 * intent as SLEAP-python's on-load path resolution and `find_changed_subpath`.
 *
 * These are decoder- and filesystem-independent (existence checks are the
 * caller's job) so they are exhaustively unit-tested.
 */

/** Path separator implied by a path string (Windows backslash vs POSIX slash). */
export function pathSep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

/** Basename (last path segment) of a path, splitting on either separator. */
export function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Directory of a path (everything before the last separator), or `""` if none. */
export function pathDirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

/** True if `p` is absolute — POSIX `/…` or Windows `X:\…` / `X:/…`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * How many trailing segments we graft before giving up. Bounds the worst-case
 * number of `exists` probes per genuinely-missing file on a slow mount; 8
 * comfortably covers realistic project nesting.
 */
export const MAX_TAIL_GRAFT = 8;

/**
 * Candidates that graft progressively longer TRAILING tails of `rawPath` onto
 * `dir`, closest-first: `basename`, then `<lastDir>/<basename>`, then two dirs
 * up, … The stored path's own leading anchors (drive letter, `/home/user`, …)
 * are meaningless under a new root, so by default the FULL path is NOT
 * reproduced — the deepest candidate keeps `segs.length - 1` trailing segments.
 * Pass `includeFullPath` when the whole stored path may be relative to `dir`
 * (the folder-locate flow, where the user may pick an ancestor of the images).
 *
 * Separator follows `dir`. Trailing separators on `dir` are trimmed. Pure.
 *
 * @example
 *   tailGraftCandidates("/home/u/proj/raw/a.jpg", "L:\\proj")
 *   // => ["L:\\proj\\a.jpg", "L:\\proj\\raw\\a.jpg", "L:\\proj\\proj\\raw\\a.jpg", ...]
 */
export function tailGraftCandidates(
  rawPath: string,
  dir: string,
  opts?: { maxDepth?: number; includeFullPath?: boolean }
): string[] {
  const maxDepth = opts?.maxDepth ?? MAX_TAIL_GRAFT;
  const includeFullPath = opts?.includeFullPath ?? false;
  const sep = pathSep(dir);
  const base = dir.replace(/[\\/]+$/, "");
  const segs = rawPath.split(/[\\/]/).filter(Boolean);
  const limit = Math.min(
    maxDepth,
    includeFullPath ? segs.length : segs.length - 1
  );
  const out: string[] = [];
  for (let k = 1; k <= limit; k++) {
    out.push(base + sep + segs.slice(segs.length - k).join(sep));
  }
  return out;
}
