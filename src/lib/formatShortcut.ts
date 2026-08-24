/**
 * Render a tinykeys-style shortcut binding (as stored in DEFAULT_SHORTCUTS,
 * e.g. `"$mod+Shift+KeyS"`) into an OS-correct, human-readable label.
 *
 * On macOS modifiers become the platform glyphs (⌘ ⌥ ⇧ ⌃) and Backspace becomes
 * ⌫; elsewhere they stay spelled out (Ctrl/Alt/Shift/Backspace). `$mod` follows
 * tinykeys' own resolution: ⌘ on macOS, Ctrl everywhere else. Tokens are joined
 * with `+` and kept in the order they appear in the binding.
 *
 * This is the single choke-point for shortcut display so menus, tooltips, the
 * command palette, and the shortcuts reference all agree. `mac` defaults to the
 * ambient platform but is injectable for tests.
 */

import { isMac } from "./platform";

/** Modifier tokens → their macOS glyph vs. spelled-out label. */
const MODIFIERS: Record<string, { mac: string; other: string }> = {
  $mod: { mac: "⌘", other: "Ctrl" },
  Mod: { mac: "⌘", other: "Ctrl" },
  Meta: { mac: "⌘", other: "Win" },
  Control: { mac: "⌃", other: "Ctrl" },
  Ctrl: { mac: "⌃", other: "Ctrl" },
  Alt: { mac: "⌥", other: "Alt" },
  Option: { mac: "⌥", other: "Alt" },
  Shift: { mac: "⇧", other: "Shift" },
};

/** Non-modifier keys whose label differs from the raw code (some OS-specific). */
const KEYS: Record<string, { mac: string; other: string }> = {
  ArrowRight: { mac: "→", other: "→" },
  ArrowLeft: { mac: "←", other: "←" },
  ArrowUp: { mac: "↑", other: "↑" },
  ArrowDown: { mac: "↓", other: "↓" },
  Backquote: { mac: "`", other: "`" },
  Backspace: { mac: "⌫", other: "Backspace" },
  Delete: { mac: "⌦", other: "Delete" },
  Escape: { mac: "Esc", other: "Esc" },
  Enter: { mac: "↩", other: "Enter" },
  Return: { mac: "↩", other: "Enter" },
  Equal: { mac: "=", other: "=" },
  Minus: { mac: "-", other: "-" },
  Space: { mac: "Space", other: "Space" },
  Tab: { mac: "Tab", other: "Tab" },
};

/** Translate a single binding token to its display form. */
function formatToken(token: string, mac: boolean): string {
  const mod = MODIFIERS[token];
  if (mod) return mac ? mod.mac : mod.other;
  const key = KEYS[token];
  if (key) return mac ? key.mac : key.other;
  // Letter/digit codes: KeyS -> S, Digit0 -> 0.
  const letter = token.match(/^Key([A-Z])$/);
  if (letter) return letter[1];
  const digit = token.match(/^Digit(\d)$/);
  if (digit) return digit[1];
  // Anything else (Home, End, PageUp, a bare char) passes through unchanged.
  return token;
}

/**
 * Format a tinykeys binding string for display. Returns `""` for an empty
 * (unbound) binding.
 */
export function formatShortcut(binding: string, mac: boolean = isMac): string {
  if (!binding) return "";
  return binding
    .split("+")
    .map((token) => formatToken(token, mac))
    .join("+");
}
