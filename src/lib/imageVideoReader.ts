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

/** The directory of the currently-loading/loaded project, for path resolution. */
let projectDir: string | null = null;

/** Set the project directory used to resolve relative image paths. */
export function setImageProjectDir(dir: string | null): void {
  projectDir = dir;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Ordered absolute-path candidates for a stored image path, given the project
 * directory: the path as-is (if absolute), the path resolved against the
 * project dir (if relative), and the basename in the project dir (moved
 * projects). Falls back to the raw path when no project dir is known.
 */
export function imagePathCandidates(
  rawPath: string,
  dir: string | null
): string[] {
  const candidates: string[] = [];
  const abs = isAbsolute(rawPath);
  if (abs) candidates.push(rawPath);
  if (dir) {
    const sep = dir.includes("\\") ? "\\" : "/";
    if (!abs) candidates.push(dir + sep + rawPath.replace(/[\\/]/g, sep));
    const baseCand = dir + sep + basename(rawPath);
    if (!candidates.includes(baseCand)) candidates.push(baseCand);
  }
  if (candidates.length === 0) candidates.push(rawPath);
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
  // Resolve the candidate strategy ONCE and reuse it. Every image in a sequence
  // shares one directory and one resolution rule (absolute as-is / relative /
  // basename-in-project-dir), so once the first frame resolves we apply the same
  // candidate index to later frames and `readFile` directly — skipping the
  // per-frame `exists()` stat, which on a network mount is a full round-trip
  // (measured ~17 ms/frame). If a cached strategy's read later fails (e.g. a
  // different video in the project needs a different rule), we re-resolve.
  let resolvedIndex: number | null = null;
  return async (path: string): Promise<Uint8Array> => {
    const candidates = imagePathCandidates(path, projectDir);
    if (resolvedIndex !== null && resolvedIndex < candidates.length) {
      try {
        return await readFile(candidates[resolvedIndex]);
      } catch {
        resolvedIndex = null; // strategy stopped working — fall through to re-resolve
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (await exists(candidates[i])) {
        resolvedIndex = i;
        return readFile(candidates[i]);
      }
    }
    throw new Error(
      `Image file not found: ${path}` +
        (projectDir ? ` (looked in ${projectDir})` : "")
    );
  };
}
