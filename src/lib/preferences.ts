/**
 * App-wide preference helpers: File ▸ Reset Preferences to Defaults… and the
 * frame step sizes (Go ▸ Frame Step Sizes…). The reset also puts keyboard
 * shortcuts back (`shortcutOverrides`; PyQt keeps those in shortcuts.yaml
 * and resets them from the Shortcuts dialog).
 *
 * PyQt SLEAP keeps these in `preferences.yaml` (`sleap/prefs.py`): "Reset
 * preferences to defaults..." rewrites that file with its defaults, and the
 * "medium step size" / "large step size" entries set how far Ctrl+arrow and
 * Ctrl+Shift+arrow jump. sleap-app keeps the same preferences in the persisted
 * app store (`PERSISTED_KEYS`).
 */

import { useAppStore, PERSISTED_KEYS, type AppState } from "@/stores/appStore";
import { confirmDialog } from "@/stores/confirmStore";
import { isValidStepSize } from "@/lib/shortcuts";

/**
 * Persisted keys a preferences reset leaves alone. They are saved alongside the
 * preferences but are not display or navigation settings: the desktop update
 * channel, one-time prompts that would otherwise reappear, and data the user
 * built up for specific projects (video path fixes, track colors).
 */
export const KEPT_ON_PREFERENCES_RESET: readonly (keyof AppState)[] = [
  "updateChannel",
  "updateChannelExplicitlySet",
  "hasOptedIntoLatestChannel",
  "packagesSetupNudgeDismissed",
  "hasSeenLabelingHintsPrompt",
  "videoPrefixSwaps",
  "trackColorOverrides",
];

/** The persisted keys that Reset Preferences to Defaults puts back. */
export function preferenceKeysToReset(): (keyof AppState)[] {
  return PERSISTED_KEYS.filter((k) => !KEPT_ON_PREFERENCES_RESET.includes(k));
}

/**
 * Put every resettable preference back to the value a fresh install starts
 * with. Takes effect immediately (the store is reactive), unlike PyQt, which
 * warns that some preferences only apply after a restart.
 */
export function resetPreferencesToDefaults(): void {
  const defaults = useAppStore.getInitialState();
  const patch: Partial<AppState> = {};
  for (const key of preferenceKeysToReset()) {
    // Copy so later edits to the live state never touch the defaults object.
    (patch as Record<string, unknown>)[key] = structuredClone(defaults[key]);
  }
  useAppStore.setState(patch);
  // The text-size CSS variable is only written by its own +/- handlers.
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--ui-scale", String(defaults.uiScale));
  }
}

/** Ask first, then reset. Resolves whether the preferences were reset. */
export async function confirmAndResetPreferences(): Promise<boolean> {
  const ok = await confirmDialog({
    title: "Reset Preferences",
    message:
      "Reset all preferences to their defaults?\n\n" +
      "This resets display settings (colors, marker and label sizes, trails), " +
      "navigation settings (step sizes, navigation scope), keyboard shortcuts, the panel layout and the text size.\n" +
      "Your projects, video path fixes, track colors and update channel are kept.",
    confirmLabel: "Reset",
    destructive: true,
  });
  if (ok) resetPreferencesToDefaults();
  return ok;
}

/**
 * Parse a frame step size typed by the user: a whole number of frames, at
 * least 1. Returns null for anything else.
 */
export function parseStepSize(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return isValidStepSize(n) ? n : null;
}
