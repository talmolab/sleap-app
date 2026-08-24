import { describe, it, expect } from "../bun-test";
import { formatShortcut } from "@/lib/formatShortcut";

describe("formatShortcut", () => {
  describe("on macOS", () => {
    const mac = (b: string) => formatShortcut(b, true);

    it("renders $mod as ⌘ and joins with +", () => {
      expect(mac("$mod+KeyC")).toBe("⌘+C");
    });
    it("renders Shift as ⇧", () => {
      expect(mac("$mod+Shift+KeyS")).toBe("⌘+⇧+S");
    });
    it("renders Alt as ⌥ and arrows as glyphs", () => {
      expect(mac("Alt+ArrowRight")).toBe("⌥+→");
    });
    it("renders Shift+Space", () => {
      expect(mac("Shift+Space")).toBe("⇧+Space");
    });
    it("renders Backspace as ⌫", () => {
      expect(mac("$mod+Backspace")).toBe("⌘+⌫");
    });
    it("keeps the modifier order from the binding", () => {
      expect(mac("$mod+Alt+KeyE")).toBe("⌘+⌥+E");
    });
    it("expands Digit, Equal and Minus", () => {
      expect(mac("$mod+Digit0")).toBe("⌘+0");
      expect(mac("$mod+Equal")).toBe("⌘+=");
      expect(mac("$mod+Minus")).toBe("⌘+-");
      expect(mac("$mod+Shift+Equal")).toBe("⌘+⇧+=");
    });
  });

  describe("on Windows/Linux", () => {
    const other = (b: string) => formatShortcut(b, false);

    it("renders $mod as Ctrl", () => {
      expect(other("$mod+Shift+KeyS")).toBe("Ctrl+Shift+S");
    });
    it("keeps Alt/Shift spelled out", () => {
      expect(other("Alt+ArrowRight")).toBe("Alt+→");
      expect(other("Shift+Space")).toBe("Shift+Space");
    });
    it("keeps Backspace spelled out", () => {
      expect(other("$mod+Backspace")).toBe("Ctrl+Backspace");
    });
  });

  describe("platform-neutral tokens", () => {
    it("maps Backquote and Escape", () => {
      expect(formatShortcut("Backquote", true)).toBe("`");
      expect(formatShortcut("Escape", false)).toBe("Esc");
    });
    it("passes through bare keys like Home", () => {
      expect(formatShortcut("Home", true)).toBe("Home");
      expect(formatShortcut("KeyR", false)).toBe("R");
    });
    it("returns empty string for an unbound shortcut", () => {
      expect(formatShortcut("", true)).toBe("");
    });
  });
});
