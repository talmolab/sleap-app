/**
 * Reading the output of `sleap-nn train --dry-run` (sleap-nn after 0.3.5): a
 * check of a training config that runs all setup plus one training and one
 * validation batch, writes nothing, and on success logs a summary like
 *
 *     2026-11-02 11:53:53 | Dry run passed: setup, one training batch and one validation batch all ran. Nothing was written to disk.
 *       Model type:          centroid
 *       Labeled frames:      1 train, 1 val
 *       Steps per epoch:     200 train, 1 val
 *       ...
 *
 * (`ModelTrainer._log_dry_run_summary`; the first line carries the log sink's
 * `{time} | ` prefix, the rest are the same multi-line message's bare lines).
 * Also removes what a cancelled dry run left on disk. Kept free of store
 * imports, and Tauri is only imported lazily by the default file access, so it
 * is unit-testable on its own.
 */

/** One `Key: value` line of the dry-run summary, e.g. `Max epochs` / `200`. */
export interface DryRunSummaryField {
  label: string;
  value: string;
}

const PASSED_MARKER = "Dry run passed:";
const SUMMARY_FIELD_RE = /^\s{2,}([A-Za-z][A-Za-z ]*?):\s+(.+?)\s*$/;

/**
 * The summary fields of a passing dry run, in the order sleap-nn printed them,
 * or null when `lines` has no "Dry run passed" line (the run failed, or never
 * reached the end).
 */
export function parseDryRunSummary(lines: string[]): DryRunSummaryField[] | null {
  const start = lines.findIndex((l) => l.includes(PASSED_MARKER));
  if (start < 0) return null;
  const fields: DryRunSummaryField[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = SUMMARY_FIELD_RE.exec(line);
    if (!m) break;
    fields.push({ label: m[1], value: m[2] });
  }
  return fields;
}

/**
 * Whether the installed sleap-nn rejected `--dry-run` as an unknown option,
 * i.e. it predates the flag. Matches both click's plain `Error: No such
 * option: --dry-run` and rich-click's boxed `No such option '--dry-run'.`
 * sleap-nn's version can't tell: a build from `main` with the flag still
 * reports the last release's version.
 */
export function isDryRunUnsupported(lines: string[]): boolean {
  return lines.some((l) => /No such option[:\s]*['"]?--dry-run/.test(l));
}

/** The file access {@link removeDryRunLeftovers} needs; injectable for tests. */
export interface DryRunCleanupFs {
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
}

function defaultCleanupFs(): DryRunCleanupFs {
  return {
    async readDir(path) {
      const { readDir } = await import("@tauri-apps/plugin-fs");
      return (await readDir(path)).map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
    },
    async remove(path, options) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(path, options);
    },
  };
}

/**
 * Clean up after a dry run that was killed (Cancel). sleap-nn writes a dry run's
 * configs, checkpoint and image cache to `<modelDir>/.dryrun-<runName>-<pid>/`
 * and deletes it itself, but a killed process never gets to. This removes that
 * run's scratch folders (only those, by name) and then `modelDir` if it's empty
 * and the dry run created it (`removeModelDirIfEmpty`). Best effort: a folder
 * that's gone or can't be read is left alone.
 */
export async function removeDryRunLeftovers(
  modelDir: string,
  runName: string,
  removeModelDirIfEmpty: boolean,
  fs: DryRunCleanupFs = defaultCleanupFs(),
): Promise<void> {
  const sep = modelDir.includes("\\") && !modelDir.includes("/") ? "\\" : "/";
  const prefix = `.dryrun-${runName}-`;
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = await fs.readDir(modelDir);
  } catch {
    return;
  }
  const scratch = entries.filter((e) => e.isDirectory && e.name.startsWith(prefix));
  for (const e of scratch) {
    try {
      await fs.remove(`${modelDir.replace(/[/\\]+$/, "")}${sep}${e.name}`, { recursive: true });
    } catch {
      /* in use or already gone — leave it */
    }
  }
  if (removeModelDirIfEmpty && entries.length === scratch.length) {
    try {
      await fs.remove(modelDir);
    } catch {
      /* not empty after all — leave it */
    }
  }
}
