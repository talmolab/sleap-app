/**
 * The labels file a local sleap-nn job reads.
 *
 * Local training and inference normally read the project file on disk. When
 * that file is still in SLP format 3.0 (it was opened from such a file and not
 * yet saved, whatever the open-time choice), they never read it directly: the
 * sleap-nn the app installs reads only the 2.x layout. They read a 2.x copy of
 * the labels in memory instead: nodes not labeled become hidden nodes with no
 * position, and metadata is dropped (the user is told before the job starts,
 * see `confirmJobFromProject` in slpAccess.ts).
 *
 * One copy per job ({@link createJobLabelsCopy}): written on first use (a
 * video-scoped inference that reads the video file directly never writes it),
 * reused by every sleap-nn run of the job (both heads of a top-down model,
 * inference after training, the per-video inference loop), and deleted when
 * the job ends, whatever the outcome. A large embedded package is copied with
 * the streaming writer the app's own saves use above the in-memory size limit,
 * so its frames never pass through memory.
 *
 * Copies live in their own folder under the app's cache folder
 * (`job-copies/`), never in the OS temp folder, which is RAM-backed on many
 * Linux systems. Their names carry the window that wrote them and when. Each
 * app window (its own JS heap) and each app process may run a job at once,
 * and a window can't tell whether another one's copy is still in use, so the
 * sweep that runs when a job writes a copy deletes only copies, and partial
 * `.sleap-tmp-` files of the streaming writer, older than
 * {@link STALE_COPY_AGE_MS} (a crash or a killed app left them).
 */
import { saveSlpToBytes, type Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { sourceFormatOf, withLegacyLayout } from "@/lib/slpFormatCompat";

/** Whether the project file the labels were opened from is still in format 3.0 on disk. */
export function projectFileIsFormat3(labels: Labels | null | undefined): boolean {
  return sourceFormatOf(labels) !== null;
}

/**
 * How old a job copy must be before the sweep deletes it. Generous: a copy
 * this old belongs to no job any window or process could still be running.
 */
export const STALE_COPY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A job copy's file name, or a partial file the streaming writer left beside
 * it: `sleap-job-<purpose>-<window>-<written at, ms>-<seq>.slp[.sleap-tmp-…]`.
 */
const COPY_NAME = /^sleap-job-(training|inference)-([A-Za-z0-9]+)-(\d+)-(\d+)\.slp(\.sleap-tmp-[A-Za-z0-9-]+)?$/;

/** Copies of this window's jobs still running (absolute paths): never swept. */
const live = new Set<string>();
let seq = 0;

/** The folder job copies go in: `job-copies/` under the app's cache folder. */
export async function jobCopiesDir(): Promise<string> {
  const { appCacheDir, appLocalDataDir, join } = await import("@tauri-apps/api/path");
  let base: string;
  try {
    base = await appCacheDir();
  } catch {
    base = await appLocalDataDir();
  }
  return join(base, "job-copies");
}

/** This window's label, as it goes in a copy's name (letters and digits only). */
async function windowTag(): Promise<string> {
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().label.replace(/[^A-Za-z0-9]/g, "") || "window";
  } catch {
    return "window";
  }
}

/**
 * Delete job copies (and partial copies) older than {@link STALE_COPY_AGE_MS}
 * from the job-copies folder. Never a copy this window is using, and never a
 * recent one, which may belong to a job in another window or app process.
 * Best-effort. Returns how many it deleted.
 */
export async function sweepStaleJobCopies(now: number = Date.now()): Promise<number> {
  try {
    const [{ join }, { readDir, remove }] = await Promise.all([
      import("@tauri-apps/api/path"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const dir = await jobCopiesDir();
    let removed = 0;
    for (const entry of await readDir(dir)) {
      const m = entry.name ? COPY_NAME.exec(entry.name) : null;
      if (!m) continue;
      if (now - Number(m[3]) < STALE_COPY_AGE_MS) continue;
      const path = await join(dir, entry.name);
      if (live.has(path) || live.has(path.replace(/\.sleap-tmp-[A-Za-z0-9-]+$/, ""))) continue;
      try {
        await remove(path);
        removed++;
      } catch {
        /* in use or gone: leave it */
      }
    }
    return removed;
  } catch {
    return 0; // no folder yet, or no file system: nothing to sweep
  }
}

/**
 * Write `labels` in the 2.x layout to `path`. An embedded package whose file
 * on disk is over the in-memory limit (or of unknown size) goes through the
 * streaming writer, which copies its frames from `sourcePath` on disk, as the
 * app's own saves do; anything else is serialized in memory.
 */
async function writeLegacyCopy(labels: Labels, path: string, sourcePath: string | null): Promise<void> {
  const hasEmbeddedImages = labels.videos.some((v) => v.hasEmbeddedImages);
  // Embedded images read under stale names could be another video's: end the
  // job with the reason instead (see inPlaceBinding.ts).
  if (hasEmbeddedImages) {
    const { assertNoStaleVideoNames } = await import("@/lib/inPlaceBinding");
    assertNoStaleVideoNames(labels);
  }
  if (hasEmbeddedImages && sourcePath) {
    const [{ shouldStreamEmbeddedSave }, { fileSize }] = await Promise.all([
      import("@/lib/saveRouting"),
      import("@/lib/nativeRange"),
    ]);
    let estimatedOutputBytes: number | null = null;
    try {
      estimatedOutputBytes = await fileSize(sourcePath);
    } catch {
      estimatedOutputBytes = null;
    }
    if (
      shouldStreamEmbeddedSave({
        isTauri: true,
        hasEmbeddedImages,
        hasSourcePath: true,
        estimatedOutputBytes,
      })
    ) {
      const { saveEmbeddedPkgStreaming } = await import("@/lib/saveEmbeddedPkgStreaming");
      await saveEmbeddedPkgStreaming(labels, path, sourcePath);
      return;
    }
  }
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, await saveSlpToBytes(labels, withLegacyLayout()));
}

/** One job's 2.x copy of the open project (see the module comment). */
export interface JobLabelsCopy {
  /** The copy's path, writing it on the first call. */
  path(): Promise<string>;
  /** Delete the copy, if it was written. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * A job's copy of the project open now (desktop only). `onStatus` hears a line
 * when the copy starts and when it is written (a large package can take
 * minutes), for the job's log.
 */
export function createJobLabelsCopy(
  purpose: "training" | "inference",
  onStatus?: (line: string) => void,
): JobLabelsCopy {
  const { labels, projectPath } = useAppStore.getState();
  let pending: Promise<string> | null = null;
  let written: string | null = null;
  return {
    path() {
      pending ??= (async () => {
        if (!labels) throw new Error("No project loaded");
        await sweepStaleJobCopies();
        const [{ join }, { mkdir }] = await Promise.all([
          import("@tauri-apps/api/path"),
          import("@tauri-apps/plugin-fs"),
        ]);
        const dir = await jobCopiesDir();
        await mkdir(dir, { recursive: true });
        const name = `sleap-job-${purpose}-${await windowTag()}-${Date.now()}-${++seq}.slp`;
        const path = await join(dir, name);
        live.add(path);
        written = path;
        const started = Date.now();
        onStatus?.("— Writing a 2.x copy of the project for sleap-nn (its file is in SLP format 3.0)...");
        console.log(`[${purpose}] Writing a 2.x copy of the project to %s`, path);
        await writeLegacyCopy(labels, path, projectPath);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        onStatus?.(`— 2.x copy written (${secs} s).`);
        console.log(`[${purpose}] Wrote the 2.x copy in %s s`, secs);
        return path;
      })();
      return pending;
    },
    async release() {
      const path = written;
      written = null;
      pending = null;
      if (!path) return;
      live.delete(path);
      try {
        const { remove } = await import("@tauri-apps/plugin-fs");
        await remove(path);
      } catch {
        /* already gone (a failed write), or the next job's sweep removes it */
      }
    },
  };
}

/**
 * The file a local job should read for `labelsPath`: the path itself, or the
 * job's 2.x copy of the open project when `labelsPath` is the project file and
 * that file is still in format 3.0.
 */
export async function jobLabelsPath(labelsPath: string, copy: JobLabelsCopy): Promise<string> {
  const { labels, projectPath } = useAppStore.getState();
  if (!labels || !labelsPath || labelsPath !== projectPath || !projectFileIsFormat3(labels)) {
    return labelsPath;
  }
  return copy.path();
}
