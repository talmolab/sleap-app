import { test, expect, describe } from "bun:test";
import { ellipsizeMiddle } from "@/lib/ellipsize";

describe("ellipsizeMiddle", () => {
  test("short string is returned unchanged", () => {
    expect(ellipsizeMiddle("clip.mp4", 44)).toBe("clip.mp4");
  });

  test("string exactly at the limit is unchanged", () => {
    const s = "a".repeat(20);
    expect(ellipsizeMiddle(s, 20)).toBe(s);
  });

  test("long string is middle-truncated to exactly max length with an ellipsis", () => {
    const name = "a".repeat(50) + ".mp4";
    const out = ellipsizeMiddle(name, 20);
    expect(out.length).toBe(20);
    expect(out).toContain("…");
  });

  test("keeps the head and the tail (so the extension stays visible)", () => {
    const name = "als2h_cohort2_cohort2.220506_093004_Camera0_mov.00001.mp4";
    const out = ellipsizeMiddle(name, 24);
    expect(out.startsWith("als2h")).toBe(true);
    expect(out.endsWith(".mp4")).toBe(true);
    expect(out).toContain("…");
    expect(out.length).toBe(24);
  });

  test("defaults to a 44-char budget when no max is given", () => {
    const name = "x".repeat(100);
    expect(ellipsizeMiddle(name).length).toBe(44);
  });
});
