/**
 * Desktop (Tauri) byte-reader for sleap-io.js `ImageVideoBackend`.
 *
 * An ImageVideo's frames are external image files; sleap-io.js obtains each
 * frame's bytes through a reader we inject via `setImageBytesReader`. The
 * browser sandbox can't read disk paths, so this reader is Tauri-only (backed by
 * `@tauri-apps/plugin-fs`). It resolves the stored image path against the
 * current project directory the same way the external-MP4 flow does
 * (`resolveVideos.ts`): an absolute path as-is, a relative path against the
 * project dir, and a basename-in-project-dir fallback for moved projects.
 *
 * The injected reader runs DURING `loadSlp` (the backend decodes frame 0 for its
 * shape), so the project directory is set just before load via
 * {@link setImageProjectDir}. When no candidate resolves, the reader throws —
 * sleap-io.js's load guard then records `video.backendError.kind = "image-
 * sequence"` so the UI can offer "Locate image folder…".
 */

import {
  isAbsolutePath,
  pathBasename,
  pathDirname,
  pathSep,
  tailGraftCandidates,
} from "./pathCandidates";

/** The directory of the currently-loading/loaded project, for path resolution. */
let projectDir: string | null = null;

/** Set the project directory used to resolve relative image paths. */
export function setImageProjectDir(dir: string | null): void {
  projectDir = dir;
}

/**
 * Ordered absolute-path candidates for a stored image path, given the project
 * directory:
 *   1. the path as-is (if absolute — same-machine reopen),
 *   2. the full relative path grafted onto the project dir (if relative —
 *      keeps subfolders, so it's tried first),
 *   3. the basename in the project dir (moved-project fallback),
 *   4. progressively longer TRAILING tails grafted onto the project dir
 *      (`<subdir>/basename`, …) — reaches images that moved WITH their parent
 *      subfolder(s) under a new root (a cross-machine absolute path whose files
 *      now live in a subfolder beside the reopened `.slp`).
 * Falls back to the raw path when no project dir is known.
 */
export function imagePathCandidates(
  rawPath: string,
  dir: string | null
): string[] {
  const candidates: string[] = [];
  const add = (p: string) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  const abs = isAbsolutePath(rawPath);
  if (abs) add(rawPath);
  if (dir) {
    const sep = pathSep(dir);
    const base = dir.replace(/[\\/]+$/, "");
    // Relative paths: the full relative path (subfolders kept) is the primary
    // candidate — tried before the basename/tail grafts below.
    if (!abs) add(base + sep + rawPath.replace(/[\\/]/g, sep));
    // Basename-in-dir is always offered (the classic moved-project fallback);
    // `tailGraftCandidates` alone omits it for a single-segment path.
    add(base + sep + pathBasename(rawPath));
    for (const c of tailGraftCandidates(rawPath, base)) add(c);
  }
  if (candidates.length === 0) add(rawPath);
  return candidates;
}

/**
 * Build an `ImageBytesReader` over Tauri's `readFile`/`exists`. Tries each
 * candidate path and reads the first that exists; throws if none do.
 */
export function createImageReader(
  readFile: (path: string) => Promise<Uint8Array>,
  exists: (path: string) => Promise<boolean>
): (path: string) => Promise<Uint8Array> {
  // Resolve the candidate strategy ONCE and reuse it, KEYED BY SOURCE DIRECTORY.
  // Every image in one sequence shares a directory and one resolution rule
  // (absolute as-is / relative / basename / subfolder-tail), so once the first
  // frame resolves we apply the same candidate index to later frames of that
  // sequence and `readFile` directly — skipping the per-frame `exists()` stat,
  // a full network round-trip (~17 ms/frame). The dir key is essential: this
  // reader is a single global instance shared across ALL image videos in the
  // project, and a cached index reused for a DIFFERENT sequence could point at
  // an unrelated same-basename file (silent wrong bytes). A cached read that
  // later fails re-resolves.
  let cached: { dir: string; index: number } | null = null;
  return async (path: string): Promise<Uint8Array> => {
    const candidates = imagePathCandidates(path, projectDir);
    const dir = pathDirname(path);
    if (cached && cached.dir === dir && cached.index < candidates.length) {
      try {
        return await readFile(candidates[cached.index]);
      } catch {
        cached = null; // strategy stopped working — fall through to re-resolve
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (await exists(candidates[i])) {
        cached = { dir, index: i };
        return readFile(candidates[i]);
      }
    }
    throw new Error(
      `Image file not found: ${path}` +
        (projectDir ? ` (looked in ${projectDir})` : "")
    );
  };
}
