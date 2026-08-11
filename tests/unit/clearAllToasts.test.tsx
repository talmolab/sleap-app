/**
 * "Clear all" toasts shortcut wiring.
 *
 * Feature: a keyboard shortcut dismisses ALL currently-stacked on-screen toasts
 * at once. sonner v2's `toast.dismiss()` with NO id already clears the whole
 * live stack, so this only tests the *wiring*:
 *   1. the registry entry exists, uses the chosen binding, and does not collide
 *      with any other registry binding, and
 *   2. pressing that key calls `dismiss()` (from @/lib/notify) with NO arguments
 *      (the no-id form == dismiss-all).
 *
 * Per the repo default we keep this thin: trust sonner's dismiss-all behaviour,
 * test only that our key is bound to it.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { render } from "@testing-library/react";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";

// Mock @/lib/notify BEFORE the hook (which statically imports it) is loaded.
// bun's mock.module only affects modules imported AFTER this call, so the hook
// must be pulled in via a dynamic import inside the test (see caveat in
// tests/bun-test.ts).
const dismissSpy = vi.fn();
const toastStub = Object.assign(vi.fn(), {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
  loading: vi.fn(),
  promise: vi.fn(),
  dismiss: dismissSpy,
  custom: vi.fn(),
  getHistory: vi.fn(),
  getToasts: vi.fn(),
});
vi.mock("@/lib/notify", () => ({ toast: toastStub, dismiss: dismissSpy }));

/** Build a KeyboardEvent that tinykeys will match for `$mod+Shift+KeyD`,
 * mirroring tinykeys' own `$mod` resolution (Meta on Apple, Control else). */
function pressClearAllToasts() {
  const platform = typeof navigator === "object" ? navigator.platform : "";
  const isMac = /Mac|iPod|iPhone|iPad/.test(platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "KeyD",
      key: "d",
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("clear-all-toasts shortcut", () => {
  beforeEach(() => {
    dismissSpy.mockClear();
  });

  it("registers a $mod+Shift+KeyD binding that collides with nothing else", () => {
    const binding = DEFAULT_SHORTCUTS["dismiss all toasts"];
    expect(binding).toBe("$mod+Shift+KeyD");

    // No other registry entry shares this binding.
    const collisions = Object.entries(DEFAULT_SHORTCUTS).filter(
      ([name, b]) => name !== "dismiss all toasts" && b === binding,
    );
    expect(collisions).toEqual([]);
  });

  it("calls notify.dismiss() with no args (dismiss-all) when pressed", async () => {
    const { useKeyboardShortcuts } = await import(
      "@/hooks/useKeyboardShortcuts"
    );
    function Harness() {
      useKeyboardShortcuts();
      return null;
    }
    render(<Harness />);

    pressClearAllToasts();

    expect(dismissSpy).toHaveBeenCalledTimes(1);
    // No-id form => dismiss ALL live toasts.
    expect(dismissSpy.mock.calls[0]).toEqual([]);
  });
});
