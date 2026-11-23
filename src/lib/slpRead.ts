/**
 * The app's `.slp` readers: sleap-io.js's `loadSlp` / `readSlpStreaming` with
 * `repairPointSpans: true`, and a warning toast when a file needed it.
 *
 * Since sleap-io.js 0.5.16, a file whose instances have more or fewer stored
 * points than their skeleton has nodes throws `SlpPointSpanError` by default
 * (Python sleap-io does the same). Older sleap-io.js versions wrote such files
 * when an instance's skeleton was missing from the labels, so users have them.
 * The app opts in to sleap-io.js's repair so those files still open; the
 * points are kept as stored, and the user is told which file and how many
 * instances to check.
 *
 * sleap-io.js reports a repair only with `console.warn("[sleap-io] …")`, so
 * the warnings logged while a read runs are collected here and shown once it
 * finishes. Import `loadSlp` / `readSlpStreaming` from this module, not from
 * `@talmolab/sleap-io.js`, wherever the app reads a project or labels file.
 *
 * They also handle files sleap-io.js refuses (`SlpFormatError`: a newer
 * format, unknown required features) with a dialog instead of a bare error,
 * and SLP format 3.0 files, which a reader opens only with an explicit
 * choice: View only (nothing is written back) or Edit (saving writes the 2.x
 * layout and drops what it cannot store). Every caller says how with
 * `format3` (see {@link SlpReadOptions}); the default asks the user.
 */
import {
  loadSlp as ioLoadSlp,
  readSlpStreaming as ioReadSlpStreaming,
} from "@talmolab/sleap-io.js";
import { toast } from "./notify";
import { readWithFormatChoice, type Format3Policy } from "./slpAccess";
import { withFormat3 } from "./slpFormatCompat";

type LoadArgs = Parameters<typeof ioLoadSlp>;
type StreamArgs = Parameters<typeof ioReadSlpStreaming>;
/** sleap-io.js's reader options without its `format3` (the app sets that). */
type IoLoadOptions = Omit<NonNullable<LoadArgs[1]>, "format3">;
type IoStreamOptions = Omit<NonNullable<StreamArgs[1]>, "format3">;

/**
 * The app's options on top of sleap-io.js's reader options. Its `format3`
 * replaces sleap-io.js's (which takes only "view" or "edit").
 */
export interface SlpReadOptions {
  /**
   * How to open a file in SLP format 3.0:
   * - `"ask"` (default): ask the user, View only or Edit, with the list of
   *   what an edit drops (for opening a project).
   * - `"merge"`: ask whether to merge it, with the same list.
   * - `"view"` / `"edit"`: open it so without asking, where asking makes no
   *   sense (the caller says why).
   */
  format3?: Format3Policy;
  /** The file's name for the dialogs (defaults to the reader's own). */
  fileName?: string;
  /**
   * `"dialog"` (default): show a refused file's dialog. `"throw"`: only
   * throw, for callers that report failures their own way.
   */
  refusal?: "dialog" | "throw";
}

/** Strip the app's own keys before handing options to sleap-io.js. */
function splitOptions<T extends object>(
  options: (T & SlpReadOptions) | undefined,
): { io: T | undefined; app: SlpReadOptions } {
  if (!options) return { io: undefined, app: {} };
  const { format3, fileName, refusal, ...io } = options;
  return { io: io as unknown as T, app: { format3, fileName, refusal } };
}

/** A sleap-io.js point-span warning, with its "[sleap-io] " prefix removed; else null. */
export function pointSpanWarning(args: readonly unknown[]): string | null {
  const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  const m = /^\[sleap-io\]\s*(.*)$/s.exec(text);
  if (!m) return null;
  const body = m[1];
  return /point spans|points than their skeleton/.test(body) ? body : null;
}

// One shared console.warn hook for every read in flight, so overlapping reads
// don't restore each other's hook out of order.
const sinks = new Set<string[]>();
let originalWarn: typeof console.warn | null = null;

function startCollecting(sink: string[]): void {
  sinks.add(sink);
  if (originalWarn) return;
  originalWarn = console.warn;
  const passThrough = originalWarn;
  console.warn = (...args: unknown[]) => {
    const note = pointSpanWarning(args);
    if (note) for (const s of sinks) s.push(note);
    passThrough.apply(console, args);
  };
}

function stopCollecting(sink: string[]): void {
  sinks.delete(sink);
  if (sinks.size === 0 && originalWarn) {
    console.warn = originalWarn;
    originalWarn = null;
  }
}

/** Run a read, then toast any point-span repairs it logged. */
export async function withPointSpanWarnings<T>(read: () => Promise<T>): Promise<T> {
  const notes: string[] = [];
  startCollecting(notes);
  let result: T;
  try {
    result = await read();
  } finally {
    stopCollecting(notes);
  }
  if (notes.length > 0) {
    toast.warning("Some instances' points didn't match their skeleton", {
      description: `${notes.join("\n")}\nThe file was opened anyway. Check those instances before saving.`,
      duration: 20000,
    });
  }
  return result;
}

/**
 * sleap-io.js `loadSlp`, repairing point spans and handling refused and format
 * 3.0 files (see the module comment).
 */
export function loadSlp(
  source: LoadArgs[0],
  options?: IoLoadOptions & SlpReadOptions,
): ReturnType<typeof ioLoadSlp> {
  const { io, app } = splitOptions<IoLoadOptions>(options);
  return readWithFormatChoice(
    (access) =>
      withPointSpanWarnings(() =>
        ioLoadSlp(source, withFormat3({ ...io, repairPointSpans: true }, access)),
      ),
    app.format3 ?? "ask",
    app.fileName ?? sourceName(source) ?? io?.h5?.filenameHint,
    app.refusal,
  );
}

/**
 * sleap-io.js `readSlpStreaming`, repairing point spans and handling refused
 * and format 3.0 files (see the module comment).
 */
export function readSlpStreaming(
  source: StreamArgs[0],
  options?: IoStreamOptions & SlpReadOptions,
): ReturnType<typeof ioReadSlpStreaming> {
  const { io, app } = splitOptions<IoStreamOptions>(options);
  return readWithFormatChoice(
    (access) =>
      withPointSpanWarnings(() =>
        ioReadSlpStreaming(source, withFormat3({ ...io, repairPointSpans: true }, access)),
      ),
    app.format3 ?? "ask",
    app.fileName ?? sourceName(source) ?? io?.filenameHint,
    app.refusal,
  );
}

/** A name for `source` in dialogs: a File's name, a path or URL's last part. */
function sourceName(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (typeof File !== "undefined" && source instanceof File) return source.name;
  return undefined;
}
