/** Tests for the window-title formatter (PyQt setWindowTitle parity). */
import { describe, it, expect } from "../bun-test";
import { formatWindowTitle } from "@/hooks/useWindowTitle";

describe("formatWindowTitle", () => {
  it("shows app name only when no file is open", () => {
    expect(formatWindowTitle(null, false, "1.2.3")).toBe("SLEAP v1.2.3");
  });

  it("prefixes the filename when a file is open", () => {
    expect(formatWindowTitle("proj.slp", false, "1.2.3")).toBe(
      "proj.slp - SLEAP v1.2.3",
    );
  });

  it("adds a dirty marker when there are unsaved changes", () => {
    expect(formatWindowTitle("proj.slp", true, "1.2.3")).toBe(
      "proj.slp * - SLEAP v1.2.3",
    );
  });
});
