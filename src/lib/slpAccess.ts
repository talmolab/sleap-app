/**
 * How the app handles SLP files it cannot read, SLP format 3.0 files (read,
 * but saved only in the older 2.x layout), and projects opened View only.
 *
 * - A refused file gets its own dialog ({@link showSlpRefusal}), not the
 *   generic load-failure toast.
 * - A format 3.0 file asks at open time ({@link askFormat3Access}): View only,
 *   or Edit with the list of what saving in the 2.x layout drops.
 * - A View only project cannot be edited (commands and canvas edits are
 *   refused, see {@link refuseEditIfViewOnly}) and nothing writes it
 *   ({@link ensureWritable} before every save and export, and sleap-io.js's
 *   writers refuse it too). The banner and the save/export prompts offer to
 *   allow editing, which shows the same list first.
 */
import type { Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { askSlpFormat, useSlpAccessNonce } from "@/stores/slpFormatStore";
import { toast } from "@/lib/notify";
import {
  isSlpFormat3ChoiceError,
  isSlpFormatError,
  isSlpTableError,
  isSlpViewOnlyError,
  isViewOnlyLabels,
  setEditableInPlace,
  sourceFormatOf,
  type Format3Access,
  type Format3Summary,
  type SlpFormatErrorLike,
} from "@/lib/slpFormatCompat";

/** `3` → "3.0", `2.8` → "2.8": SLP formats are named this way. */
export function formatLabel(formatId: number | null): string {
  if (formatId === null || Number.isNaN(formatId)) return "unknown";
  return Number.isInteger(formatId) ? formatId.toFixed(1) : String(formatId);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What saving a format 3.0 file in the 2.x layout drops, one line per kind.
 * Empty when nothing is dropped.
 */
export function describeFormat3Drops(summary: Format3Summary): string[] {
  const drops: string[] = [];
  if (summary.unlabeledPoints > 0) {
    const parts: string[] = [];
    if (summary.unlabeledUserPoints > 0) {
      parts.push(`${summary.unlabeledUserPoints} in user instances`);
    }
    if (summary.unlabeledPredictedPoints > 0) {
      parts.push(`${summary.unlabeledPredictedPoints} in predictions`);
    }
    drops.push(
      `${plural(summary.unlabeledPoints, "node", "nodes")} marked as not labelled` +
        (parts.length > 0 ? ` (${parts.join(", ")})` : "") +
        ": saved as hidden nodes with no position",
    );
  }
  const tables: Array<[keyof Format3Summary["metadataKeys"], string]> = [
    ["instances", "Instance metadata"],
    ["frames", "Frame metadata"],
    ["bboxes", "Bounding box metadata"],
  ];
  for (const [table, what] of tables) {
    const keys = summary.metadataKeys?.[table] ?? [];
    if (keys.length > 0) drops.push(`${what}: ${keys.join(", ")}`);
  }
  if (summary.unknownColumns.length > 0) {
    drops.push(
      `Columns this version doesn't know: ${summary.unknownColumns.join(", ")}`,
    );
  }
  return drops;
}

/**
 * Why a refused file cannot be opened, and which tool reads it.
 */
export function refusalReason(
  formatId: number | null,
  unsupportedFeatures: string[],
  damagedTables = false,
): string {
  if (damagedTables) {
    return (
      `Its tables are inconsistent (see the details below), so it can't be read ` +
      "safely. Check it with Python sleap-io 0.10 or newer, or with the tool " +
      "that wrote it."
    );
  }
  if (formatId !== null && formatId >= 4) {
    return (
      `It is in SLP format ${formatLabel(formatId)}, written by a newer tool than ` +
      "this version of SLEAP can read. Open it with the tool that wrote it, or " +
      "update SLEAP."
    );
  }
  if (unsupportedFeatures.length > 0) {
    return (
      "It needs features this version of SLEAP does not support " +
      `(${unsupportedFeatures.join(", ")}). A recent Python sleap-io reads it.`
    );
  }
  return (
    `It is in SLP format ${formatLabel(formatId)}, which this version of SLEAP ` +
    "can't read in full (see the details below). Python sleap-io 0.10 or newer " +
    "reads it."
  );
}

/**
 * Whether saving a copy in the 2.x layout with Python sleap-io is the way to
 * open a refused file here (not for formats newer than that tool knows).
 */
export function canSaveLegacyCopy(formatId: number | null): boolean {
  return formatId === null || formatId < 4;
}

/** Python that saves a copy of `fileName` in the 2.x layout, which this app reads. */
export function legacyCopyCommand(fileName: string): string {
  const stem = fileName.replace(/\.slp$/i, "");
  const quote = (s: string) => JSON.stringify(s);
  return [
    "import sleap_io as sio",
    "",
    `labels = sio.load_slp(${quote(fileName)})`,
    `labels.save(${quote(`${stem}.v2.slp`)}, legacy_format=True, unlabeled_as="absent")`,
  ].join("\n");
}

/** The last path segment of a path or URL, for messages. */
export function displayFileName(pathOrName: string | null | undefined): string {
  if (!pathOrName) return "This file";
  const clean = pathOrName.split(/[?#]/)[0];
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? pathOrName;
}

// ---------------------------------------------------------------------------
// Errors the dialogs have already reported
// ---------------------------------------------------------------------------

const reported = new WeakSet<object>();

/** The user cancelled the format 3.0 choice; nothing was opened. */
export class SlpOpenCancelled extends Error {
  constructor(fileName: string) {
    super(`Opening ${fileName} was cancelled.`);
    this.name = "SlpOpenCancelled";
    reported.add(this);
  }
}

/**
 * Whether the user has already been told about this error by a dialog (a
 * refusal, or a cancelled open). Callers skip their own toast for these.
 */
export function isReportedSlpError(err: unknown): boolean {
  return typeof err === "object" && err !== null && reported.has(err);
}

/** Mark an error as already shown to the user. */
export function markReported(err: unknown): void {
  if (typeof err === "object" && err !== null) reported.add(err);
}

/**
 * Toast a load failure unless a dialog already reported it. The one place the
 * readers' callers turn an error into a toast.
 */
export function toastLoadError(title: string, err: unknown, description?: string): void {
  if (isReportedSlpError(err)) return;
  const msg = description ?? (err instanceof Error ? err.message : String(err));
  toast.error(title, { description: msg });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Show the dialog for a file sleap-io.js refused, and mark the error reported.
 */
export async function showSlpRefusal(
  err: SlpFormatErrorLike,
  fileName?: string,
): Promise<void> {
  markReported(err);
  await askSlpFormat({
    kind: "refused",
    fileName: displayFileName(fileName ?? err.labelsPath),
    formatId: err.formatId,
    unsupportedFeatures: err.unsupportedFeatures ?? [],
    damagedTables: isSlpTableError(err),
    detail: err.message,
  });
}

/**
 * Ask how to open a format 3.0 file. `merge` asks only whether to merge (a
 * merged file is never written back, but the project it joins is).
 *
 * @returns The `format3` option to read the file with, or null if cancelled.
 */
export async function askFormat3Access(
  summary: Format3Summary,
  fileName: string,
  purpose: "open" | "merge",
): Promise<Format3Access | null> {
  const answer = await askSlpFormat({
    kind: purpose,
    fileName: displayFileName(fileName),
    summary,
  });
  if (answer === "view" && purpose === "open") return "view";
  if (answer === "edit") return "edit";
  return null;
}

/** How a reader handles a format 3.0 file (see `slpRead.ts`). */
export type Format3Policy = "ask" | "merge" | Format3Access;

/**
 * Run a read, handling what sleap-io.js refuses: a format 3.0 file asks
 * (per `policy`) and is read again with the answer; any other refusal shows
 * its dialog. Refusals and a cancelled choice rethrow, marked reported.
 */
export async function readWithFormatChoice<T>(
  read: (access: Format3Access | undefined) => Promise<T>,
  policy: Format3Policy,
  fileName: string | undefined,
  refusal: "dialog" | "throw" = "dialog",
): Promise<T> {
  try {
    return await read(policy === "view" || policy === "edit" ? policy : undefined);
  } catch (err) {
    if (isSlpFormat3ChoiceError(err) && (policy === "ask" || policy === "merge")) {
      const name = displayFileName(fileName ?? err.labelsPath);
      const access = await askFormat3Access(err.summary, name, policy === "ask" ? "open" : "merge");
      if (access === null) throw new SlpOpenCancelled(name);
      return await read(access);
    }
    if (isSlpFormatError(err) && refusal === "dialog") {
      await showSlpRefusal(err, fileName);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// View only projects
// ---------------------------------------------------------------------------

/** The open project was opened View only. */
export function isProjectViewOnly(): boolean {
  return isViewOnlyLabels(useAppStore.getState().labels);
}

/**
 * Ask to make a view-only project editable; on yes, make it so in place and
 * return true. `action` names what the user was doing ("save", "export").
 */
export async function allowEditing(labels: Labels, action?: string): Promise<boolean> {
  const sf = sourceFormatOf(labels);
  if (!sf || sf.access !== "view") return true;
  const answer = await askSlpFormat({
    kind: "allow-edit",
    fileName: displayFileName(useAppStore.getState().filename ?? sf.labelsPath),
    summary: sf.summary,
    action,
  });
  if (answer !== "edit") return false;
  setEditableInPlace(labels);
  useSlpAccessNonce.getState().bump();
  return true;
}

/**
 * Before any write of `labels` (save, export, draft): true when writable. A
 * view-only project asks to allow editing first (so changes are never trapped);
 * without a yes, nothing is written and this returns false.
 */
export async function ensureWritable(
  labels: Labels | null | undefined,
  action: string,
): Promise<boolean> {
  if (!labels || !isViewOnlyLabels(labels)) return true;
  return allowEditing(labels, action);
}

/**
 * Turn a writer's `SlpViewOnlyError` (the backstop when an app check was
 * missed) into the allow-editing prompt. Returns true when the error was one.
 */
export function handleViewOnlyWriteError(err: unknown): boolean {
  if (!isSlpViewOnlyError(err)) return false;
  const labels = useAppStore.getState().labels;
  if (labels) void allowEditing(labels, "save");
  return true;
}

/**
 * Refuse an edit of a view-only project: tell the user (with an action to
 * allow editing) and return true. Returns false when editing is allowed.
 */
export function refuseEditIfViewOnly(): boolean {
  const labels = useAppStore.getState().labels;
  if (!isViewOnlyLabels(labels)) return false;
  toast.info("This file is open View only", {
    id: "view-only-edit",
    description: "Editing is off, and nothing is written back to the file.",
    action: labels
      ? { label: "Allow editing…", onClick: () => void allowEditing(labels) }
      : undefined,
    duration: 5000,
  });
  return true;
}
