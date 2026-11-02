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
 * Kept free of store / Tauri imports so it is unit-testable on its own.
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
