/**
 * The app menu as data: one definition (`buildAppMenu`) that every place
 * showing the menus renders from — the in-window menu bar (`MenuBar.tsx`),
 * Search Menus (`MenuSearchDialog.tsx`), and the native macOS menu. Before,
 * each kept its own hand-written copy, and they drifted.
 *
 * A node only describes what to show (label, checked, enabled, shortcut) and
 * what to do (`run`); `run` reads fresh store state when it's called, so a
 * menu built a moment ago never acts on stale data.
 */

/** A tinykeys-style binding, e.g. `"$mod+Shift+KeyS"` (see `formatShortcut`). */
export type ShortcutBinding = string;

interface NodeBase {
  /** Stable id, e.g. `"file.save"` — native menu events and tests key on it. */
  id: string;
  /** `false` greys it out. Default enabled. */
  enabled?: boolean;
  /** Hover text (the in-window menu's `title`). */
  title?: string;
}

export interface MenuItemNode extends NodeBase {
  kind: "item";
  label: string;
  shortcut?: ShortcutBinding;
  /** Dimmed trailing text in place of a shortcut, e.g. `"2 set"`. */
  hint?: string;
  run: () => void | Promise<void>;
}

export interface MenuCheckNode extends NodeBase {
  kind: "check";
  label: string;
  checked: boolean;
  shortcut?: ShortcutBinding;
  /** Keep the menu open after toggling (to flip several in one trip). */
  keepOpen?: boolean;
  /** Toggles it. */
  run: () => void | Promise<void>;
}

/** A set of mutually exclusive choices (rendered inline in its parent). */
export interface MenuRadioNode extends NodeBase {
  kind: "radio";
  value: string;
  options: { value: string; label: string; enabled?: boolean }[];
  select: (value: string) => void;
}

export interface MenuSubmenuNode extends NodeBase {
  kind: "submenu";
  label: string;
  items: MenuNode[];
  /** Long, data-driven lists (videos, tracks): cap the height and scroll. */
  scroll?: boolean;
}

export interface MenuSeparatorNode {
  kind: "separator";
}

/** Read-only text, e.g. the labeled-frame counts at the bottom of Labels. */
export interface MenuLabelNode {
  kind: "label";
  id: string;
  text: string;
}

export type MenuNode =
  | MenuItemNode
  | MenuCheckNode
  | MenuRadioNode
  | MenuSubmenuNode
  | MenuSeparatorNode
  | MenuLabelNode;

/** A top-level menu (File, Edit, …). */
export interface TopMenu {
  kind: "menu";
  id: string;
  label: string;
  items: MenuNode[];
  /** Cap the menu's height to the window and scroll (View is the longest). */
  scroll?: boolean;
  /** `data-tutorial` hook on its trigger. */
  tutorialId?: string;
}

/** A top-level command shown as its own button in the in-window bar (Connect). */
export interface TopAction {
  kind: "action";
  id: string;
  label: string;
  /** The menu Search Menus files it under. */
  searchGroup: string;
  run: () => void | Promise<void>;
}

export type AppMenu = (TopMenu | TopAction)[];
