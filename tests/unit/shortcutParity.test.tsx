/**
 * Legacy SLEAP's keys that sleap-app didn't have: Shift+P for Propagate
 * Track Labels (SLEAP's P is pan mode here), Ctrl+Alt+arrows for ±100 frames
 * and Ctrl+Tab for Show Node Names, each alongside sleap-app's own key. These
 * drive the real global handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/appStore";
import {
  DEFAULT_SHORTCUTS,
  EXTRA_SHORTCUTS,
  shortcutBindings,
  bindActions,
} from "@/lib/shortcuts";
import type { Video } from "@/types";

// tinykeys reads $mod as ⌘ on Apple platforms, Ctrl elsewhere; press the same.
const MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

interface Mods {
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

function press(key: string, code: string, m: Mods = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        metaKey: !!m.mod && MAC,
        ctrlKey: !!m.ctrl || (!!m.mod && !MAC),
        altKey: !!m.alt,
        shiftKey: !!m.shift,
        bubbles: true,
      }),
    );
  });
}

function mockVideo(): Video {
  return {
    filename: "test.mp4",
    shape: [1000, 480, 640, 3],
    backend: null,
    source_video: null,
  } as unknown as Video;
}

describe("shortcut map", () => {
  // Shift+P was picked for Propagate Track Labels because nothing used it;
  // this catches any key later bound to two actions.
  it("binds no key to two actions", () => {
    const all = Object.keys(DEFAULT_SHORTCUTS).flatMap((a) => shortcutBindings(a));
    const dupes = all.filter((b, i) => all.indexOf(b) !== i);
    expect(dupes).toEqual([]);
  });

  // The decided keys, so they don't drift.
  it("keeps P as pan mode and puts Propagate Track Labels on Shift+P", () => {
    expect(DEFAULT_SHORTCUTS["toggle pan mode"]).toBe("KeyP");
    expect(DEFAULT_SHORTCUTS["propagate track labels"]).toBe("Shift+KeyP");
  });

  // The Shortcuts dialog lists both keys from here.
  it("lists sleap-app's key first, then legacy SLEAP's", () => {
    expect(shortcutBindings("frame next large step")).toEqual([
      "$mod+Shift+ArrowRight",
      "$mod+Alt+ArrowRight",
    ]);
    expect(shortcutBindings("show labels")).toEqual(["KeyT", "Control+Tab"]);
    expect(shortcutBindings("transpose")).toEqual(["$mod+KeyT"]);
  });

  // Extras must reuse the main key's handler, not need their own.
  it("bindActions gives each extra key its action's handler", () => {
    const show = () => {};
    const out = bindActions({ "show labels": show });
    expect(out[DEFAULT_SHORTCUTS["show labels"]]).toBe(show);
    expect(out["Control+Tab"]).toBe(show);
    expect(out[EXTRA_SHORTCUTS["frame next large step"][0]]).toBeUndefined();
  });
});

describe("legacy SLEAP keys (global handler)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    renderHook(() => useKeyboardShortcuts());
  });
  afterEach(() => cleanup());

  // Shift+P must toggle Propagate Track Labels and leave pan mode alone.
  it("Shift+P toggles Propagate Track Labels, not pan mode", () => {
    const pan = useAppStore.getState().defaultToPan;
    press("P", "KeyP", { shift: true });
    expect(useAppStore.getState().propagateTrackLabels).toBe(true);
    expect(useAppStore.getState().defaultToPan).toBe(pan);
    press("P", "KeyP", { shift: true });
    expect(useAppStore.getState().propagateTrackLabels).toBe(false);
  });

  // Plain P is still pan mode and doesn't touch propagation.
  it("plain P still toggles pan mode only", () => {
    const pan = useAppStore.getState().defaultToPan;
    press("p", "KeyP");
    expect(useAppStore.getState().defaultToPan).toBe(!pan);
    expect(useAppStore.getState().propagateTrackLabels).toBe(false);
  });

  // PyQt's Ctrl+Alt+arrows step 100 frames.
  it("Ctrl+Alt+Right / Left step ±100 frames", () => {
    useAppStore.setState({ video: mockVideo(), frameIdx: 200 });
    press("ArrowRight", "ArrowRight", { mod: true, alt: true });
    expect(useAppStore.getState().frameIdx).toBe(300);
    press("ArrowLeft", "ArrowLeft", { mod: true, alt: true });
    press("ArrowLeft", "ArrowLeft", { mod: true, alt: true });
    expect(useAppStore.getState().frameIdx).toBe(100);
  });

  // sleap-app's own Ctrl+Shift+arrows keep working alongside.
  it("Ctrl+Shift+Right / Left still step ±100 frames", () => {
    useAppStore.setState({ video: mockVideo(), frameIdx: 200 });
    press("ArrowRight", "ArrowRight", { mod: true, shift: true });
    expect(useAppStore.getState().frameIdx).toBe(300);
    press("ArrowLeft", "ArrowLeft", { mod: true, shift: true });
    expect(useAppStore.getState().frameIdx).toBe(200);
  });

  // PyQt's Ctrl+Tab shows/hides node names, using the real Control key.
  it("Ctrl+Tab toggles Show Node Names", () => {
    const before = useAppStore.getState().showLabels;
    press("Tab", "Tab", { ctrl: true });
    expect(useAppStore.getState().showLabels).toBe(!before);
    press("Tab", "Tab", { ctrl: true });
    expect(useAppStore.getState().showLabels).toBe(before);
  });

  // T keeps working, and plain Tab (node cycling) doesn't touch node names.
  it("T still toggles Show Node Names; plain Tab doesn't", () => {
    const before = useAppStore.getState().showLabels;
    press("Tab", "Tab");
    expect(useAppStore.getState().showLabels).toBe(before);
    press("t", "KeyT");
    expect(useAppStore.getState().showLabels).toBe(!before);
  });
});
