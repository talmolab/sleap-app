import { test, expect, describe } from "bun:test";
import {
  planOpen,
  readOpenFileParam,
  type Resolution,
} from "@/lib/windowRouting";
import { buildInstanceUrl } from "@/lib/newInstance";

describe("planOpen", () => {
  const r = (action: Resolution["action"], label: string | null): Resolution => ({
    action,
    label,
  });

  test("focus → focus that window", () => {
    expect(planOpen(r("focus", "main-2"), "main")).toEqual({
      kind: "focus",
      label: "main-2",
    });
  });

  test("reuse of the CURRENT window → load in place here", () => {
    expect(planOpen(r("reuse", "main"), "main")).toEqual({ kind: "loadHere" });
  });

  test("reuse of ANOTHER window → tell that window to load", () => {
    expect(planOpen(r("reuse", "main-3"), "main")).toEqual({
      kind: "loadElsewhere",
      label: "main-3",
    });
  });

  test("new → spawn a new window", () => {
    expect(planOpen(r("new", null), "main")).toEqual({ kind: "newWindow" });
  });

  test("malformed focus (no label) falls back to a new window (never clobbers)", () => {
    expect(planOpen(r("focus", null), "main")).toEqual({ kind: "newWindow" });
  });

  test("malformed reuse (no label) falls back to a new window", () => {
    expect(planOpen(r("reuse", null), "main")).toEqual({ kind: "newWindow" });
  });
});

describe("buildInstanceUrl", () => {
  test("no file → base unchanged", () => {
    expect(buildInstanceUrl("http://localhost:1420/")).toBe(
      "http://localhost:1420/"
    );
  });

  test("with file → appends ?openFile= (URL-encoded)", () => {
    expect(buildInstanceUrl("http://localhost:1420/", "/a/b.slp")).toBe(
      "http://localhost:1420/?openFile=%2Fa%2Fb.slp"
    );
  });

  test("base already has a query → appends with &", () => {
    expect(buildInstanceUrl("http://x/?forceLibavH264", "/a.slp")).toBe(
      "http://x/?forceLibavH264&openFile=%2Fa.slp"
    );
  });

  test("encodes spaces and special characters in the path", () => {
    const url = buildInstanceUrl("http://x/", "/vol/train copy.slp");
    expect(url).toBe("http://x/?openFile=%2Fvol%2Ftrain%20copy.slp");
    // Round-trips back to the original path.
    expect(readOpenFileParam(new URL(url).search)).toBe("/vol/train copy.slp");
  });
});

describe("readOpenFileParam", () => {
  test("present → decoded path", () => {
    expect(readOpenFileParam("?openFile=%2Fa%2Fb.slp")).toBe("/a/b.slp");
  });

  test("absent → null", () => {
    expect(readOpenFileParam("?forceLibavH264")).toBeNull();
    expect(readOpenFileParam("")).toBeNull();
  });

  test("decodes spaces", () => {
    expect(readOpenFileParam("?openFile=%2Fx%2Ftrain%20copy.slp")).toBe(
      "/x/train copy.slp"
    );
  });
});
