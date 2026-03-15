/** Quick platform detection utilities. */

export { isTauri } from "../platform/index";

export const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform);

/** The modifier key name for display. */
export const modKey = isMac ? "⌘" : "Ctrl";
