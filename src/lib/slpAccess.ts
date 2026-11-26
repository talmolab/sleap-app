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
import { confirmDialog } from "@/stores/confirmStore";
import {
  isSlpFormat3ChoiceError,
  isSlpFormatError,
  isSlpTableError,
  isSlpViewOnlyError,
  isUnlabeledPoint,
  isViewOnlyLabels,
  setSourceAccess,
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
    const one = summary.unlabeledPoints === 1;
    drops.push(
      `${plural(summary.unlabeledPoints, "node", "nodes")} marked as not labeled` +
        (parts.length > 0 ? ` (${parts.join(", ")})` : "") +
        `: saved as ${one ? "a hidden node" : "hidden nodes"} with no position`,
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
  const unread = summary.unreadTables ?? [];
  if (unread.length > 0) {
    drops.push(`Parts of the file this version doesn't read: ${unread.join(", ")}`);
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
      "It was written by a newer tool than this version of SLEAP can read. " +
      "Open it with the tool that wrote it, or update SLEAP."
    );
  }
  if (unsupportedFeatures.length > 0) {
    return (
      "It needs features this version of SLEAP does not support " +
      `(${unsupportedFeatures.join(", ")}). A recent Python sleap-io reads it.`
    );
  }
  return (
    "This version of SLEAP can't read all of it (see the details below). " +
    "Python sleap-io 0.10 or newer reads it."
  );
}

/**
 * Whether saving a copy in the 2.x layout with Python sleap-io is the way to
 * open a refused file here (not for formats newer than that tool knows).
 */
export function canSaveLegacyCopy(formatId: number | null): boolean {
  return formatId === null || formatId < 4;
}

/** GitHub Releases landing page opened by `[Upgrade]` in the web build. */
export const SLEAP_APP_RELEASES_PAGE_URL =
  "https://github.com/talmolab/sleap-app/releases";

/** Fallback parser when a Worker-serialized error retains only its `message`. */
function parseFormatIdFromMessage(message: string): number | null {
  const match = /\bSLP format\s+(\d+(?:\.\d+)?)\b/i.exec(message);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFeatureList(err: SlpFormatErrorLike): string[] {
  const raw = err.unsupportedFeatures ?? err.requiredFeatures;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Python that saves a copy of `fileName` in the 2.x layout, which this app reads. */
export function legacyCopyCommand(fileName: string): string {
  const input = fileName && fileName !== "This file" ? fileName : "input.slp";
  const stem = input.replace(/\.slp$/i, "");
  return [
    "import sleap_io as sio",
    `labels = sio.load_slp(${JSON.stringify(input)})`,
    `labels.save(${JSON.stringify(`${stem}.v2.slp`)}, slp_version="v2")`,
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

/**
 * Job predictions were not merged: the project is open View only and the user
 * did not allow editing. Callers keep the predictions pending and report
 * nothing as merged.
 */
export class PredictionsNotMerged extends Error {
  constructor() {
    super("The predictions were not added: the project is open View only.");
    this.name = "PredictionsNotMerged";
  }
}

/**
 * Before job predictions are merged into the open project: a View only
 * project asks to allow editing first. Throws {@link PredictionsNotMerged}
 * when the user declines.
 */
export async function ensurePredictionsMergeable(): Promise<void> {
  const labels = useAppStore.getState().labels;
  if (!(await ensureWritable(labels, "predictions"))) throw new PredictionsNotMerged();
}

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
 * Opens the modal without blocking so the caller's `finally` block clears any
 * loading overlay immediately while leaving the refusal dialog visible.
 */
export function showSlpRefusal(
  err: SlpFormatErrorLike,
  fileName?: string,
): void {
  markReported(err);
  const formatId =
    typeof err.formatId === "number" && Number.isFinite(err.formatId)
      ? err.formatId
      : parseFormatIdFromMessage(err.message);
  void askSlpFormat({
    kind: "refused",
    fileName: displayFileName(fileName ?? err.labelsPath),
    formatId,
    unsupportedFeatures: normalizeFeatureList(err),
    damagedTables: isSlpTableError(err),
    detail: err.message,
  });
}

/**
 * If `err` is an `SlpFormatError` (live or Worker-serialized), ensure the
 * refusal modal is open and return `true` so callers skip generic error toasts.
 */
export function handleSlpFormatError(
  err: unknown,
  fileName?: string,
): boolean {
  if (!isSlpFormatError(err) || isSlpFormat3ChoiceError(err)) return false;
  if (!isReportedSlpError(err)) showSlpRefusal(err, fileName);
  return true;
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
      showSlpRefusal(err, fileName);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// View only projects
// ---------------------------------------------------------------------------

/** What the user was doing when asked to allow editing (see {@link allowEditText}). */
export type AllowEditAction = "save" | "export" | "predictions" | "train" | "check";

/** The allow-editing prompt's sentence and button for `action`. */
export function allowEditText(action: AllowEditAction | undefined): { message: string; button: string } {
  switch (action) {
    case "save":
      return {
        message: "It was opened View only, so it can't be saved until editing is allowed.",
        button: "Allow editing and save",
      };
    case "export":
      return {
        message: "It was opened View only, so it can't be exported until editing is allowed.",
        button: "Allow editing and export",
      };
    case "predictions":
      return {
        message: "It was opened View only. Allow editing to add the job's predictions to this project?",
        button: "Allow editing",
      };
    case "train":
      return {
        message: "It was opened View only. Allow editing to train on this project? Any predictions made after training are added to it.",
        button: "Allow editing and train",
      };
    case "check":
      return {
        message: "It was opened View only. Allow editing to check training on this project? The check reads a copy of it in the 2.x layout.",
        button: "Allow editing and check",
      };
    default:
      return {
        message: "It was opened View only. Allowing editing lets you change and save it.",
        button: "Allow editing",
      };
  }
}

/** The open project was opened View only. */
export function isProjectViewOnly(): boolean {
  return isViewOnlyLabels(useAppStore.getState().labels);
}

/**
 * Ask to make a view-only project editable; on yes, make it so in place and
 * return true. `action` names what the user was doing ("save", "export").
 */
export async function allowEditing(labels: Labels, action?: AllowEditAction): Promise<boolean> {
  const sf = sourceFormatOf(labels);
  if (!sf || sf.access !== "view") return true;
  const answer = await askSlpFormat({
    kind: "allow-edit",
    fileName: displayFileName(useAppStore.getState().filename ?? sf.labelsPath),
    summary: sf.summary,
    action,
  });
  if (answer !== "edit") return false;
  setSourceAccess(labels, "edit");
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
  action: AllowEditAction,
): Promise<boolean> {
  if (!labels || !isViewOnlyLabels(labels)) return true;
  return allowEditing(labels, action);
}

/**
 * Turn a writer's `SlpViewOnlyError` for a project opened View only (the
 * backstop when an app check was missed) into the allow-editing prompt.
 * Returns true when it did. Any other error, including View only content
 * that ended up in an editable project, is left to the caller's error toast.
 */
export function handleViewOnlyWriteError(err: unknown, action: AllowEditAction = "save"): boolean {
  if (!isSlpViewOnlyError(err) || !isProjectViewOnly()) return false;
  const labels = useAppStore.getState().labels;
  if (labels) void allowEditing(labels, action);
  return true;
}

/**
 * Refuse an edit of a view-only project: tell the user (with an action to
 * allow editing) and return true. Returns false when editing is allowed.
 * `quiet` refuses without the toast, for a gesture that may only be a
 * selection (the banner already says the project is View only).
 */
export function refuseEditIfViewOnly(opts?: { quiet?: boolean }): boolean {
  const labels = useAppStore.getState().labels;
  if (!isViewOnlyLabels(labels)) return false;
  if (opts?.quiet) return true;
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

// ---------------------------------------------------------------------------
// Jobs built from a project with nodes not labelled
// ---------------------------------------------------------------------------

/**
 * How many nodes of user instances in `labels` are marked as not labeled (SLP
 * format 3.0). Training uses user instances only; predictions are left out.
 */
export function countUnlabeledNodes(labels: Labels | null | undefined): number {
  let n = 0;
  for (const lf of labels?.labeledFrames ?? []) {
    for (const inst of lf.instances) {
      if ("score" in inst) continue; // a prediction (as the canvas tells them apart)
      for (const p of inst.points) if (isUnlabeledPoint(p)) n++;
    }
  }
  return n;
}

/**
 * Before a training or inference job is built from the open project: if it
 * holds nodes marked as not labelled (an SLP format 3.0 file opened for
 * editing, or merged in), say once that the job sees them as hidden nodes and
 * ask to continue. Job inputs are written in the 2.x layout (the sleap-nn the
 * app runs reads no other), which cannot store the mark. True to go on.
 */
export async function confirmUnlabeledAsHidden(
  labels: Labels | null | undefined,
  job: "training" | "inference",
): Promise<boolean> {
  const n = countUnlabeledNodes(labels);
  if (n === 0) return true;
  const nodes = plural(n, "node", "nodes");
  const them = n === 1 ? "it as a hidden node" : "them as hidden nodes";
  return confirmDialog({
    title: "Nodes not labeled will count as hidden",
    message:
      `This project has ${nodes} marked as not labeled. The ${job} job reads ` +
      "the project in the older 2.x layout, which can't store that mark, so " +
      (job === "training"
        ? `the model trains on ${them} (annotated as not visible).`
        : `it sees ${them} (annotated as not visible).`),
    confirmLabel: "Continue",
    cancelLabel: "Cancel",
  });
}

/**
 * Before a training or inference job that uses the open project (its labels
 * go into the job, or its predictions come back into the project):
 * - a View only project asks to allow editing first (the job's output would
 *   be refused otherwise, and the job's 2.x copy of the project can't be
 *   written); Cancel stops the job;
 * - when the job's data is built from the project (`buildsFromProject`),
 *   nodes not labeled are announced as hidden ({@link confirmUnlabeledAsHidden}).
 * True to go on.
 */
export async function confirmJobFromProject(
  job: "training" | "inference",
  opts: { buildsFromProject: boolean },
): Promise<boolean> {
  const labels = useAppStore.getState().labels;
  if (!labels) return true;
  const action: AllowEditAction = job === "training" ? "train" : "predictions";
  if (!(await ensureWritable(labels, action))) return false;
  if (opts.buildsFromProject && !(await confirmUnlabeledAsHidden(labels, job))) return false;
  return true;
}
