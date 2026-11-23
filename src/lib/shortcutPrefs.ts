/**
 * The keys bound to an action right now, with the user's own shortcuts
 * (appStore `shortcutOverrides`, set in Help ▸ Keyboard Shortcuts…) — for the
 * places that show a key or check one outside the global key handler.
 */

import { useAppStore } from "@/stores/appStore";
import { mainShortcut, shortcutBindings } from "./shortcuts";
import { keyFromEvent, sameKey } from "./shortcutEditing";

/** Every key bound to an action now. */
export function currentShortcuts(action: string): string[] {
  return shortcutBindings(action, useAppStore.getState().shortcutOverrides);
}

/** The key shown for an action now (its first key), or "" if unbound. */
export function currentShortcut(action: string): string {
  return mainShortcut(action, useAppStore.getState().shortcutOverrides) ?? "";
}

/** `currentShortcut` that re-renders when the user changes it. */
export function useShortcut(action: string): string {
  return useAppStore((s) => mainShortcut(action, s.shortcutOverrides) ?? "");
}

/** Whether a key press is one of an action's keys (exact modifiers). */
export function eventMatchesAction(e: KeyboardEvent, action: string): boolean {
  const pressed = keyFromEvent(e);
  return pressed !== null && currentShortcuts(action).some((binding) => sameKey(binding, pressed));
}
