import { describe, it, expect } from "../bun-test";
import {
  resolveProjectKey,
  getActiveTrackOverrides,
  EMPTY_TRACK_OVERRIDES,
} from "@/lib/trackColorOverrides";

describe("resolveProjectKey", () => {
  it("uses the project path when present (desktop)", () => {
    expect(resolveProjectKey("/Users/me/labels.v001.slp", "labels.v001.slp")).toBe(
      "/Users/me/labels.v001.slp",
    );
  });

  it("falls back to the filename when there is no path (browser)", () => {
    expect(resolveProjectKey(null, "labels.v001.slp")).toBe("labels.v001.slp");
  });

  it("treats empty strings as absent", () => {
    expect(resolveProjectKey("", "labels.slp")).toBe("labels.slp");
    expect(resolveProjectKey("", "")).toBe("__unsaved__");
  });

  it("returns the unsaved sentinel when neither is available", () => {
    expect(resolveProjectKey(null, null)).toBe("__unsaved__");
  });
});

describe("getActiveTrackOverrides", () => {
  const overrides = {
    "/proj/a.slp": { track_0: "#111111" },
    "b.slp": { track_1: "#222222" },
  };

  it("returns the map for the active project (by path)", () => {
    expect(getActiveTrackOverrides(overrides, "/proj/a.slp", "a.slp")).toEqual({
      track_0: "#111111",
    });
  });

  it("returns the map for a browser project (by filename)", () => {
    expect(getActiveTrackOverrides(overrides, null, "b.slp")).toEqual({
      track_1: "#222222",
    });
  });

  it("returns the SAME stable empty map when the project has no overrides", () => {
    const a = getActiveTrackOverrides(overrides, "/proj/never.slp", "never.slp");
    const b = getActiveTrackOverrides(null, null, null);
    expect(a).toEqual({});
    expect(a).toBe(EMPTY_TRACK_OVERRIDES);
    expect(b).toBe(EMPTY_TRACK_OVERRIDES);
  });
});
