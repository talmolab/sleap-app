/**
 * The labels file a local sleap-nn job reads.
 *
 * Local training and inference normally read the project file on disk. When
 * that file is still in SLP format 3.0 (it was opened from such a file and not
 * yet saved, whatever the open-time choice), they never read it directly: the
 * sleap-nn the app installs reads only the 2.x layout. They read a 2.x copy of
 * the labels in memory instead, written the same way as for a project with no
 * file on disk: nodes not labeled become hidden nodes with no position, and
 * metadata is dropped (the user is told before the job starts, see
 * `confirmJobFromProject` in slpAccess.ts).
 */
import { saveSlpToBytes, type Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { sourceFormatOf, withLegacyLayout } from "@/lib/slpFormatCompat";

/** Whether the project file the labels were opened from is still in format 3.0 on disk. */
export function projectFileIsFormat3(labels: Labels | null | undefined): boolean {
  return sourceFormatOf(labels) !== null;
}

/**
 * Write `labels` in the 2.x layout to a new file in the temp directory and
 * return its path (desktop only).
 */
export async function writeLegacyJobCopy(
  labels: Labels,
  purpose: "training" | "inference",
): Promise<string> {
  const [{ tempDir, join }, { writeFile }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const path = await join(await tempDir(), `sleap_${purpose}_input_${Date.now()}.slp`);
  const bytes = await saveSlpToBytes(labels, withLegacyLayout());
  await writeFile(path, bytes);
  console.log(`[${purpose}] Wrote a 2.x copy of the project (%d bytes) to %s`, bytes.byteLength, path);
  return path;
}

/**
 * The file a local job should read for `labelsPath`: the path itself, or a
 * 2.x copy of the open project when `labelsPath` is the project file and that
 * file is still in format 3.0.
 */
export async function jobLabelsPath(
  labelsPath: string,
  purpose: "training" | "inference",
): Promise<string> {
  const { labels, projectPath } = useAppStore.getState();
  if (!labels || !labelsPath || labelsPath !== projectPath || !projectFileIsFormat3(labels)) {
    return labelsPath;
  }
  return writeLegacyJobCopy(labels, purpose);
}
