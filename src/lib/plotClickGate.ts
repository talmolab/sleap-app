/**
 * Click-vs-double-click for a plot: a click calls `fire` only after `delayMs`
 * with no second click, so a double-click (which zooms out) never also counts
 * as one or two clicks. Used by UPlotChart's click-to-seek.
 */
export interface ClickGate {
  /** A completed click at x (call on mouseup when the pointer didn't drag). */
  click(x: number): void;
  /** A double-click happened: drop any pending click. */
  doubleClick(): void;
  /** Drop any pending click (e.g. on unmount). */
  cancel(): void;
}

export function createClickGate(delayMs: number, fire: (x: number) => void): ClickGate {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    click(x) {
      // A second click within the delay replaces the first; the dblclick
      // event that follows it then cancels both.
      cancel();
      timer = setTimeout(() => {
        timer = null;
        fire(x);
      }, delayMs);
    },
    doubleClick: cancel,
    cancel,
  };
}
