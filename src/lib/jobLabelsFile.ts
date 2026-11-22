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
 * the job ends, whatever the outcome. Copies a crash left behind are deleted
 * when the next job writes one. A large embedded package is copied with the
 * streaming writer the app's own saves use above the in-memory size limit, so
 * its frames never pass through memory.
 */
import { saveSlpToBytes, type Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { sourceFormatOf, withLegacyLayout } from "@/lib/slpFormatCompat";

/** Whether the project file the labels were opened from is still in format 3.0 on disk. */
export function projectFileIsFormat3(labels: Labels | null | undefined): boolean {
  return sourceFormatOf(labels) !== null;
}

/** File names of job copies, in the temp directory. */
const COPY_NAME = /^sleap_(training|inference)_v2copy_\d+_\d+\.slp$/;

/** Copies of jobs still running (absolute paths): never swept. */
const live = new Set<string>();
let seq = 0;

/**
 * Delete job copies left in the temp directory by a job that never ended (a
 * crash, a closed window). Best-effort; copies of running jobs are kept.
 * Returns how many it deleted.
 */
export async function sweepStaleJobCopies(): Promise<number> {
  try {
    const [{ tempDir, join }, { readDir, remove }] = await Promise.all([
      import("@tauri-apps/api/path"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const dir = await tempDir();
    let removed = 0;
    for (const entry of await readDir(dir)) {
      if (!entry.name || !COPY_NAME.test(entry.name)) continue;
      const path = await join(dir, entry.name);
      if (live.has(path)) continue;
      try {
        await remove(path);
        removed++;
      } catch {
        /* in use or gone: leave it */
      }
    }
    return removed;
  } catch {
    return 0;
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

/** A job's copy of the project open now (desktop only). */
export function createJobLabelsCopy(purpose: "training" | "inference"): JobLabelsCopy {
  const { labels, projectPath } = useAppStore.getState();
  let pending: Promise<string> | null = null;
  let written: string | null = null;
  return {
    path() {
      pending ??= (async () => {
        if (!labels) throw new Error("No project loaded");
        await sweepStaleJobCopies();
        const { tempDir, join } = await import("@tauri-apps/api/path");
        const path = await join(await tempDir(), `sleap_${purpose}_v2copy_${Date.now()}_${++seq}.slp`);
        live.add(path);
        written = path;
        await writeLegacyCopy(labels, path, projectPath);
        console.log(`[${purpose}] Wrote a 2.x copy of the project to %s`, path);
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
