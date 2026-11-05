/**
 * The native menu bar (macOS desktop): the app menu definition
 * (`buildAppMenu`) sent to Rust as plain data, which builds the real OS menu
 * from it (`set_app_menu` in src-tauri/src/app_menu.rs). Clicks come back as
 * the item's id (an `app-menu` event) and run the same code a click in the
 * in-window menu bar would.
 *
 * Shortcuts: an item gets a native shortcut (an accelerator, which the menu
 * then owns) only for ⌘ combinations. Bare keys (Space, P, `, Esc, arrows)
 * and ⌥/⇧-only combos stay with the app's own key handling, because as menu
 * shortcuts they'd fire while typing or scrubbing; they're shown as a hint
 * after the label instead. So are the text-editing keys (⌘Z/⇧⌘Z/⌘C/⌘V/⌘X/⌘A):
 * Edit keeps the system Cut/Copy/Paste/Select All for text fields, and the
 * app's handler tells a text field from the canvas.
 */

import { formatShortcut } from "@/lib/formatShortcut";
import type { AppMenu, MenuNode, TopAction, TopMenu } from "./types";

/** What Rust builds the menu from (mirrors `MenuSpec` in app_menu.rs). */
export type NativeNode =
  | { kind: "item"; id: string; label: string; enabled: boolean; accelerator?: string }
  | { kind: "check"; id: string; label: string; enabled: boolean; checked: boolean; accelerator?: string }
  | { kind: "submenu"; id: string; label: string; enabled: boolean; items: NativeNode[] }
  | { kind: "separator" };

export interface NativeMenuSpec {
  menus: { id: string; label: string; items: NativeNode[] }[];
}

/** Ids handled natively or that make no sense in the native menu. */
const OMIT = new Set([
  // The app menu (SLEAP ▸ Quit, ⌘Q) runs it; see app_menu.rs.
  "file.quit",
]);

/** Text-editing combos a text field needs: never menu-owned. */
const TEXT_EDITING = new Set([
  "$mod+KeyZ",
  "$mod+Shift+KeyZ",
  "$mod+KeyC",
  "$mod+KeyV",
  "$mod+KeyX",
  "$mod+KeyA",
]);

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Backspace: "Backspace",
  Backquote: "`",
  Equal: "=",
  Minus: "-",
  Space: "Space",
  Escape: "Escape",
};

/**
 * A tinykeys binding as a Tauri accelerator ("$mod+Shift+KeyS" →
 * "CmdOrCtrl+Shift+S"), or undefined if the menu shouldn't own it.
 */
export function toAccelerator(binding: string | undefined): string | undefined {
  if (!binding || TEXT_EDITING.has(binding)) return undefined;
  const parts = binding.split("+");
  if (!parts.includes("$mod")) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    if (p === "$mod") out.push("CmdOrCtrl");
    else if (p === "Shift" || p === "Alt" || p === "Control") out.push(p);
    else {
      const letter = p.match(/^Key([A-Z])$/)?.[1];
      const digit = p.match(/^Digit(\d)$/)?.[1];
      const key = letter ?? digit ?? KEY_NAMES[p];
      if (!key) return undefined;
      out.push(key);
    }
  }
  return out.join("+");
}

/** "Next Suggestion" + Space → "Next Suggestion    Space" for app-owned keys. */
function labelWithHint(label: string, binding: string | undefined, hint?: string): string {
  if (binding && toAccelerator(binding) === undefined) {
    return `${label}    ${formatShortcut(binding)}`;
  }
  return hint ? `${label}    ${hint}` : label;
}

function convert(nodes: MenuNode[]): NativeNode[] {
  const out: NativeNode[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "separator":
        // No leading or doubled separators (e.g. around omitted items).
        if (out.length && out[out.length - 1].kind !== "separator") out.push(node);
        break;
      case "label":
        out.push({ kind: "item", id: node.id, label: node.text, enabled: false });
        break;
      case "item":
        if (OMIT.has(node.id)) break;
        out.push({
          kind: "item",
          id: node.id,
          label: labelWithHint(node.label, node.shortcut, node.hint),
          enabled: node.enabled !== false,
          accelerator: toAccelerator(node.shortcut),
        });
        break;
      case "check":
        out.push({
          kind: "check",
          id: node.id,
          label: labelWithHint(node.label, node.shortcut),
          enabled: node.enabled !== false,
          checked: node.checked,
          accelerator: toAccelerator(node.shortcut),
        });
        break;
      case "radio":
        // macOS has no radio items: checkmarks on the chosen one.
        for (const o of node.options) {
          out.push({
            kind: "check",
            id: `${node.id}=${o.value}`,
            label: o.label,
            enabled: node.enabled !== false && o.enabled !== false,
            checked: o.value === node.value,
          });
        }
        break;
      case "submenu":
        out.push({
          kind: "submenu",
          id: node.id,
          label: node.label,
          enabled: node.enabled !== false,
          items: convert(node.items),
        });
        break;
    }
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

/** The in-window bar's top-level buttons, as items in a menu (native only). */
const ACTION_HOMES: Record<string, { menu: string; position: "start" | "end" }> = {
  connect: { menu: "predict", position: "end" },
  tutorial: { menu: "help", position: "start" },
};

export function toNativeSpec(menu: AppMenu): NativeMenuSpec {
  const tops = menu.filter((t): t is TopMenu => t.kind === "menu");
  const actions = menu.filter((t): t is TopAction => t.kind === "action");
  return {
    menus: tops.map((top) => {
      const items = convert(top.items);
      for (const a of actions) {
        const home = ACTION_HOMES[a.id];
        if (home?.menu !== top.id) continue;
        const node: NativeNode = { kind: "item", id: a.id, label: a.label, enabled: true };
        if (home.position === "start") items.unshift(node, { kind: "separator" });
        else items.push({ kind: "separator" }, node);
      }
      return { id: top.id, label: top.label, items };
    }),
  };
}

/** Run the menu command with this native id; false if there's none. */
export function runNativeMenuItem(menu: AppMenu, id: string): boolean {
  const [nodeId, radioValue] = id.split("=");
  for (const top of menu) {
    if (top.kind === "action") {
      if (top.id === id) {
        void top.run();
        return true;
      }
      continue;
    }
    const found = findNode(top.items, nodeId);
    if (!found) continue;
    if (found.kind === "radio" && radioValue !== undefined) {
      found.select(radioValue);
      return true;
    }
    if (found.kind === "item" || found.kind === "check") {
      if (found.enabled === false) return false;
      void found.run();
      return true;
    }
  }
  return false;
}

function findNode(nodes: MenuNode[], id: string): MenuNode | undefined {
  for (const n of nodes) {
    if ("id" in n && n.id === id) return n;
    if (n.kind === "submenu") {
      const inner = findNode(n.items, id);
      if (inner) return inner;
    }
  }
  return undefined;
}
