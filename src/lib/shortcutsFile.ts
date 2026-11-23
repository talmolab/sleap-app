/**
 * Keyboard shortcuts as a file (Export… / Import… in Help ▸ Keyboard
 * Shortcuts), in the format of PyQt SLEAP's `shortcuts.yaml`: one line per
 * action, `action name: Key`, with Qt's key names (`Ctrl+Shift+S`, `Alt+Right`,
 * `Esc`). As in Qt, `Ctrl` means ⌘ on macOS and Ctrl elsewhere, and `Meta` is
 * the real Control key on macOS. So a PyQt shortcuts.yaml can be imported,
 * and a file exported on one computer works on another.
 *
 * sleap-app extras: an action with two keys is written as a list
 * (`show labels: [T, Meta+Tab]`), and an unbound one as `''`. Raw tinykeys
 * bindings (`$mod+KeyS`) are accepted on import too.
 */

import yaml from "js-yaml";
import { isMac } from "./platform";
import { EXTRA_SHORTCUTS, shortcutBindings, type ShortcutOverrides } from "./shortcuts";
import {
  EDITABLE_ACTIONS,
  actionLabel,
  canonicalKey,
  findConflict,
  isEditableAction,
  sameKey,
  withoutDuplicates,
  type KeyContext,
} from "./shortcutEditing";

/** Default file name, as in PyQt. */
export const SHORTCUTS_FILE_NAME = "shortcuts.yaml";

/** First line of an exported file: how Import tells its own files from PyQt's. */
const FILE_MARKER = "# sleap-app keyboard shortcuts";

/**
 * PyQt SLEAP's default shortcuts.yaml (sleap/config/shortcuts.yaml on
 * develop). A legacy file's entry that still has its PyQt default wasn't
 * customized there, so it keeps sleap-app's default instead (which can
 * differ: P is pan mode here, Show Node Names is T, …).
 */
const PYQT_DEFAULTS: Record<string, string> = {
  "add instance": "Ctrl+I",
  "clear selection": "Esc",
  close: "Ctrl+Q",
  "delete area": "Ctrl+K",
  "delete instance": "Ctrl+Backspace",
  "delete track": "Ctrl+Shift+Backspace",
  fit: "Ctrl+=",
  "goto frame": "Ctrl+J",
  "goto marked": "Ctrl+Shift+M",
  "goto last interacted": "Ctrl+A",
  "goto next suggestion": "Space",
  "goto next track spawn": "Ctrl+E",
  "goto next user": "Ctrl+U",
  "goto prev user": "Ctrl+Shift+U",
  "goto next labeled": "Alt+Right",
  "goto prev suggestion": "Shift+Space",
  "goto prev labeled": "Alt+Left",
  learning: "Ctrl+L",
  "mark negative": "N",
  new: "Ctrl+N",
  "next video": "Alt+Shift+Right",
  open: "Ctrl+O",
  "prev video": "Alt+Shift+Left",
  "save as": "Ctrl+Shift+S",
  save: "Ctrl+S",
  "select next": "`",
  "select to frame": "Ctrl+Shift+J",
  "show instances": "H",
  "show non-visible nodes": "Shift+V",
  "show edges": "Ctrl+Shift+Tab",
  "show labels": "Ctrl+Tab",
  transpose: "Ctrl+T",
  "propagate track labels": "P",
  "frame next": "Right",
  "frame prev": "Left",
  "frame next medium step": "Ctrl+Right",
  "frame prev medium step": "Ctrl+Left",
  "frame next large step": "Ctrl+Alt+Right",
  "frame prev large step": "Ctrl+Alt+Left",
  export_analysis_current: "Ctrl+Alt+E",
};

/** PyQt names for actions sleap-app names differently. */
const PYQT_ALIASES: Record<string, string> = {
  "delete area": "delete area predictions",
  "delete clip": "delete clip predictions",
  "goto marked": "goto marked frame",
};

/** tinykeys key codes ↔ Qt key names, where they differ. */
const QT_KEYS: [code: string, qt: string][] = [
  ["ArrowRight", "Right"],
  ["ArrowLeft", "Left"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["Escape", "Esc"],
  ["Equal", "="],
  ["Minus", "-"],
  ["Backquote", "`"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
  ["Backslash", "\\"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Delete", "Del"],
  ["Insert", "Ins"],
  ["Enter", "Return"],
  ["PageUp", "PgUp"],
  ["PageDown", "PgDown"],
];

const TO_QT = new Map(QT_KEYS);
const FROM_QT = new Map(QT_KEYS.map(([code, qt]) => [qt.toLowerCase(), code]));

/** A binding in Qt's words: `"$mod+Shift+KeyS"` → `"Ctrl+Shift+S"`. */
export function toQtKey(binding: string): string {
  return canonicalKey(binding)
    .split("+")
    .map((t) => {
      if (t === "$mod") return "Ctrl";
      if (t === "Control") return "Meta";
      // The Windows key (tinykeys Meta off macOS; on macOS ⌘ is $mod).
      if (t === "Meta") return "Win";
      const letter = t.match(/^Key([A-Z])$/)?.[1];
      if (letter) return letter;
      const digit = t.match(/^Digit(\d)$/)?.[1];
      if (digit) return digit;
      return TO_QT.get(t) ?? t;
    })
    .join("+");
}

const QT_MODIFIERS: Record<string, string> = {
  ctrl: "$mod",
  cmd: "$mod",
  command: "$mod",
  mod: "$mod",
  $mod: "$mod",
  meta: "Control",
  win: "Meta",
  super: "Meta",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** The key codes tinykeys can match that have no Qt spelling of their own. */
const NAMED_CODES = new Set([
  "Space",
  "Tab",
  "Backspace",
  "Home",
  "End",
  ...QT_KEYS.map(([code]) => code),
]);

/** One key name (not a modifier) as a key code, or null. */
function codeFromName(name: string): string | null {
  if (/^[A-Za-z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^\d$/.test(name)) return `Digit${name}`;
  if (/^Key[A-Z]$/.test(name) || /^Digit\d$/.test(name)) return name;
  if (/^F([1-9]|1\d|2[0-4])$/i.test(name)) return name.toUpperCase();
  const qt = FROM_QT.get(name.toLowerCase());
  if (qt) return qt;
  const named = [...NAMED_CODES].find((c) => c.toLowerCase() === name.toLowerCase());
  if (named) return named;
  if (name.toLowerCase() === "pagedown") return "PageDown";
  if (name.toLowerCase() === "pageup") return "PageUp";
  if (name.toLowerCase() === "escape") return "Escape";
  return null;
}

/**
 * A key from a file (Qt words or a tinykeys binding) as a binding, or null
 * if it isn't one combination of modifiers and one key. Qt's multi-step
 * sequences ("Ctrl+K, Ctrl+L") aren't supported.
 */
export function fromQtKey(text: string): string | null {
  const s = text.trim();
  if (!s || /,\s/.test(s)) return null;
  // "Ctrl++" (the + key) splits into an empty last part: not supported.
  const parts = s.split("+");
  if (parts.some((p) => p === "")) return null;
  const key = parts.pop()!;
  const mods: string[] = [];
  for (const p of parts) {
    const mod = QT_MODIFIERS[p.toLowerCase()];
    if (!mod) return null;
    mods.push(mod);
  }
  const code = codeFromName(key);
  if (!code) return null;
  return canonicalKey([...mods, code].join("+"));
}

/** The shortcuts file for a set of overrides (every editable action listed). */
export function exportShortcutsYaml(overrides: ShortcutOverrides): string {
  const data: Record<string, string | string[]> = {};
  for (const action of EDITABLE_ACTIONS) {
    const keys = shortcutBindings(action, overrides).map(toQtKey);
    data[action] = keys.length === 0 ? "" : keys.length === 1 ? keys[0] : keys;
  }
  const header =
    `${FILE_MARKER} (Help > Keyboard Shortcuts > Import...).\n` +
    "# Same format as SLEAP's shortcuts.yaml: Ctrl is Cmd on macOS, Meta is the Control key on macOS.\n";
  return header + yaml.dump(data, { flowLevel: 1, lineWidth: -1 });
}

export interface ImportResult {
  /** The imported shortcuts, on top of the defaults. */
  overrides: ShortcutOverrides;
  /** How many actions the file set. */
  count: number;
  /** Names in the file sleap-app doesn't have (ignored). */
  unknown: string[];
  /** Entries whose key couldn't be read or can't be used (ignored). */
  invalid: string[];
  /** Keys the file gave to an action that another one had by default. */
  moved: { key: string; from: string; to: string }[];
}

/**
 * Read a shortcuts file. It starts from the defaults and applies each entry
 * in turn, the same as assigning it in the dialog: a key another action
 * already has moves to the entry's action. Throws only if the file isn't a
 * YAML mapping at all.
 *
 * A file this app exported lists every action, so it's taken as is (`''` =
 * no key). A legacy PyQt SLEAP shortcuts.yaml only says what the user had
 * there: an empty entry, or one still on PyQt's default, keeps sleap-app's
 * default; a changed one replaces the main key but keeps sleap-app's extra
 * keys (e.g. Ctrl+Shift+arrows for ±100 frames).
 */
export function parseShortcutsYaml(text: string, opts: KeyContext = {}): ImportResult {
  const mac = opts.mac ?? isMac;
  const data = yaml.load(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("This isn't a shortcuts file: expected one 'action: key' line per shortcut.");
  }
  const legacy = !text.trimStart().startsWith(FILE_MARKER);
  let overrides: ShortcutOverrides = {};
  const result: ImportResult = { overrides, count: 0, unknown: [], invalid: [], moved: [] };
  for (const [rawName, value] of Object.entries(data as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    const action = PYQT_ALIASES[name] ?? name;
    if (!isEditableAction(action)) {
      result.unknown.push(rawName);
      continue;
    }
    const texts =
      value == null ? [] : Array.isArray(value) ? value : [value];
    const keys = texts.map((t) => (typeof t === "string" || typeof t === "number" ? String(t) : ""))
      .filter((t) => t.trim() !== "")
      .map(fromQtKey);
    if (keys.some((k) => k === null)) {
      result.invalid.push(`${rawName}: ${texts.join(", ")}`);
      continue;
    }
    let bindings = [...new Set(keys as string[])];
    if (legacy) {
      // Not set in PyQt, or still PyQt's default: keep sleap-app's default.
      if (bindings.length === 0) continue;
      const pyqtDefault = PYQT_DEFAULTS[name] !== undefined ? fromQtKey(PYQT_DEFAULTS[name]) : null;
      if (pyqtDefault && bindings.length === 1 && sameKey(bindings[0], pyqtDefault, mac)) continue;
      for (const extra of EXTRA_SHORTCUTS[action] ?? []) {
        if (!bindings.some((k) => sameKey(k, extra, mac))) bindings = [...bindings, extra];
      }
    }
    const reserved = bindings
      .map((k) => findConflict({}, action, k, opts))
      .find((c) => c?.kind === "reserved");
    if (reserved && reserved.kind === "reserved") {
      result.invalid.push(`${rawName}: ${texts.join(", ")} (reserved for ${reserved.label})`);
      continue;
    }
    // Take each key from whoever has it now, then set the entry's keys.
    for (const key of bindings) {
      for (const other of EDITABLE_ACTIONS) {
        if (other === action) continue;
        const otherKeys = shortcutBindings(other, overrides);
        if (otherKeys.some((k) => sameKey(k, key, mac))) {
          overrides = { ...overrides, [other]: otherKeys.filter((k) => !sameKey(k, key, mac)) };
          result.moved.push({ key, from: other, to: action });
        }
      }
    }
    overrides = { ...overrides, [action]: bindings };
    result.count += 1;
  }
  // A later entry can take back a key an earlier one moved: only report the
  // moves that still stand.
  result.moved = result.moved.filter(
    (m, i, all) =>
      shortcutBindings(m.to, overrides).includes(m.key) &&
      all.findIndex((n) => n.key === m.key && n.from === m.from) === i,
  );
  // Drop entries that ended up equal to the defaults.
  const clean: ShortcutOverrides = {};
  for (const [action, keys] of Object.entries(overrides)) {
    const defaults = shortcutBindings(action);
    if (keys.length !== defaults.length || keys.some((k, i) => k !== defaults[i])) clean[action] = keys;
  }
  result.overrides = withoutDuplicates(clean, mac);
  return result;
}

/** "P was Toggle Pan Mode's key" lines for an import summary. */
export function describeMoves(moved: ImportResult["moved"], format: (key: string) => string): string[] {
  return moved.map(
    (m) => `${format(m.key)} moved from ${actionLabel(m.from)} to ${actionLabel(m.to)}`,
  );
}
