/**
 * The user's keyboard shortcuts in the menus: which menu item runs which
 * shortcut action, so the in-window menu bar, Search Menus and the native
 * macOS menu (its accelerators) all show the key the user picked, and an
 * action that only exists as a menu command still runs from its key.
 */

import { mainShortcut, type ShortcutOverrides } from "@/lib/shortcuts";
import type { AppMenu, MenuNode } from "./types";

/**
 * Menu item id → the shortcut action it runs. (Predict ▸ Training… isn't
 * here: its key, ⌘L, opens the Training panel, while the menu item also
 * opens the full configuration.)
 */
export const MENU_SHORTCUT_ACTIONS: Record<string, string> = {
  "file.new": "new",
  "file.open": "open",
  "file.save": "save",
  "file.saveAs": "save as",
  "file.quit": "close",
  "file.export.clip": "export clip",
  "file.export.analysisH5.current": "export_analysis_current",
  "go.toFrame": "goto frame",
  "go.selectToFrame": "select to frame",
  "go.nextLabeled": "goto next labeled",
  "go.prevLabeled": "goto prev labeled",
  "go.nextSuggestion": "goto next suggestion",
  "go.prevSuggestion": "goto prev suggestion",
  "go.lastInteracted": "goto last interacted",
  "go.nextUser": "goto next user",
  "go.prevUser": "goto prev user",
  "go.nextTrackSpawn": "goto next track spawn",
  "go.nextQcFlag": "goto next qc flag",
  "go.prevQcFlag": "goto prev qc flag",
  "go.qcMarkOk": "ignore qc flag",
  "go.markFrame": "mark frame",
  "go.toMarkedFrame": "goto marked frame",
  "go.nextVideo": "next video",
  "go.prevVideo": "prev video",
  "go.nextInstance": "select next",
  "go.clearSelection": "clear selection",
  "view.fit": "fit",
  "view.defaultToPan": "toggle pan mode",
  "view.placementMode": "toggle place mode",
  "view.showInstances": "show instances",
  "view.showNonVisibleNodes": "show non-visible nodes",
  "view.showLabels": "show labels",
  "view.showEdges": "show edges",
  "view.colorPredicted": "color predicted",
  "labels.addInstance": "add instance",
  "labels.deleteInstance": "delete instance",
  "labels.mergeInstance": "merge instance",
  "labels.copyInstance": "copy instance",
  "labels.pasteInstance": "paste instance",
  "labels.markNegative": "mark negative",
  "labels.acceptFrame": "accept all predictions",
  "labels.deleteFramePredictions": "delete frame predictions",
  "labels.deleteClip": "delete clip predictions",
  "labels.deleteArea": "delete area predictions",
  "labels.bboxes.tool": "box tool",
  "tracks.transpose": "transpose",
  "tracks.new": "add track",
  "tracks.copy": "copy track",
  "tracks.paste": "paste track",
  "tracks.propagate": "propagate track labels",
  "tracks.deleteInstanceAndTrack": "delete track",
};

function mapNodes(nodes: MenuNode[], overrides: ShortcutOverrides): MenuNode[] {
  return nodes.map((node) => {
    if (node.kind === "submenu") return { ...node, items: mapNodes(node.items, overrides) };
    if (node.kind !== "item" && node.kind !== "check") return node;
    const action = MENU_SHORTCUT_ACTIONS[node.id];
    if (!action) return node;
    return { ...node, shortcut: mainShortcut(action, overrides) };
  });
}

/**
 * The menu with each item's shortcut set to its action's current key (the
 * user's, or the default), or none if the user left the action unbound.
 */
export function withUserShortcuts(menu: AppMenu, overrides: ShortcutOverrides): AppMenu {
  return menu.map((top) => (top.kind === "menu" ? { ...top, items: mapNodes(top.items, overrides) } : top));
}

function stripNodes(nodes: MenuNode[]): MenuNode[] {
  return nodes.map((node) => {
    if (node.kind === "submenu") return { ...node, items: stripNodes(node.items) };
    if (node.kind !== "item" && node.kind !== "check") return node;
    return { ...node, shortcut: undefined };
  });
}

/**
 * The menu with no shortcuts at all, for while the Shortcuts dialog waits
 * for a key: on macOS the native menu bar takes a key that's one of its
 * accelerators (⌘K → Delete Predictions from Area…) before the page sees it.
 */
export function withoutShortcuts(menu: AppMenu): AppMenu {
  return menu.map((top) => (top.kind === "menu" ? { ...top, items: stripNodes(top.items) } : top));
}

/** The menu item for an action, if it has one (enabled or not). */
export function menuItemForAction(
  menu: AppMenu,
  action: string,
): Extract<MenuNode, { kind: "item" | "check" }> | null {
  const walk = (nodes: MenuNode[]): Extract<MenuNode, { kind: "item" | "check" }> | null => {
    for (const node of nodes) {
      if ((node.kind === "item" || node.kind === "check") && MENU_SHORTCUT_ACTIONS[node.id] === action) return node;
      if (node.kind === "submenu") {
        const found = walk(node.items);
        if (found) return found;
      }
    }
    return null;
  };
  for (const top of menu) {
    if (top.kind === "menu") {
      const found = walk(top.items);
      if (found) return found;
    }
  }
  return null;
}
