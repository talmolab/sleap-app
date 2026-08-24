/** `YYMMDD_HHMMSS`, matching legacy SLEAP's `get_timestamp()` (sleap/gui/learning/runners.py) — used for predictions filenames and training run names. */
export function formatRunTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
