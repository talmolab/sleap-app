/**
 * Tests for keyboard shortcut bindings.
 *
 * Locks in the pan/drag mode toggle binding: the UI (status-bar tooltip,
 * View menu hint) advertises "P" as the key that switches between Pan and
 * Select modes, so the shortcut map MUST bind "toggle pan mode" to KeyP.
 * It was previously (incorrectly) bound to KeyM, so pressing "p" did nothing.
 */

import { describe, it, expect } from "../bun-test";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";

describe("DEFAULT_SHORTCUTS", () => {
  it("binds 'toggle pan mode' to the P key (matches the UI hint)", () => {
    expect(DEFAULT_SHORTCUTS["toggle pan mode"]).toBe("KeyP");
  });

  it("does not collide 'toggle pan mode' with 'toggle place mode'", () => {
    expect(DEFAULT_SHORTCUTS["toggle pan mode"]).not.toBe(
      DEFAULT_SHORTCUTS["toggle place mode"],
    );
  });

  it("puts Mark Negative on N (as in SLEAP) and node placement mode on Shift+N", () => {
    expect(DEFAULT_SHORTCUTS["mark negative"]).toBe("KeyN");
    expect(DEFAULT_SHORTCUTS["toggle place mode"]).toBe("Shift+KeyN");
  });
});

describe("N vs Shift+N (tinykeys)", () => {
  it("Shift+N fires only node placement mode; plain N only Mark Negative", async () => {
    const { tinykeys } = await import("tinykeys");
    const fired: string[] = [];
    const unbind = tinykeys(window, {
      [DEFAULT_SHORTCUTS["mark negative"]]: () => fired.push("negative"),
      [DEFAULT_SHORTCUTS["toggle place mode"]]: () => fired.push("place"),
    });
    const press = (shiftKey: boolean) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: shiftKey ? "N" : "n", code: "KeyN", shiftKey }));
    press(true);
    press(false);
    unbind();
    expect(fired).toEqual(["place", "negative"]);
  });
});
