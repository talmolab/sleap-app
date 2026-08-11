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

  it("keeps 'toggle place mode' on the N key", () => {
    expect(DEFAULT_SHORTCUTS["toggle place mode"]).toBe("KeyN");
  });
});
