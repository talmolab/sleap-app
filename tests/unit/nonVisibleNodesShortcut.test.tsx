/**
 * One V press used to do two things: VideoPlayer flipped the hovered or
 * selected node's visibility, and the global shortcut (also plain V) flipped
 * View ▸ Show Non-Visible Nodes, so the node you'd just hidden vanished from
 * view. Show Non-Visible Nodes is now Shift+V, as in legacy SLEAP. These drive
 * the real global handler; VideoPlayer's half (plain V only) is checked in the
 * desktop app.
 */

import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/appStore";

function press(shiftKey: boolean) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: shiftKey ? "V" : "v", code: "KeyV", shiftKey, bubbles: true }),
    );
  });
}

describe("Show Non-Visible Nodes shortcut", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    renderHook(() => useKeyboardShortcuts());
  });
  afterEach(() => cleanup());

  it("plain V leaves Show Non-Visible Nodes alone", () => {
    const before = useAppStore.getState().showNonVisibleNodes;
    press(false);
    expect(useAppStore.getState().showNonVisibleNodes).toBe(before);
  });

  it("Shift+V toggles it, and again toggles it back", () => {
    const before = useAppStore.getState().showNonVisibleNodes;
    press(true);
    expect(useAppStore.getState().showNonVisibleNodes).toBe(!before);
    press(true);
    expect(useAppStore.getState().showNonVisibleNodes).toBe(before);
  });
});
