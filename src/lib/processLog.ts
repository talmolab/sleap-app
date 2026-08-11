/**
 * Shared helpers for the training / inference subprocess log + error surfacing.
 *
 * - {@link appendLogLine} keeps the log bounded so a long run (e.g. inference over
 *   a large video) can't grow the array/DOM without limit.
 * - {@link subprocessFailureMessage} lifts the last stderr line into the error
 *   banner so a failure shows the actual cause, not just "exit code N".
 */

/** Max lines retained in a subprocess log (matches PyQt-era behavior). */
export const MAX_LOG_LINES = 1000;

/**
 * Append `line` to `log`, dropping the oldest lines so the result never exceeds
 * `max`. Returns a new array (safe for store `set`).
 */
export function appendLogLine(
  log: string[],
  line: string,
  max = MAX_LOG_LINES,
): string[] {
  const next = [...log, line];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The last non-empty (trimmed) line of `lines`, or null if there is none. */
export function lastErrorLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim();
    if (t) return t;
  }
  return null;
}

/**
 * Build a human error message for a failed subprocess: `"{what} failed (exit code
 * {code})"`, plus the last stderr line as the likely cause when one is available.
 */
export function subprocessFailureMessage(
  what: string,
  code: number | null,
  stderrTail: string[],
): string {
  const base = `${what} failed (exit code ${code ?? "unknown"})`;
  const cause = lastErrorLine(stderrTail);
  return cause ? `${base}: ${cause}` : base;
}
