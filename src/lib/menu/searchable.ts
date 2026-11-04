/**
 * Search Menus' list: every enabled command in the app menu, flattened.
 * Nested items are named by their path ("Export › Analysis CSV › All
 * Videos"), and each choice of a radio group is its own entry ("Edge Style:
 * Wedge"), so anything reachable in the menus can be found by typing.
 */

import type { AppMenu, MenuNode } from "./types";

export interface SearchableCommand {
  id: string;
  /** The top-level menu it's in ("File", "View", …). */
  group: string;
  label: string;
  shortcut?: string;
  /** For toggles and radio choices: whether it's on now. */
  checked?: boolean;
  run: () => void | Promise<void>;
}

/** Ids left out: opening Search Menus from inside it. */
const EXCLUDED = new Set(["help.searchMenus"]);

/** "Save As..." → "Save As" (the palette reads better without the dots). */
function bare(label: string): string {
  return label.replace(/(\.\.\.|…)$/, "");
}

export function searchableCommands(menu: AppMenu): SearchableCommand[] {
  const out: SearchableCommand[] = [];
  const walk = (nodes: MenuNode[], group: string, path: string[]) => {
    for (const node of nodes) {
      const name = (label: string) => [...path, bare(label)].join(" › ");
      switch (node.kind) {
        case "item":
          if (node.enabled !== false && !EXCLUDED.has(node.id)) {
            out.push({ id: node.id, group, label: name(node.label), shortcut: node.shortcut, run: node.run });
          }
          break;
        case "check":
          if (node.enabled !== false) {
            out.push({ id: node.id, group, label: name(node.label), shortcut: node.shortcut, checked: node.checked, run: node.run });
          }
          break;
        case "radio":
          for (const o of node.options) {
            if (node.enabled === false || o.enabled === false) continue;
            const label = path.length
              ? `${path.join(" › ")}: ${o.label}`
              : o.label;
            out.push({
              id: `${node.id}=${o.value}`,
              group,
              label,
              checked: o.value === node.value,
              run: () => node.select(o.value),
            });
          }
          break;
        case "submenu":
          if (node.enabled !== false) walk(node.items, group, [...path, bare(node.label)]);
          break;
      }
    }
  };
  for (const top of menu) {
    if (top.kind === "action") {
      out.push({ id: top.id, group: top.searchGroup, label: top.label, run: top.run });
    } else {
      walk(top.items, top.label, []);
    }
  }
  return out;
}
