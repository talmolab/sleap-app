/**
 * Escape inside an open modal/popover must not also end an active-learning
 * sweep. Radix closes its layer on Escape but doesn't stop propagation, so the
 * global "clear selection" shortcut used to see the same key and exit the
 * keypoint pass / correction mode — wiping its cursor or queue — whenever the
 * user dismissed an in-app confirm dialog or the sweep's own cheatsheet.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { render } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";

function pressEscape(target: EventTarget) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }),
  );
}

describe("Escape vs. an active-learning sweep", () => {
  beforeEach(async () => {
    const { useKeyboardShortcuts } = await import("@/hooks/useKeyboardShortcuts");
    function Harness() {
      useKeyboardShortcuts();
      return null;
    }
    render(<Harness />);
    useAppStore.getState().set("labelingMode", "keypointPass");
  });

  it("leaves the sweep running when Escape comes from inside a dialog", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    try {
      pressEscape(button);
      expect(useAppStore.getState().labelingMode).toBe("keypointPass");
    } finally {
      dialog.remove();
    }
  });

  it("leaves the sweep running when something already consumed the Escape", () => {
    const consume = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", consume, { capture: true });
    try {
      pressEscape(document.body);
      expect(useAppStore.getState().labelingMode).toBe("keypointPass");
    } finally {
      window.removeEventListener("keydown", consume, { capture: true });
    }
  });

  it("still exits the sweep on a plain Escape", () => {
    pressEscape(document.body);
    expect(useAppStore.getState().labelingMode).toBe("select");
  });
});
