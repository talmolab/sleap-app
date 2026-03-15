/** Quick platform detection utilities. */

export const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform);

/** The modifier key name for display. */
export const modKey = isMac ? "⌘" : "Ctrl";
