/**
 * Pure helpers for the Videos panel search/filter box.
 *
 * Filtering matches a case-insensitive substring against a video's basename.
 * ImageVideo filenames are `string[]` (one path per frame) — we match the
 * basename of the first entry, matching how the panel labels the row.
 */

/** Basename (last path segment) of a video filename; first entry for sequences. */
export function videoBasename(filename: string | string[]): string {
  const p = Array.isArray(filename) ? filename[0] ?? "" : filename;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Whether `filename`'s basename contains `query` (case-insensitive). An empty
 * or whitespace-only query matches everything (shows the full list).
 */
export function videoFilenameMatches(
  filename: string | string[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return videoBasename(filename).toLowerCase().includes(q);
}
