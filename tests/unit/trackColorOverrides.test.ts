import { describe, it, expect } from "../bun-test";
import {
  resolveProjectKey,
  getActiveTrackOverrides,
  EMPTY_TRACK_OVERRIDES,
  setTrackColorOverride,
  resetTrackColorOverride,
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

describe("setTrackColorOverride", () => {
  it("sets a color for a track under the project key (from empty)", () => {
    expect(setTrackColorOverride({}, "proj.slp", "track_0", "#112233")).toEqual({
      "proj.slp": { track_0: "#112233" },
    });
  });

  it("adds/overwrites without disturbing other tracks or projects", () => {
    const prev = {
      "a.slp": { track_0: "#aaaaaa", track_1: "#bbbbbb" },
      "b.slp": { track_0: "#cccccc" },
    };
    const next = setTrackColorOverride(prev, "a.slp", "track_1", "#ffffff");
    expect(next).toEqual({
      "a.slp": { track_0: "#aaaaaa", track_1: "#ffffff" },
      "b.slp": { track_0: "#cccccc" },
    });
  });

  it("does not mutate the input", () => {
    const prev = { "a.slp": { track_0: "#aaaaaa" } };
    const snapshot = JSON.parse(JSON.stringify(prev));
    setTrackColorOverride(prev, "a.slp", "track_1", "#ffffff");
    expect(prev).toEqual(snapshot);
  });
});

describe("resetTrackColorOverride", () => {
  it("removes a track's override", () => {
    const prev = { "a.slp": { track_0: "#aaaaaa", track_1: "#bbbbbb" } };
    expect(resetTrackColorOverride(prev, "a.slp", "track_0")).toEqual({
      "a.slp": { track_1: "#bbbbbb" },
    });
  });

  it("drops the project entry when its last override is removed", () => {
    const prev = { "a.slp": { track_0: "#aaaaaa" }, "b.slp": { track_0: "#cccccc" } };
    expect(resetTrackColorOverride(prev, "a.slp", "track_0")).toEqual({
      "b.slp": { track_0: "#cccccc" },
    });
  });

  it("is a no-op for an absent entry and does not mutate the input", () => {
    const prev = { "a.slp": { track_0: "#aaaaaa" } };
    const snapshot = JSON.parse(JSON.stringify(prev));
    expect(resetTrackColorOverride(prev, "a.slp", "nope")).toEqual(prev);
    expect(resetTrackColorOverride(prev, "zzz.slp", "track_0")).toEqual(prev);
    expect(prev).toEqual(snapshot);
  });
});
