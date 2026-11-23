/**
 * Keyboard shortcut definitions matching SLEAP's shortcuts.yaml.
 */

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  // File
  new: "$mod+KeyN",
  open: "$mod+KeyO",
  save: "$mod+KeyS",
  "save as": "$mod+Shift+KeyS",
  close: "$mod+KeyQ",

  // Navigation - frames
  "frame next": "ArrowRight",
  "frame prev": "ArrowLeft",
  "frame next medium step": "$mod+ArrowRight",
  "frame prev medium step": "$mod+ArrowLeft",
  "frame next large step": "$mod+Shift+ArrowRight",
  "frame prev large step": "$mod+Shift+ArrowLeft",
  "goto start": "Home",
  "goto end": "End",

  // Navigation - labeled frames
  "goto next labeled": "Alt+ArrowRight",
  "goto prev labeled": "Alt+ArrowLeft",
  "goto last interacted": "$mod+KeyA",
  "goto next user": "$mod+KeyU",
  "goto prev user": "$mod+Shift+KeyU",
  "goto next suggestion": "Space",
  "goto prev suggestion": "Shift+Space",
  "goto next track spawn": "$mod+KeyE",
  "goto next qc flag": "KeyF",
  "goto prev qc flag": "Shift+KeyF",
  "ignore qc flag": "Digit3",

  // Navigation - videos
  "next video": "Alt+Shift+ArrowRight",
  "prev video": "Alt+Shift+ArrowLeft",

  // Navigation - other
  "goto frame": "$mod+KeyJ",
  "mark frame": "$mod+KeyM",
  "goto marked frame": "$mod+Shift+KeyM",
  "select to frame": "$mod+Shift+KeyJ",
  "select next": "Backquote",
  "select next instance zoom": "Shift+ArrowDown",
  "select prev instance zoom": "Shift+ArrowUp",
  "clear selection": "Escape",

  // Labels
  "add instance": "$mod+KeyI",
  "delete instance": "$mod+Backspace",
  "accept all predictions": "$mod+Shift+KeyA",
  // Legacy SLEAP's Merge Instance has no key; Shift+M is new in sleap-app.
  "merge instance": "Shift+KeyM",
  // Selects every node of the selected instance, so they drag together. This
  // was double-click, which went back to legacy SLEAP's "add missing nodes".
  "select instance nodes": "Shift+KeyA",
  // SLEAP's key. Node placement mode moved to Shift+N to make room for it.
  "mark negative": "KeyN",

  // View
  fit: "$mod+Equal",
  "reset view": "KeyR",
  "show instances": "KeyH",
  "show labels": "KeyT",
  "show edges": "$mod+Shift+Tab",
  // V marks the hovered/selected node(s) (non-)visible (handled in VideoPlayer);
  // Shift+V shows/hides non-visible nodes across the view, as in legacy SLEAP.
  // Both used to be plain V, so one press did both and the node vanished.
  "toggle node visibility": "KeyV",
  "show non-visible nodes": "Shift+KeyV",
  "toggle pan mode": "KeyP",
  // B: box tool — drag on the canvas to draw a bounding box (Esc leaves it).
  "box tool": "KeyB",
  "toggle place mode": "Shift+KeyN",

  // Tracks
  transpose: "$mod+KeyT",
  // Turns Tracks ▸ Propagate Track Labels on/off. SLEAP uses plain P, but P
  // is pan mode here, so it's Shift+P.
  "propagate track labels": "Shift+KeyP",
  "add track": "$mod+Digit0",
  "delete track": "$mod+Shift+Backspace",

  // Predict
  learning: "$mod+KeyL",

  // Export
  "export clip": "",
  "export_analysis_current": "$mod+Alt+KeyE",

  // Prediction management
  "delete frame predictions": "",
  "delete clip predictions": "",
  "delete area predictions": "$mod+KeyK",

  // Add videos
  "add videos": "",
  "replace videos": "",

  // Copy/paste
  "copy instance": "$mod+KeyC",
  "paste instance": "$mod+KeyV",
  "copy track": "$mod+Shift+KeyC",
  "paste track": "$mod+Shift+KeyV",

  // Color
  "color predicted": "",
  "show trails": "",

  // Notifications
  "dismiss all toasts": "$mod+Shift+KeyD",
};

/**
 * Second keys for an action, on top of its DEFAULT_SHORTCUTS key. These are
 * legacy SLEAP's keys where sleap-app had already picked a different one, so
 * both work:
 * - ±100 frames: SLEAP's Ctrl+Alt+arrows (⌥⌘ on macOS, as SLEAP's Qt maps
 *   Ctrl to ⌘). Browsers on macOS use ⌥⌘←/→ to switch tabs, so there it only
 *   works in the desktop app; Ctrl+Shift+arrows works everywhere.
 * - Show Node Names: SLEAP's Ctrl+Tab. The real Control key on every OS:
 *   ⌘Tab is macOS's app switcher and never reaches the app. Browsers use
 *   Ctrl+Tab to switch tabs, so it only works in the desktop app; T works
 *   everywhere.
 */
export const EXTRA_SHORTCUTS: Record<string, string[]> = {
  "frame next large step": ["$mod+Alt+ArrowRight"],
  "frame prev large step": ["$mod+Alt+ArrowLeft"],
  "show labels": ["Control+Tab"],
};

/**
 * The user's own keys (Help ▸ Keyboard Shortcuts…), by action: each listed
 * action's keys replace all of its default keys (main and extras); `[]`
 * leaves it unbound. Actions not listed keep their defaults. Saved per
 * computer with the other preferences (appStore `shortcutOverrides`).
 */
export type ShortcutOverrides = Record<string, string[]>;

/** The default keys of an action: its main key first, then any extras. */
export function defaultShortcutBindings(action: string): string[] {
  const main = DEFAULT_SHORTCUTS[action];
  return [...(main ? [main] : []), ...(EXTRA_SHORTCUTS[action] ?? [])];
}

/**
 * Every key bound to an action: the user's keys if they changed it, else
 * its defaults (main key first, then any extras).
 */
export function shortcutBindings(action: string, overrides: ShortcutOverrides = {}): string[] {
  const own = Object.hasOwn(overrides, action) ? overrides[action] : undefined;
  return own ? [...own] : defaultShortcutBindings(action);
}

/** The key an action's menu item and hints show: its first key, if any. */
export function mainShortcut(action: string, overrides: ShortcutOverrides = {}): string | undefined {
  return shortcutBindings(action, overrides)[0];
}

/**
 * A tinykeys binding map from handlers keyed by action name: each action's
 * handler runs on every key bound to it (the user's keys, if they changed
 * them). Unbound actions are left out.
 */
export function bindActions<T>(
  handlers: Record<string, T>,
  overrides: ShortcutOverrides = {},
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [action, handler] of Object.entries(handlers)) {
    for (const key of shortcutBindings(action, overrides)) out[key] = handler;
  }
  return out;
}

/**
 * Frame step sizes for keyboard navigation. Medium and large are only the
 * defaults: the user sets them in Go ▸ Frame Step Sizes… (appStore
 * `mediumStepSize` / `largeStepSize`, PyQt's "medium/large step size" prefs).
 */
export const STEP_SIZES = {
  small: 1,
  medium: 10,
  large: 100,
};

/** Largest allowed frame step size. */
export const MAX_STEP_SIZE = 1_000_000;

/** A usable frame step size: a whole number of frames from 1 to MAX_STEP_SIZE. */
export function isValidStepSize(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= MAX_STEP_SIZE;
}
