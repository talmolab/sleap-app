/**
 * Editing keyboard shortcuts (Help ▸ Keyboard Shortcuts…), as in PyQt
 * SLEAP's `dialogs/shortcuts.py`: which actions can be rebound, how a key
 * press becomes a binding, and the conflict rule — a key already used by
 * another action is moved here (after the user says yes), leaving the other
 * action without it.
 *
 * Bindings are tinykeys strings (`"$mod+Shift+KeyS"`, see shortcuts.ts).
 * Everything here is pure (no store), so the store can use it to check what
 * it loads, and tests can pass the platform in.
 */

import { isMac, isTauri } from "./platform";
import { NATIVE_MENU_BAR } from "./menu/nativeMenuBar";
import {
  defaultShortcutBindings,
  shortcutBindings,
  type ShortcutOverrides,
} from "./shortcuts";

/** The editable actions, grouped as the Shortcuts dialog lists them. */
export const SHORTCUT_CATEGORIES: Record<string, string[]> = {
  File: ["new", "open", "save", "save as", "close", "export clip", "export_analysis_current"],
  Navigation: [
    "frame next",
    "frame prev",
    "frame next medium step",
    "frame prev medium step",
    "frame next large step",
    "frame prev large step",
    "goto start",
    "goto end",
    "goto next labeled",
    "goto prev labeled",
    "goto next suggestion",
    "goto prev suggestion",
    "goto next user",
    "goto prev user",
    "goto last interacted",
    "goto next track spawn",
    "goto next qc flag",
    "goto prev qc flag",
    "ignore qc flag",
    "goto frame",
    "select to frame",
    "mark frame",
    "goto marked frame",
    "next video",
    "prev video",
    "select next",
    "select next instance zoom",
    "select prev instance zoom",
    "clear selection",
  ],
  Editing: [
    "add instance",
    "delete instance",
    "merge instance",
    "select instance nodes",
    "toggle node visibility",
    "accept all predictions",
    "mark negative",
    "copy instance",
    "paste instance",
    "delete frame predictions",
    "delete clip predictions",
    "delete area predictions",
    "box tool",
  ],
  View: [
    "fit",
    "reset view",
    "show instances",
    "show labels",
    "show edges",
    "show non-visible nodes",
    "color predicted",
    "toggle pan mode",
    "toggle place mode",
  ],
  Tracks: ["transpose", "propagate track labels", "add track", "delete track", "copy track", "paste track"],
  Predict: ["learning"],
  Notifications: ["dismiss all toasts"],
};

/**
 * Shortcut names with nothing in sleap-app to run yet (kept in
 * DEFAULT_SHORTCUTS to mirror SLEAP's shortcuts.yaml), so they aren't offered.
 */
export const UNEDITABLE_ACTIONS: readonly string[] = ["add videos", "replace videos", "show trails"];

/** Every action the user can rebind. */
export const EDITABLE_ACTIONS: readonly string[] = Object.values(SHORTCUT_CATEGORIES).flat();

const EDITABLE = new Set(EDITABLE_ACTIONS);

/** Names that don't read well title-cased. */
const LABELS: Record<string, string> = {
  "export_analysis_current": "Export Analysis (Current Video)",
  "goto next qc flag": "Goto Next Label QC Flag",
  "goto prev qc flag": "Goto Prev Label QC Flag",
  "ignore qc flag": "Ignore Label QC Flag",
};

/** An action's name for people: "delete area predictions" → "Delete Area Predictions". */
export function actionLabel(action: string): string {
  return LABELS[action] ?? action.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Keys

const MODIFIER_ORDER = ["$mod", "Control", "Meta", "Alt", "Shift"];

/** Modifiers in one fixed order, so equal bindings are equal strings. */
export function canonicalKey(binding: string): string {
  const parts = binding.split("+").filter(Boolean);
  const key = parts.filter((p) => !MODIFIER_ORDER.includes(p));
  const mods = MODIFIER_ORDER.filter((m) => parts.includes(m));
  return [...mods, ...key].join("+");
}

/**
 * The physical key combination a binding means on this platform: `$mod` is
 * ⌘ (Meta) on macOS and Ctrl everywhere else (tinykeys' rule), so on Windows
 * `$mod+Tab` and `Control+Tab` are the same keys.
 */
export function resolveKey(binding: string, mac: boolean = isMac): string {
  const parts = binding.split("+").map((p) => (p === "$mod" ? (mac ? "Meta" : "Control") : p));
  return canonicalKey([...new Set(parts)].join("+"));
}

/** Whether two bindings are the same keys on this platform. */
export function sameKey(a: string, b: string, mac: boolean = isMac): boolean {
  return resolveKey(a, mac) === resolveKey(b, mac);
}

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|Fn|FnLock|NumLock|ScrollLock)$/;

/**
 * A key press as a binding, or null while only modifiers are held. ⌘ on
 * macOS and Ctrl elsewhere become `$mod` (so a file of shortcuts works on
 * both); the real Control key on macOS stays `Control`.
 */
export function keyFromEvent(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean = isMac,
): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push("$mod");
  if (mac && e.ctrlKey) mods.push("Control");
  if (!mac && e.metaKey) mods.push("Meta");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return canonicalKey([...mods, e.code].join("+"));
}

// ---------------------------------------------------------------------------
// Keys that can't be reassigned

/**
 * Keys the app always uses for something that isn't in the editable list
 * (as in PyQt, where Undo and the like aren't in shortcuts.yaml).
 */
const RESERVED: Record<string, string> = {
  "$mod+KeyZ": "Undo",
  "$mod+Shift+KeyZ": "Redo",
  "$mod+Shift+Equal": "Increase Text Size",
  "$mod+Minus": "Decrease Text Size",
  Backspace: "Delete Selected Nodes",
  Delete: "Delete Selected Nodes",
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`$mod+Digit${n}`, `Set Instance Track ${n}`]),
  ),
};

/** Where the app is running, for the keys the system or browser keeps. */
export interface KeyContext {
  /** macOS (⌘ is $mod). Default: this computer. */
  mac?: boolean;
  /** The macOS desktop app, whose native app and Window menus own some keys. */
  nativeMenu?: boolean;
  /** A web browser (not the desktop app), which keeps its tab/window keys. */
  web?: boolean;
}

/** Keys macOS itself takes before any app sees them. */
const MAC_SYSTEM: Record<string, string> = {
  "$mod+Tab": "the macOS app switcher",
  "$mod+Shift+Tab": "the macOS app switcher",
  "$mod+Space": "Spotlight",
  "$mod+Backquote": "switching windows",
};

/** The macOS desktop app's own menu items (SLEAP and Window menus, app_menu.rs). */
const MAC_APP_MENU: Record<string, string> = {
  "$mod+KeyQ": "Quit SLEAP",
  "$mod+KeyH": "Hide SLEAP",
  "$mod+Alt+KeyH": "Hide Others",
  "$mod+KeyM": "Minimize (Window menu)",
  "$mod+KeyW": "Close Window (Window menu)",
};

/** Keys browsers keep for themselves: the page never gets them. */
const BROWSER: Record<string, string> = {
  "$mod+KeyW": "closing the browser tab",
  "$mod+Shift+KeyW": "closing the browser window",
  "$mod+KeyT": "opening a browser tab",
  "$mod+Shift+KeyT": "reopening a browser tab",
  "$mod+KeyN": "opening a browser window",
  "$mod+Shift+KeyN": "opening a private browser window",
  "Control+Tab": "switching browser tabs",
  "Control+Shift+Tab": "switching browser tabs",
};

/** More browser keys on macOS (⌥⌘←/→ switch tabs, ⌘Q quits the browser). */
const MAC_BROWSER: Record<string, string> = {
  "$mod+Alt+ArrowLeft": "switching browser tabs",
  "$mod+Alt+ArrowRight": "switching browser tabs",
  "$mod+KeyQ": "quitting the browser",
};

/** Windows/Linux window keys. */
const OTHER_SYSTEM: Record<string, string> = {
  "Alt+F4": "closing the window",
};

/** The actions that may have Space (it also pans the view while held). */
const SPACE_ACTIONS = new Set(["goto next suggestion", "goto prev suggestion"]);

function lookup(table: Record<string, string>, key: string, mac: boolean): string | null {
  for (const [reserved, label] of Object.entries(table)) {
    if (sameKey(reserved, key, mac)) return label;
  }
  return null;
}

/**
 * What a key is reserved for, or null if it's free to assign: keys the app
 * always uses (Undo, …), Space (hold-to-pan) for anything but the suggestion
 * keys, and keys the system, the browser or the macOS desktop app's own menus
 * keep. An action may always keep its own default keys, even where the
 * platform takes one (e.g. ⌘N in a browser): that's no worse than today.
 */
export function reservedKeyLabel(key: string, action: string, opts: KeyContext = {}): string | null {
  const mac = opts.mac ?? isMac;
  const nativeMenu = opts.nativeMenu ?? NATIVE_MENU_BAR;
  const web = opts.web ?? !isTauri;
  const fixed = lookup(RESERVED, key, mac);
  if (fixed) return fixed;
  if (key.split("+").includes("Space") && !SPACE_ACTIONS.has(action)) return "panning (hold Space and drag)";
  if (defaultShortcutBindings(action).some((k) => sameKey(k, key, mac))) return null;
  const tables = [
    ...(mac ? [MAC_SYSTEM] : [OTHER_SYSTEM]),
    ...(mac && nativeMenu ? [MAC_APP_MENU] : []),
    ...(web ? [BROWSER] : []),
    ...(web && mac ? [MAC_BROWSER] : []),
  ];
  for (const table of tables) {
    const label = lookup(table, key, mac);
    if (label) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conflicts and edits (on a draft of overrides; nothing here saves)

export type ShortcutConflict =
  | { kind: "action"; action: string }
  | { kind: "reserved"; label: string };

/** Who already has `key`, if anyone other than `action`. */
export function findConflict(
  overrides: ShortcutOverrides,
  action: string,
  key: string,
  opts: KeyContext = {},
): ShortcutConflict | null {
  const mac = opts.mac ?? isMac;
  const reserved = reservedKeyLabel(key, action, opts);
  if (reserved) return { kind: "reserved", label: reserved };
  for (const other of EDITABLE_ACTIONS) {
    if (other === action) continue;
    if (shortcutBindings(other, overrides).some((k) => sameKey(k, key, mac))) {
      return { kind: "action", action: other };
    }
  }
  return null;
}

/** Set an action's keys, dropping the entry when they're its defaults. */
function setKeys(overrides: ShortcutOverrides, action: string, keys: string[]): ShortcutOverrides {
  const out = { ...overrides };
  const defaults = defaultShortcutBindings(action);
  if (keys.length === defaults.length && keys.every((k, i) => k === defaults[i])) delete out[action];
  else out[action] = keys;
  return out;
}

/**
 * Give `key` to `action` (its only key from now on). Any other action that
 * had the key loses it — and is left unbound if it was its only key. Call
 * after the user agreed to the move (see findConflict).
 */
export function assignShortcut(
  overrides: ShortcutOverrides,
  action: string,
  key: string,
  mac: boolean = isMac,
): ShortcutOverrides {
  const binding = canonicalKey(key);
  let out = overrides;
  for (const other of EDITABLE_ACTIONS) {
    if (other === action) continue;
    const keys = shortcutBindings(other, out);
    if (keys.some((k) => sameKey(k, binding, mac))) {
      out = setKeys(out, other, keys.filter((k) => !sameKey(k, binding, mac)));
    }
  }
  return setKeys(out, action, [binding]);
}

/** Leave an action with no key. */
export function clearShortcut(overrides: ShortcutOverrides, action: string): ShortcutOverrides {
  return setKeys(overrides, action, []);
}

/**
 * Put an action back on its default keys. Another action that has since
 * taken one of them loses it, as when assigning (see defaultKeyConflicts to
 * ask first).
 */
export function resetShortcut(
  overrides: ShortcutOverrides,
  action: string,
  mac: boolean = isMac,
): ShortcutOverrides {
  let out = { ...overrides };
  delete out[action];
  for (const key of defaultShortcutBindings(action)) {
    for (const other of EDITABLE_ACTIONS) {
      if (other === action) continue;
      const keys = shortcutBindings(other, out);
      if (keys.some((k) => sameKey(k, key, mac))) {
        out = setKeys(out, other, keys.filter((k) => !sameKey(k, key, mac)));
      }
    }
  }
  return out;
}

/** The other actions that now have one of `action`'s default keys. */
export function defaultKeyConflicts(
  overrides: ShortcutOverrides,
  action: string,
  mac: boolean = isMac,
): { key: string; action: string }[] {
  const out: { key: string; action: string }[] = [];
  for (const key of defaultShortcutBindings(action)) {
    const c = findConflict(overrides, action, key, { mac });
    if (c?.kind === "action") out.push({ key, action: c.action });
  }
  return out;
}

/** Whether an action's keys differ from its defaults. */
export function isCustomized(overrides: ShortcutOverrides, action: string): boolean {
  return Object.hasOwn(overrides, action);
}

/**
 * Restoring a default can bring back a key another action has since taken:
 * the actions whose keys are now shared, as [key, action, other action].
 */
export function duplicateKeys(
  overrides: ShortcutOverrides,
  mac: boolean = isMac,
): [key: string, action: string, other: string][] {
  const seen = new Map<string, string>();
  const out: [string, string, string][] = [];
  for (const action of EDITABLE_ACTIONS) {
    for (const key of shortcutBindings(action, overrides)) {
      const resolved = resolveKey(key, mac);
      const first = seen.get(resolved);
      if (first && first !== action) out.push([key, first, action]);
      else seen.set(resolved, action);
    }
  }
  return out;
}

/** Anything a binding can't be (keeps a hand-edited or corrupt file out). */
const BINDING = /^(\$mod\+|Control\+|Meta\+|Alt\+|Shift\+)*[A-Za-z][A-Za-z0-9]*$/;

/**
 * Overrides read from storage or a file, kept only where they make sense:
 * editable actions, each a list of well-formed bindings. Anything else is
 * dropped (the action keeps its default), never an error.
 */
export function sanitizeOverrides(value: unknown, mac: boolean = isMac): ShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let out: ShortcutOverrides = {};
  for (const [action, keys] of Object.entries(value as Record<string, unknown>)) {
    if (!EDITABLE.has(action) || !Array.isArray(keys)) continue;
    if (!keys.every((k) => typeof k === "string" && k.length <= 64 && BINDING.test(k))) continue;
    out = setKeys(out, action, [...new Set((keys as string[]).map(canonicalKey))]);
  }
  return withoutDuplicates(out, mac);
}

/**
 * Make sure no key is on two actions (saved settings from another window, an
 * older build or a hand edit can put one there; tinykeys would then run only
 * the last handler). The user's own keys win, in the order they were saved;
 * an action still on its defaults loses the shared key.
 */
export function withoutDuplicates(overrides: ShortcutOverrides, mac: boolean = isMac): ShortcutOverrides {
  const taken = new Set<string>();
  let out = { ...overrides };
  const keep = (action: string, keys: string[]) => {
    const kept = keys.filter((k) => !taken.has(resolveKey(k, mac)));
    for (const k of kept) taken.add(resolveKey(k, mac));
    if (kept.length !== keys.length) out = setKeys(out, action, kept);
  };
  for (const action of Object.keys(overrides)) keep(action, overrides[action]);
  for (const action of EDITABLE_ACTIONS) {
    if (!Object.hasOwn(overrides, action)) keep(action, defaultShortcutBindings(action));
  }
  return out;
}

/** Whether `action` is one the user can rebind. */
export function isEditableAction(action: string): boolean {
  return EDITABLE.has(action);
}
