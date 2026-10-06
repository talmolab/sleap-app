/** `12s` / `3m 4s` / `1h 2m` — a short elapsed-time label for training/run UI. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** `YYMMDD_HHMMSS`, matching legacy SLEAP's `get_timestamp()` (sleap/gui/learning/runners.py) — used for predictions filenames and training run names. */
export function formatRunTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
