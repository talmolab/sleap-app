/**
 * Compatibility shim for the SLP format 3.0 API of sleap-io.js.
 *
 * sleap-io.js 0.5.17 refuses files it cannot read with `SlpFormatError`, and
 * 0.6.0 reads SLP format 3.0: a 3.0 file loaded without the reader option
 * `format3: "view" | "edit"` throws `SlpFormat3ChoiceError`, view-only labels
 * make every writer throw `SlpViewOnlyError`, points gain `labeled`, and
 * instances, labeled frames and bounding boxes gain `metadata`.
 *
 * The app is still pinned to an older sleap-io.js, which has none of these.
 * Everything the app needs from that API goes through this one module, which
 * declares the types locally and detects the new behaviour at runtime (by
 * error name and by property), so the app compiles and runs against both.
 *
 * THIS MODULE GOES AWAY WITH THE PIN BUMP to sleap-io.js >= 0.6.0: import the
 * types and error classes from `@talmolab/sleap-io.js` instead, replace the
 * `is*Error` helpers with `instanceof`, read `point.labeled`, `x.metadata` and
 * `labels.sourceFormat` directly, call `setSourceAccess` and `copySourceMark`
 * directly, and pass `format3` / `unlabeledAs` to the readers and writers
 * without the casts below.
 *
 * It also holds the embedded frame format of the package exports
 * (`imageFormat` / `imageQuality`, sleap-io.js 0.6.0, not yet published):
 * {@link canWriteJpegFrames} and {@link withImageFormat}. With the bump to a
 * release that has them, JPEG is always available and the writers take the
 * two options without the cast.
 */
import * as sio from "@talmolab/sleap-io.js";
import type { Labels } from "@talmolab/sleap-io.js";
import type { PackageImageOptions } from "@/lib/packageImageFormat";

/**
 * The record-mark helpers of sleap-io.js 0.6.0, absent on the old pin. Read
 * as `(sio as unknown as MarkApi).name` at each use (a static member access,
 * so bundlers still tree-shake the library; never assign the namespace to a
 * variable). Against the old pin, `vite build` warns that these names are not
 * exported: expected, since they read as undefined and every use checks for
 * that. The warnings go away with the pin bump.
 */
interface MarkApi {
  copySourceMark?: (from: object | null | undefined, to: object | null | undefined) => void;
  sourceMarkOf?: (record: object | null | undefined) => SlpSourceFormat | undefined;
  setSourceAccess?: (labels: Labels, access: Format3Access) => void;
}

// ---------------------------------------------------------------------------
// Types (mirrors of sleap-io.js 0.6.0 `codecs/slp/format3.ts`)
// ---------------------------------------------------------------------------

/** What a caller chooses to do with a format 3.0 file at open time. */
export type Format3Access = "view" | "edit";

/** What a format 3.0 file holds that the 2.x layout cannot store. */
export interface Format3Summary {
  formatId: number;
  /** Points with `labeled` and `visible` both false, user and predicted. */
  unlabeledPoints: number;
  unlabeledUserPoints: number;
  unlabeledPredictedPoints: number;
  /** Metadata keys stored per table. */
  metadataKeys: { instances: string[]; frames: string[]; bboxes: string[] };
  /** Columns the reader does not know, as paths like `points/foo`. */
  unknownColumns: string[];
  /**
   * Members of the file the reader does not read at all, as paths (other
   * tables such as `events`, or members such as `categories/meta_key`).
   * Absent from builds of sleap-io.js before this field.
   */
  unreadTables?: string[];
  /** True when an edit would drop nothing. */
  lossless: boolean;
}

/** `labels.sourceFormat` for labels read from a format 3.0 file. */
export interface SlpSourceFormat {
  formatId: number;
  access: Format3Access;
  summary: Format3Summary;
  labelsPath: string;
}

/** A metadata value: one of the kinds format 3.0 can store. */
export type RecordMetadataValue = boolean | number | string;
/** The metadata of one instance, labeled frame or bounding box. */
export type RecordMetadata = Record<string, RecordMetadataValue>;

/** The fields every `SlpFormatError` carries. */
export interface SlpFormatErrorLike extends Error {
  labelsPath: string;
  formatId: number | null;
  unsupportedFeatures: string[];
}

/** An `SlpFormat3ChoiceError`: an `SlpFormatError` with the drop summary. */
export interface SlpFormat3ChoiceErrorLike extends SlpFormatErrorLike {
  summary: Format3Summary;
}

// ---------------------------------------------------------------------------
// Errors (detected by name: the old pin has no such classes to compare with)
// ---------------------------------------------------------------------------

function errorNamed(err: unknown, names: readonly string[]): err is Error {
  return err instanceof Error && names.includes(err.name);
}

/** sleap-io.js refused the file (any `SlpFormatError`, the 3.0 choice included). */
export function isSlpFormatError(err: unknown): err is SlpFormatErrorLike {
  return (
    errorNamed(err, ["SlpFormatError", "SlpFormat3ChoiceError", "SlpTableError"]) &&
    "formatId" in err
  );
}

/** A format 3.0 file whose tables are inconsistent (`SlpTableError`). */
export function isSlpTableError(err: unknown): err is SlpFormatErrorLike {
  return errorNamed(err, ["SlpTableError"]) && "formatId" in err;
}

/** A format 3.0 file was read without the `format3` option. */
export function isSlpFormat3ChoiceError(
  err: unknown,
): err is SlpFormat3ChoiceErrorLike {
  return (
    errorNamed(err, ["SlpFormat3ChoiceError"]) &&
    typeof (err as { summary?: unknown }).summary === "object"
  );
}

/** A writer refused labels opened view-only. */
export function isSlpViewOnlyError(err: unknown): err is Error {
  return errorNamed(err, ["SlpViewOnlyError"]);
}

// ---------------------------------------------------------------------------
// Readers and writers
// ---------------------------------------------------------------------------

/**
 * Reader options with the `format3` choice added. The old pin ignores the
 * key; the cast is only for its option types, which lack it.
 */
export function withFormat3<T>(options: T, access: Format3Access | undefined): T {
  if (access === undefined) return options;
  return { ...(options ?? {}), format3: access } as T;
}

/**
 * Writer options that save unlabelled points as hidden points with no
 * location instead of throwing. The app only holds unlabelled points after the
 * user chose to edit (or merge) a format 3.0 file, after being shown what that
 * drops, so every app writer passes this: it matters for the records the app
 * rebuilds (undo, copies, journal replay), which carry no mark of that choice.
 * Content opened view-only is still refused by the writers themselves. The old
 * pin ignores the key.
 */
export function withLegacyLayout<T extends object = Record<never, never>>(options?: T): T {
  return { ...(options ?? {}), unlabeledAs: "absent" } as T;
}

// ---------------------------------------------------------------------------
// Embedded frame format (`imageFormat` / `imageQuality`)
// ---------------------------------------------------------------------------

/**
 * True when the installed sleap-io.js can store embedded frames as JPEG: its
 * writers then take `imageFormat` / `imageQuality`, and it exports
 * `EMBED_IMAGE_FORMATS`, which lists "jpg". Read as a static member access
 * (see {@link MarkApi}); against the old pin it is undefined, and `vite
 * build` warns that it is not exported. The dialogs disable JPEG, with the
 * reason, when this is false.
 */
export function canWriteJpegFrames(): boolean {
  if (jpegFramesOverride !== null) return jpegFramesOverride;
  const formats = (sio as unknown as { EMBED_IMAGE_FORMATS?: readonly string[] })
    .EMBED_IMAGE_FORMATS;
  return Array.isArray(formats) && formats.includes("jpg");
}

let jpegFramesOverride: boolean | null = null;

/**
 * Test-only: answer {@link canWriteJpegFrames} with `value` instead of
 * asking the installed sleap-io.js (null asks it again), so both answers are
 * tested against either pin.
 */
export function __setJpegFramesSupported(value: boolean | null): void {
  jpegFramesOverride = value;
}

/** Why JPEG can't be chosen, for the dialogs (only when it can't). */
export const JPEG_FRAMES_UNAVAILABLE =
  "This version of the app stores package frames as PNG only.";

/**
 * Writer (and streaming plan) options with the package's frame format. PNG
 * (or no choice) adds nothing, so the export writes exactly what it wrote
 * before the choice existed: new frames as PNG, already-embedded images
 * copied as they are. JPEG adds `imageFormat: "jpg"` and `imageQuality`,
 * which also converts already-embedded images stored in another format.
 * Throws when JPEG is asked of a sleap-io.js that can't write it, rather than
 * silently writing PNG. The cast is only for the old pin's option types.
 */
export function withImageFormat<T extends object>(
  options: T,
  image: PackageImageOptions | null | undefined,
): T {
  if (!image || image.format !== "jpg") return options;
  if (!canWriteJpegFrames()) throw new Error(JPEG_FRAMES_UNAVAILABLE);
  return { ...options, imageFormat: "jpg", imageQuality: image.quality } as T;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `labels.sourceFormat`, or null (old pin, 1.x/2.x files, labels built here). */
export function sourceFormatOf(labels: Labels | null | undefined): SlpSourceFormat | null {
  const sf = (labels as { sourceFormat?: SlpSourceFormat | null } | null | undefined)
    ?.sourceFormat;
  return sf && typeof sf === "object" && typeof sf.access === "string" ? sf : null;
}

/** Labels opened view-only: every writer refuses them. */
export function isViewOnlyLabels(labels: Labels | null | undefined): boolean {
  return sourceFormatOf(labels)?.access === "view";
}

/**
 * Switch labels loaded from a format 3.0 file to `access`, in place: the
 * labels, their lazy store and the mark every record carries (sleap-io.js
 * `setSourceAccess`; its source formats are frozen, so they are never
 * mutated). Switching to "edit" is equivalent to reopening the file with
 * `format3: "edit"`: both choices read the same model, and only the writers
 * look at the choice. No-op for labels not loaded from a 3.0 file.
 */
export function setSourceAccess(labels: Labels, access: Format3Access): void {
  const sf = sourceFormatOf(labels);
  if (!sf || sf.access === access) return;
  const set = (sio as unknown as MarkApi).setSourceAccess;
  if (set) set(labels, access);
  else
    (labels as { sourceFormat?: SlpSourceFormat | null }).sourceFormat = { ...sf, access };
}

/**
 * Give a record the app rebuilt (an undo snapshot, a copy, a converted
 * prediction, a journal replay) the open-time choice of the record it was
 * made from, so writers treat it as that file's content (sleap-io.js
 * `copySourceMark`). No-op on the old pin.
 */
export function copySourceMark(from: object | null | undefined, to: object | null | undefined): void {
  (sio as unknown as MarkApi).copySourceMark?.(from, to);
}

/**
 * Keep a record's open-time choice without keeping the record: a token (an
 * empty object carrying the same mark), or null when the record has none.
 * Give it back with {@link copySourceMark}(token, record).
 */
export function captureSourceMark(record: object): object | null {
  if (!(sio as unknown as MarkApi).sourceMarkOf?.(record)) return null;
  const token = {};
  (sio as unknown as MarkApi).copySourceMark?.(record, token);
  return token;
}

/**
 * Give labels whose records were rebuilt from a draft the source format of
 * the file the project was opened from, when that file is still in format
 * 3.0 on disk (see {@link sourceFormatRecord}). The in-place save and local
 * jobs then know not to read or patch that file as it is.
 */
export function restoreSourceFormat(
  labels: Labels,
  record: { formatId: number; summary: Format3Summary } | null | undefined,
  labelsPath: string,
): void {
  if (!record || sourceFormatOf(labels)) return;
  (labels as { sourceFormat?: SlpSourceFormat | null }).sourceFormat = Object.freeze({
    formatId: record.formatId,
    access: "edit" as const,
    summary: record.summary,
    labelsPath,
  });
}

/**
 * What a draft records about the project's file (for
 * {@link restoreSourceFormat}): its format and drop summary while it is still
 * in format 3.0 on disk, else undefined.
 */
export function sourceFormatRecord(
  labels: Labels,
): { formatId: number; summary: Format3Summary } | undefined {
  const sf = sourceFormatOf(labels);
  return sf ? { formatId: sf.formatId, summary: sf.summary } : undefined;
}

/**
 * After labels opened for editing from a format 3.0 file were saved over
 * their file (now in the 2.x layout): clear `labels.sourceFormat`, as
 * sleap-io.js asks, so the in-place save functions patch that file again. Each
 * record keeps its own mark of the open-time choice. No-op for labels opened
 * View only (never saved) or not from a 3.0 file.
 */
export function markSavedInLegacyLayout(labels: Labels): void {
  if (sourceFormatOf(labels)?.access !== "edit") return;
  (labels as { sourceFormat?: SlpSourceFormat | null }).sourceFormat = null;
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** The point fields the app reads and copies. */
export interface PointLike {
  xy: [number, number] | ArrayLike<number>;
  visible: boolean;
  complete: boolean;
  score?: number;
  name?: string;
}

/** A plain point literal, as the Instance constructors take. */
export interface PointData {
  xy: [number, number];
  visible: boolean;
  complete: boolean;
  score?: number;
  name?: string;
  /** Present (and false) only for a point the source did not annotate. */
  labeled?: false;
}

/**
 * Whether the source annotated this node. A point is unlabelled when its
 * `labeled` flag is false; absent means labelled (always so on the old pin).
 */
export function isPointLabeled(p: PointLike): boolean {
  return (p as { labeled?: boolean }).labeled !== false;
}

/**
 * A node that was not annotated in this instance, as opposed to a hidden one:
 * `labeled` and `visible` both false. sleap-io.js counts a visible point as
 * labelled whatever its flag says.
 */
export function isUnlabeledPoint(p: PointLike): boolean {
  return !isPointLabeled(p) && !p.visible;
}

/**
 * Mark a point labelled (placing or dragging a node labels it). A no-op on the
 * old pin, whose points have no flag.
 *
 * There is deliberately no way to mark a node as not labelled: sleap-io.js
 * saves only the 2.x layout, which cannot store the mark, so it would be lost
 * at save time. That waits for a format 3.0 writer.
 */
export function markPointLabeled(p: PointLike): void {
  if ("labeled" in p) (p as { labeled?: boolean }).labeled = true;
}

/**
 * Give `target` the source point's `labeled` flag (used where the app copies
 * point fields one by one onto an existing point).
 */
export function copyPointLabeled(source: PointLike, target: PointLike): void {
  if (!isPointLabeled(source)) {
    (target as { labeled?: boolean }).labeled = false;
  } else {
    markPointLabeled(target);
  }
}

/**
 * Deep-copy a point into a plain literal, keeping `labeled` (as sleap-io.js
 * `clonePoint` does from 0.6.0). `instance.points[i]` is a view whose fields
 * are accessors, so a spread would drop them. `score` is kept when it is a
 * number; `overrides` replace fields after copying.
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

/** A record's metadata, or null when it has none (always so on the old pin). */
export function metadataOf(record: object | null | undefined): RecordMetadata | null {
  const md = (record as { metadata?: unknown } | null | undefined)?.metadata;
  if (!md || typeof md !== "object" || Array.isArray(md)) return null;
  return Object.keys(md).length > 0 ? (md as RecordMetadata) : null;
}

/** Set a record's metadata to a copy of `metadata` (no-op for null). */
export function setMetadata(record: object, metadata: RecordMetadata | null | undefined): void {
  if (!metadata || Object.keys(metadata).length === 0) return;
  (record as { metadata?: RecordMetadata }).metadata = { ...metadata };
}

/** Copy `source`'s metadata onto `target`. Returns `target`. */
export function copyMetadata<T extends object>(source: object, target: T): T {
  setMetadata(target, metadataOf(source));
  return target;
}
