/**
 * What a click or double-click on a node does, by modifier keys. Kept apart
 * from VideoPlayer so the bindings can be tested without a canvas.
 *
 * Legacy SLEAP's gestures keep their legacy keys:
 *   - Shift+click a node: mark every node of the instance complete.
 *   - Double-click a user instance: add its missing nodes.
 *   - Shift+double-click a prediction: accept it with every node complete.
 *   - Ctrl+click(-drag) a user instance: clone it and drag the copy.
 * sleap-app's own gestures that used those keys moved:
 *   - Toggle one node in the selection: Alt+Shift+click (was Shift+click).
 *   - Select every node of the instance: Shift+A (was double-click).
 */

export interface Modifiers {
  shiftKey: boolean;
  altKey: boolean;
}

export type NodeClickAction =
  /** Add or remove the node from the multi-node selection. */
  | "toggle-selection"
  /** Mark every node of the clicked user instance complete (no drag). */
  | "mark-instance-complete"
  /** Select the node and start dragging it. */
  | "select-and-drag";

/** A mouse-down on a node (Ctrl+drag cloning is decided before this). */
export function nodeClickAction(mods: Modifiers): NodeClickAction {
  if (mods.shiftKey && mods.altKey) return "toggle-selection";
  if (mods.shiftKey) return "mark-instance-complete";
  return "select-and-drag";
}

export type InstanceDoubleClickAction =
  | "accept-prediction"
  | "accept-prediction-complete"
  | "add-missing-nodes";

/** A double-click on an instance's node or body. */
export function instanceDoubleClickAction(
  isPredicted: boolean,
  mods: Pick<Modifiers, "shiftKey">
): InstanceDoubleClickAction {
  if (isPredicted) return mods.shiftKey ? "accept-prediction-complete" : "accept-prediction";
  return "add-missing-nodes";
}

/**
 * Mouse gestures on the video canvas, for Help ▸ Keyboard Shortcuts. The docs
 * page (docs/reference/shortcuts.md, "Canvas gestures") lists these too.
 * `modifiers` is a tinykeys-style prefix ("Alt+Shift"), "" for none.
 */
export const CANVAS_GESTURES: { modifiers: string; gesture: string; action: string }[] = [
  { modifiers: "Shift", gesture: "Click a node", action: "Mark the whole instance complete" },
  { modifiers: "Alt+Shift", gesture: "Click a node", action: "Add or remove it from the selection" },
  { modifiers: "", gesture: "Double-click a user instance", action: "Add its missing nodes" },
  { modifiers: "", gesture: "Double-click a prediction", action: "Accept it as your label" },
  { modifiers: "Shift", gesture: "Double-click a prediction", action: "Accept it, every node complete" },
  { modifiers: "Alt", gesture: "Drag a node", action: "Move the whole instance" },
  { modifiers: "Ctrl", gesture: "Drag a user instance", action: "Clone it and drag the copy" },
];
