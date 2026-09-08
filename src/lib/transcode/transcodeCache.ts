/**
 * Transcode cache bookkeeping (pure): a legacy video is transcoded to H.264 MP4
 * ONCE and reused across sessions. Entries live in the OS cache dir
 * (`appCacheDir()`, disposable — deliberately NOT `appLocalDataDir()`, where
 * autosave/crash-recovery drafts live, so evicting a transcode can never touch
 * unsaved work). Because every entry is regenerable from the untouched original,
 * the cache is safe to bound and purge: a miss just costs a re-transcode.
 *
 * Pure + I/O-free (the fs/spawn seams live in {@link file://./transcodeVideo.ts}).
 */

/** Cache-entry filename extension. */
export const TRANSCODE_EXT = ".mp4";

/**
 * Stable, collision-resistant-enough cache key for a source file, derived from
 * its absolute path + byte size + mtime. Size+mtime make the key
 * self-invalidating: if the user edits/replaces the source, the key changes and
 * we re-transcode instead of serving a stale MP4. Not cryptographic — a 64-bit
 * FNV-1a folded to hex is ample for a local filename namespace.
 */
export function computeCacheKey(
  sourcePath: string,
  sizeBytes: number,
  mtimeMs: number
): string {
  const composite = `${sourcePath}|${sizeBytes}|${Math.round(mtimeMs)}`;
  return fnv1a64Hex(composite);
}

/** The cache filename (not full path) for a key: `<key>.mp4`. */
export function cacheFilename(key: string): string {
  return `${key}${TRANSCODE_EXT}`;
}

/**
 * The cache filename for a scrub PROXY of a source: `<key>-proxy-g<gop>.mp4`.
 * The `-proxy-g<gop>` suffix keeps a proxy from colliding with a legacy
 * transcode's `<key>.mp4` (or with a proxy built at a different GOP, so a GOP
 * change self-invalidates the old one).
 */
export function proxyCacheFilename(key: string, gop: number): string {
  return `${key}-proxy-g${gop}${TRANSCODE_EXT}`;
}

/** A cached transcode on disk, for eviction planning. */
export interface CacheEntry {
  /** Absolute path to the cached `.mp4`. */
  path: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Last-access (or last-modified) time in ms — the LRU recency signal. */
  atimeMs: number;
}

/**
 * Least-recently-used eviction plan: given the current cache entries and a byte
 * budget, return the paths to delete (oldest-first) so the total falls at or
 * below `capBytes`. Pure — the caller performs the deletes. Never evicts below
 * the cap; returns `[]` when already within budget or when `capBytes <= 0`
 * disables the cap.
 */
export function planCacheEviction(
  entries: CacheEntry[],
  capBytes: number
): string[] {
  if (capBytes <= 0) return [];
  const total = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  if (total <= capBytes) return [];

  // Oldest first (smallest atime). Stable-ish: tie-break by path for determinism.
  const oldestFirst = [...entries].sort(
    (a, b) => a.atimeMs - b.atimeMs || a.path.localeCompare(b.path)
  );

  const toDelete: string[] = [];
  let running = total;
  for (const entry of oldestFirst) {
    if (running <= capBytes) break;
    toDelete.push(entry.path);
    running -= entry.sizeBytes;
  }
  return toDelete;
}

/** 64-bit FNV-1a over the UTF-8 bytes, returned as 16 hex chars. */
function fnv1a64Hex(input: string): string {
  // Use BigInt for the 64-bit rolling hash (avoids 32-bit overflow collisions).
  const PRIME = 1099511628211n;
  const MASK = (1n << 64n) - 1n;
  let hash = 14695981039346656037n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
