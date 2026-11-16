/**
 * File ▸ Reset Preferences to Defaults… (PyQt SLEAP's "Reset preferences to
 * defaults..."): puts the saved display / navigation / layout preferences back
 * to a fresh install's values, only after the user confirms in the app's own
 * dialog (window.confirm does not work in the Tauri WebView).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import {
  KEPT_ON_PREFERENCES_RESET,
  preferenceKeysToReset,
  resetPreferencesToDefaults,
  confirmAndResetPreferences,
} from "@/lib/preferences";
import { DEFAULT_PANEL_ORDER } from "@/lib/panelLayout";

/** Change a spread of preferences away from their defaults. */
function customize() {
  const s = useAppStore.getState();
  s.set("palette", "alphabet");
  s.set("markerSize", 9);
  s.set("trailLength", 25);
  s.set("mediumStepSize", 7);
  s.set("largeStepSize", 70);
  s.set("defaultToPan", true);
  s.set("uiScale", 1.25);
  s.set("panelOrder", [...DEFAULT_PANEL_ORDER].reverse());
  s.set("navigationDomain", "labeled");
  // Kept on reset:
  s.set("updateChannel", "latest");
  s.set("videoPrefixSwaps", [{ oldPrefix: "/old/", newPrefix: "/new/" }]);
  s.set("trackColorOverrides", { "proj.slp": { mouse1: "#ff0000" } });
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useConfirmStore.setState({ request: null });
});

describe("preference keys", () => {
  // A renamed or removed store key must not silently fall out of the kept list.
  it("keeps only keys that are actually persisted", () => {
    for (const k of KEPT_ON_PREFERENCES_RESET) expect(PERSISTED_KEYS).toContain(k);
  });

  // Every persisted preference is either reset or deliberately kept.
  it("resets every persisted key that is not kept", () => {
    const reset = preferenceKeysToReset();
    expect(reset.length + KEPT_ON_PREFERENCES_RESET.length).toBe(PERSISTED_KEYS.length);
    expect(reset).toContain("mediumStepSize");
    expect(reset).toContain("largeStepSize");
    expect(reset).not.toContain("updateChannel");
  });
});

describe("resetPreferencesToDefaults", () => {
  // The reset must bring back each changed preference, the step sizes included.
  it("puts changed preferences back to their defaults", () => {
    const defaults = useAppStore.getInitialState();
    customize();
    resetPreferencesToDefaults();
    const s = useAppStore.getState();
    expect(s.palette).toBe(defaults.palette);
    expect(s.markerSize).toBe(defaults.markerSize);
    expect(s.trailLength).toBe(defaults.trailLength);
    expect(s.mediumStepSize).toBe(10);
    expect(s.largeStepSize).toBe(100);
    expect(s.defaultToPan).toBe(false);
    expect(s.uiScale).toBe(1);
    expect(s.panelOrder).toEqual([...DEFAULT_PANEL_ORDER]);
    expect(s.navigationDomain).toBe("all");
  });

  // The update channel and per-project data are not display preferences.
  it("keeps the update channel, video path fixes and track colors", () => {
    customize();
    resetPreferencesToDefaults();
    const s = useAppStore.getState();
    expect(s.updateChannel).toBe("latest");
    expect(s.videoPrefixSwaps).toEqual([{ oldPrefix: "/old/", newPrefix: "/new/" }]);
    expect(s.trackColorOverrides).toEqual({ "proj.slp": { mouse1: "#ff0000" } });
  });

  // Resetting preferences must never touch the open project or where you are in it.
  it("leaves non-preference state alone", () => {
    useAppStore.setState({ frameIdx: 42, hasChanges: true });
    resetPreferencesToDefaults();
    expect(useAppStore.getState().frameIdx).toBe(42);
    expect(useAppStore.getState().hasChanges).toBe(true);
  });

  // The text size is a CSS variable that nothing else re-reads after a reset.
  it("re-applies the default text size to the page", () => {
    document.documentElement.style.setProperty("--ui-scale", "1.4");
    useAppStore.getState().set("uiScale", 1.4);
    resetPreferencesToDefaults();
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1");
  });

  // Later edits to the live state must not leak into the defaults a second reset uses.
  it("does not share arrays with the defaults", () => {
    resetPreferencesToDefaults();
    expect(useAppStore.getState().panelOrder).not.toBe(useAppStore.getInitialState().panelOrder);
  });
});

describe("confirmAndResetPreferences", () => {
  // Cancel must leave every preference as it was.
  it("changes nothing when the user cancels", async () => {
    customize();
    const pending = confirmAndResetPreferences();
    expect(useConfirmStore.getState().request?.confirmLabel).toBe("Reset");
    useConfirmStore.getState().respond(false);
    expect(await pending).toBe(false);
    expect(useAppStore.getState().palette).toBe("alphabet");
    expect(useAppStore.getState().mediumStepSize).toBe(7);
  });

  // Only an explicit confirm resets.
  it("resets after the user confirms", async () => {
    customize();
    const pending = confirmAndResetPreferences();
    useConfirmStore.getState().respond(true);
    expect(await pending).toBe(true);
    expect(useAppStore.getState().palette).toBe("standard");
    expect(useAppStore.getState().mediumStepSize).toBe(10);
  });
});
