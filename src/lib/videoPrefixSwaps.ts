/**
 * Global, cross-project video path prefix-swap memory.
 *
 * When a user locates one missing video, `computePrefixSwap` (resolveVideos.ts)
 * derives a leading-prefix substitution — e.g. `/root/vast` → `/Volumes/talmo` —
 * from the longest common trailing run of path segments, and
 * `propagatePrefixSwap` applies it to the OTHER missing videos in the same
 * session. This module holds the pure transform used by that in-session
 * propagation AND by the reapply-on-open path, plus the list-merge used to
 * persist swaps as a first-class app preference (appStore `videoPrefixSwaps`,
 * see PERSISTED_KEYS).
 *
 * Persisting the swaps is a deliberate SUPERSET of PyQt SLEAP: PyQt applies a
 * located swap only within the current load (and implicitly per-project via
 * save-back), whereas remembering it lets a *different* project opened later
 * from the same relocated root auto-resolve without re-locating. It is safe:
 * every persisted swap is only ever *adopted* when the remapped file actually
 * exists on disk (the `exists()` gate in the callers), so a stale or
 * coincidental mapping can never adopt a wrong file.
 */

export interface VideoPrefixSwap {
  /**
   * The stored path's leading prefix that no longer resolves. `""` means the
   * stored paths were relative (the whole path is the shared tail).
   */
  oldPrefix: string;
  /** The prefix to substitute in — where the files actually live now. */
  newPrefix: string;
}

/**
 * Cap on remembered swaps so the preference can't grow without bound. The most
 * recently learned swaps are the most likely to be relevant, so newest wins.
 */
export const MAX_VIDEO_PREFIX_SWAPS = 50;

/**
 * Apply a prefix swap to a single stored video path, returning the candidate
 * path or `null` if the swap doesn't apply.
 *
 * Boundary-safe: a non-empty `oldPrefix` must match on a path-segment boundary,
 * so `/root/va` never matches `/root/vast`. An empty `oldPrefix` means the
 * stored paths were relative — only relative siblings qualify (we never prepend
 * a new prefix onto an absolute path). Separator-insensitive (normalizes `\` to
 * `/`). Pure; unit-tested.
 *
 * Mirrors the boundary logic of SLEAP-python's `filenames_prefix_change`; the
 * caller is responsible for the `exists()` safety check before adopting a result.
 */
export function applyPrefixSwap(
  storedPath: string,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  const stored = storedPath.replace(/\\/g, "/");
  if (!stored) return null;

  let rest: string;
  if (oldPrefix === "") {
    // Relative stored paths only; never prepend onto an absolute path.
    const isAbs = stored.startsWith("/") || /^[A-Za-z]:\//.test(stored);
    if (isAbs) return null;
    rest = stored;
  } else {
    if (!stored.startsWith(oldPrefix)) return null;
    const nextChar = stored[oldPrefix.length];
    if (nextChar !== undefined && nextChar !== "/") return null; // not a dir boundary
    rest = stored.slice(oldPrefix.length).replace(/^\/+/, "");
  }

  const base = newPrefix.replace(/\/+$/, "");
  return base ? `${base}/${rest}` : rest;
}

/**
 * Merge a newly-learned swap into the remembered list: dedupe by
 * (`oldPrefix`, `newPrefix`), insert the swap at the FRONT (most-recent-first),
 * and cap the list at {@link MAX_VIDEO_PREFIX_SWAPS}. Pure — returns a new array.
 */
export function mergeVideoPrefixSwap(
  list: VideoPrefixSwap[],
  swap: VideoPrefixSwap,
): VideoPrefixSwap[] {
  const deduped = list.filter(
    (s) => s.oldPrefix !== swap.oldPrefix || s.newPrefix !== swap.newPrefix,
  );
  return [swap, ...deduped].slice(0, MAX_VIDEO_PREFIX_SWAPS);
}
