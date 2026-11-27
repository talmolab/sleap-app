/**
 * App-level helpers for SLP format 3.0 errors, points, record metadata, draft
 * source-format records, and explicit 2.x legacy write options.
 *
 * All core types, error classes, and mark functions come directly from
 * `@talmolab/sleap-io.js` (`>= 0.6.0-alpha.0`). Error guards check both live
 * `instanceof` and `err.name` so Worker-serialized errors are recognized too.
 */
import * as sio from "@talmolab/sleap-io.js";
import type {
  Format3Access,
  Format3Summary,
  Labels,
  RecordMetadata,
  SlpSourceFormat,
  SlpViewOnlyError,
  SlpWriteOptions,
  StreamingIncompleteError,
} from "@talmolab/sleap-io.js";

/** The fields an `SlpFormatError` carries (including Worker-serialized copies). */
export interface SlpFormatErrorLike {
  name?: string;
  message: string;
  labelsPath?: string;
  formatId?: number | null;
  unsupportedFeatures?: string[];
  requiredFeatures?: string[];
}

/** An `SlpFormat3ChoiceError` (live or Worker-serialized) with its summary. */
export interface SlpFormat3ChoiceErrorLike extends SlpFormatErrorLike {
  summary: Format3Summary;
}

/**
 * Serialized representation of `labels.sourceFormat` stored in crash-recovery
 * draft manifests while a project's on-disk file is still in SLP format 3.0.
 */
export interface DraftSourceFormat {
  formatId: number;
  summary: Format3Summary;
  /** Open-time access mode (`"keep"` for native 3.0 saves, `"edit"` for 2.x). */
  access?: "keep" | "edit";
}

// ---------------------------------------------------------------------------
// Error guards (live instanceof + Worker-serialized name fallback)
// ---------------------------------------------------------------------------

function errorNamed(
  err: unknown,
  names: readonly string[],
): err is { name: string; message: string } {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; message?: unknown };
  return (
    typeof candidate.name === "string" &&
    names.includes(candidate.name) &&
    typeof candidate.message === "string"
  );
}

/** True for any `SlpFormatError` (including `SlpFormat3ChoiceError`, `SlpTableError`, and Worker-serialized copies). */
export function isSlpFormatError(err: unknown): err is SlpFormatErrorLike {
  if (typeof sio.SlpFormatError === "function" && err instanceof sio.SlpFormatError) return true;
  return errorNamed(err, ["SlpFormatError", "SlpFormat3ChoiceError", "SlpTableError"]);
}

/** True for an `SlpTableError` (damaged/inconsistent format 3.0 tables). */
export function isSlpTableError(err: unknown): err is SlpFormatErrorLike {
  if (typeof sio.SlpTableError === "function" && err instanceof sio.SlpTableError) return true;
  return errorNamed(err, ["SlpTableError"]);
}

/** True for an `SlpFormat3ChoiceError` carrying a `Format3Summary`. */
export function isSlpFormat3ChoiceError(
  err: unknown,
): err is SlpFormat3ChoiceErrorLike {
  if (typeof sio.SlpFormat3ChoiceError === "function" && err instanceof sio.SlpFormat3ChoiceError) {
    return true;
  }
  return (
    errorNamed(err, ["SlpFormat3ChoiceError"]) &&
    typeof (err as { summary?: unknown }).summary === "object" &&
    (err as { summary?: unknown }).summary !== null
  );
}

/** True for an `SlpViewOnlyError` thrown when writing View-only labels. */
export function isSlpViewOnlyError(err: unknown): err is SlpViewOnlyError {
  if (typeof sio.SlpViewOnlyError === "function" && err instanceof sio.SlpViewOnlyError) return true;
  return err instanceof Error && err.name === "SlpViewOnlyError";
}

/**
 * True for a `StreamingIncompleteError` thrown by `readSlpStreaming(..., { failIfIncomplete: true })`
 * when a file carries non-pose format 3.0 tables (ROIs, masks, label images,
 * session links) that the streaming pose-only reader does not load.
 */
export function isStreamingIncompleteError(err: unknown): err is StreamingIncompleteError {
  if (typeof sio.StreamingIncompleteError === "function" && err instanceof sio.StreamingIncompleteError) {
    return true;
  }
  return errorNamed(err, ["StreamingIncompleteError"]);
}

// ---------------------------------------------------------------------------
// Explicit 2.x legacy write options (for legacy sleap-nn < 0.4 / NWB interop)
// ---------------------------------------------------------------------------

/**
 * Writer options that explicitly write the SLP 2.x layout and map any
 * unlabeled points to absent (`labeled=true, visible=false, xy=[NaN, NaN]`).
 *
 * Used only for legacy interoperability targets (such as `sleap-nn < 0.4`
 * job copies or NWB conversion). User project saves, packages, and drafts use
 * `slpVersion: "auto"` so SLP format 3.0 is preserved natively.
 */
export function legacyV2WriteOptions<T extends SlpWriteOptions = SlpWriteOptions>(
  options?: T,
): T & { slpVersion: "v2"; unlabeledAs: "absent" } {
  return {
    ...(options ?? ({} as T)),
    slpVersion: "v2",
    unlabeledAs: "absent",
  };
}

// ---------------------------------------------------------------------------
// Labels sourceFormat & WeakMap source marks
// ---------------------------------------------------------------------------

/** Labels opened View only: every writer refuses them. */
export function isViewOnlyLabels(labels: Labels | null | undefined): boolean {
  return labels?.sourceFormat?.access === "view";
}

/** Switch `labels`'s format 3.0 access in place (delegates to sleap-io.js). */
export function setSourceAccess(labels: Labels, access: Format3Access): void {
  if (typeof sio.setSourceAccess === "function") {
    sio.setSourceAccess(labels, access);
    return;
  }
  if (labels.sourceFormat) {
    labels.sourceFormat = Object.freeze({ ...labels.sourceFormat, access });
  }
}

/** Copy a record's format 3.0 source mark onto `target`. */
export function copySourceMark(source: object, target: object): void {
  if (typeof sio.copySourceMark === "function") sio.copySourceMark(source, target);
}

/**
 * Capture a record's format 3.0 source mark onto a lightweight token object
 * without retaining the record itself; restore with `copySourceMark(token, record)`.
 */
export function captureSourceMark(record: object): object | null {
  if (typeof sio.sourceMarkOf !== "function" || !sio.sourceMarkOf(record)) return null;
  const token = {};
  copySourceMark(record, token);
  return token;
}

/**
 * Record `labels.sourceFormat` for persistence in a crash-recovery draft
 * manifest while the project's on-disk file is in SLP format 3.0.
 */
export function sourceFormatRecord(labels: Labels): DraftSourceFormat | undefined {
  const sf = labels.sourceFormat;
  if (!sf) return undefined;
  return {
    formatId: sf.formatId,
    summary: sf.summary,
    access: sf.access === "edit" ? "edit" : "keep",
  };
}

/**
 * Restore `labels.sourceFormat` from a crash-recovery draft manifest entry
 * when `labels` does not already carry one.
 */
export function restoreSourceFormat(
  labels: Labels,
  record: DraftSourceFormat | null | undefined,
  labelsPath: string,
): void {
  if (!record || labels.sourceFormat) return;
  const access: "keep" | "edit" = record.access === "edit" ? "edit" : "keep";
  labels.sourceFormat = Object.freeze({
    formatId: record.formatId,
    access,
    summary: record.summary,
    labelsPath,
  });
}

/**
 * Clear `labels.sourceFormat` after explicitly saving a format 3.0 project
 * over its on-disk file in the 2.x layout (`access === "edit"`).
 */
export function markSavedInLegacyLayout(labels: Labels): void {
  if (labels.sourceFormat?.access !== "edit") return;
  labels.sourceFormat = null;
}

// ---------------------------------------------------------------------------
// Points (`labeled` flag helpers)
// ---------------------------------------------------------------------------

/** Minimal point shape accepted by app point helpers. */
export interface PointLike {
  xy: [number, number] | ArrayLike<number>;
  visible: boolean;
  complete: boolean;
  labeled?: boolean;
  score?: number;
  name?: string;
}

/** Plain point literal suitable for `new Instance({ points })`. */
export interface PointData {
  xy: [number, number];
  visible: boolean;
  complete: boolean;
  score?: number;
  name?: string;
  /** Present (and false) only for an unlabeled node (SLP format 3.0). */
  labeled?: false;
}

/** Whether the source annotated this node (`labeled !== false`). */
export function isPointLabeled(p: PointLike): boolean {
  return p.labeled !== false;
}

/** Whether a node is unlabeled (`labeled === false` and `!visible`). */
export function isUnlabeledPoint(p: PointLike): boolean {
  return !isPointLabeled(p) && !p.visible;
}

/** Mark a point as labeled (`labeled = true`) when the point carries the flag. */
export function markPointLabeled(p: PointLike): void {
  if ("labeled" in p) p.labeled = true;
}

/** Copy `source`'s `labeled` flag onto `target`. */
export function copyPointLabeled(source: PointLike, target: PointLike): void {
  const labeled = isPointLabeled(source);
  if (!labeled || "labeled" in target) target.labeled = labeled;
}

/**
 * Deep-copy a point (or `PointView` flyweight) into a plain `PointData`
 * literal, preserving `labeled: false` and `score`, with optional overrides.
 */
export function copyPoint(p: PointLike, overrides?: Partial<PointData>): PointData {
  const out: PointData = {
    xy: [p.xy[0], p.xy[1]],
    visible: p.visible,
    complete: p.complete,
    name: p.name,
  };
  if (typeof p.score === "number") out.score = p.score;
  if (!isPointLabeled(p)) out.labeled = false;
  return overrides ? { ...out, ...overrides } : out;
}

// ---------------------------------------------------------------------------
// Record metadata (instances, labeled frames, bounding boxes)
// ---------------------------------------------------------------------------

/** Return a record's non-empty metadata dictionary, or `null` if empty/absent. */
export function metadataOf(
  record: { metadata?: RecordMetadata | null } | null | undefined,
): RecordMetadata | null {
  const md = record?.metadata;
  if (!md || typeof md !== "object" || Array.isArray(md)) return null;
  return Object.keys(md).length > 0 ? md : null;
}

/** Set a record's metadata to a shallow copy of `metadata` (no-op if empty/null). */
export function setMetadata(
  record: { metadata?: RecordMetadata },
  metadata: RecordMetadata | null | undefined,
): void {
  if (!metadata || Object.keys(metadata).length === 0) return;
  record.metadata = { ...metadata };
}

/** Copy `source`'s non-empty metadata onto `target`. Returns `target`. */
export function copyMetadata<T extends { metadata?: RecordMetadata }>(
  source: { metadata?: RecordMetadata | null },
  target: T,
): T {
  setMetadata(target, metadataOf(source));
  return target;
}

export type { Format3Summary, RecordMetadata, SlpSourceFormat };
