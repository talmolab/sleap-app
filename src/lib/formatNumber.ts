/**
 * Compact number format for chart tooltips: exponential for very small / large
 * magnitudes (e.g. a loss like 4.87e-4), otherwise up to 4 decimals with
 * trailing zeros trimmed. Non-finite → "".
 */
export function formatCompactNumber(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e4)) return v.toExponential(2);
  return String(Number(v.toFixed(4)));
}
