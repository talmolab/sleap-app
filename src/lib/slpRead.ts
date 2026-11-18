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
 */
import {
  loadSlp as ioLoadSlp,
  readSlpStreaming as ioReadSlpStreaming,
} from "@talmolab/sleap-io.js";
import { toast } from "./notify";

type LoadArgs = Parameters<typeof ioLoadSlp>;
type StreamArgs = Parameters<typeof ioReadSlpStreaming>;

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

/** sleap-io.js `loadSlp`, repairing point spans (see the module comment). */
export function loadSlp(source: LoadArgs[0], options?: LoadArgs[1]): ReturnType<typeof ioLoadSlp> {
  return withPointSpanWarnings(() => ioLoadSlp(source, { ...options, repairPointSpans: true }));
}

/** sleap-io.js `readSlpStreaming`, repairing point spans (see the module comment). */
export function readSlpStreaming(
  source: StreamArgs[0],
  options?: StreamArgs[1],
): ReturnType<typeof ioReadSlpStreaming> {
  return withPointSpanWarnings(() => ioReadSlpStreaming(source, { ...options, repairPointSpans: true }));
}
