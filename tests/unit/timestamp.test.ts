import { describe, it, expect } from "../bun-test";
import { formatRunTimestamp } from "@/lib/timestamp";

describe("formatRunTimestamp", () => {
  it("matches legacy SLEAP's YYMMDD_HHMMSS format with no trailing punctuation", () => {
    const ts = formatRunTimestamp();
    expect(ts).toMatch(/^\d{6}_\d{6}$/);
  });
});
