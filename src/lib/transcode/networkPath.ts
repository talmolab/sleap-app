/**
 * Heuristic: does an absolute path look like it lives on a network mount?
 *
 * Recognizes the common per-OS network-mount roots: macOS `/Volumes/…`, Windows
 * UNC `\\server\share\…` (leading `\\`), and Linux `/mnt/…` and `/media/…`. The
 * prefix match is case-insensitive.
 *
 * This is ONLY a heuristic — e.g. a `/Volumes` entry can be a locally-attached
 * external disk rather than a network share. That's acceptable: it gates whether
 * building a local scrub proxy is *worth* it, so a false positive only wastes an
 * unnecessary proxy build, it never breaks correctness.
 */
export function isNetworkPath(path: string): boolean {
  // Windows UNC: leading double backslash (\\server\share\…).
  if (path.startsWith("\\\\")) return true;
  const lower = path.toLowerCase();
  return (
    lower.startsWith("/volumes/") ||
    lower.startsWith("/mnt/") ||
    lower.startsWith("/media/")
  );
}
