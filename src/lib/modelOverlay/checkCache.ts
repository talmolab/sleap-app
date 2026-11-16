/**
 * Remembers what the Compare Model Predictions dialog found about each scanned
 * file, so reopening the dialog doesn't read every `.slp` in the project
 * folder again. Keyed by path + size + modified time + the video and node
 * names it was checked against, so an edited file or another video is checked
 * afresh. Only the verdict is kept (name, frame count, reason) — never the
 * poses, which are read again only for the files you choose to show.
 */
import type { CandidateAnalysis, TargetVideo } from "./core";

export type CheckSummary =
  | { ok: true; name: string; frameCount: number; matchedBy: "path" | "name" | "probable" }
  | { ok: false; name: string; reason: string };

const cache = new Map<string, CheckSummary>();

/** The cache key, or null when the file's modified time is unknown (then never cached). */
export function checkCacheKey(
  path: string,
  size: number | null,
  mtime: number | null,
  target: TargetVideo,
  nodeNames: readonly string[]
): string | null {
  if (mtime === null) return null;
  return [path, size, mtime, target.path, target.frameCount, target.height, target.width, nodeNames.join("\u0000")].join(
    "\u0001"
  );
}

export function summarize(a: CandidateAnalysis): CheckSummary {
  return a.ok
    ? { ok: true, name: a.name, frameCount: a.frameCount, matchedBy: a.matchedBy }
    : { ok: false, name: a.name, reason: a.reason };
}

export function getCachedCheck(key: string | null): CheckSummary | undefined {
  return key === null ? undefined : cache.get(key);
}

export function setCachedCheck(key: string | null, a: CandidateAnalysis): void {
  if (key !== null) cache.set(key, summarize(a));
}

/** For tests. */
export function clearCheckCache(): void {
  cache.clear();
}
