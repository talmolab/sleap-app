/**
 * Middle-truncate a string to fit a character budget, keeping the head and tail
 * so a filename's distinguishing prefix AND extension stay visible
 * (e.g. `als2h_cohort2_coh…00001.mp4`). Used for filenames shown in fixed-width
 * dialogs/toasts, where a long unbroken name would otherwise overflow.
 */
export function ellipsizeMiddle(text: string, max = 44): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const keep = max - 1; // room for the single-char ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return text.slice(0, head) + "…" + text.slice(text.length - tail);
}
