import { describe, it, expect } from "../bun-test";
import {
  resolveProjectKey,
  getActiveTrackOverrides,
  EMPTY_TRACK_OVERRIDES,
  setTrackColorOverride,
  resetTrackColorOverride,
  renameTrackColorOverride,
  pruneTrackColorOverrides,
  capTrackColorOverrides,
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

describe("renameTrackColorOverride", () => {
  it("moves an override from the old name to the new name", () => {
    expect(renameTrackColorOverride({ "a.slp": { t0: "#111111" } }, "a.slp", "t0", "t1")).toEqual({
      "a.slp": { t1: "#111111" },
    });
  });

  it("lets the renamed track's color win if the new name already had one", () => {
    expect(
      renameTrackColorOverride({ "a.slp": { t0: "#111111", t1: "#222222" } }, "a.slp", "t0", "t1"),
    ).toEqual({ "a.slp": { t1: "#111111" } });
  });

  it("is a no-op (same ref) when the old name has no override", () => {
    const prev = { "a.slp": { t0: "#111111" } };
    expect(renameTrackColorOverride(prev, "a.slp", "tX", "tY")).toBe(prev);
    expect(renameTrackColorOverride(prev, "zzz", "t0", "t1")).toBe(prev);
  });
});

describe("pruneTrackColorOverrides", () => {
  it("drops overrides whose track name is no longer valid", () => {
    expect(
      pruneTrackColorOverrides({ "a.slp": { t0: "#111111", gone: "#222222" } }, "a.slp", ["t0", "t1"]),
    ).toEqual({ "a.slp": { t0: "#111111" } });
  });

  it("drops the project entry when everything is pruned", () => {
    expect(
      pruneTrackColorOverrides({ "a.slp": { gone: "#222222" }, "b.slp": { t0: "#333333" } }, "a.slp", []),
    ).toEqual({ "b.slp": { t0: "#333333" } });
  });

  it("is a no-op (same ref) when nothing needs pruning or the project is absent", () => {
    const prev = { "a.slp": { t0: "#111111" } };
    expect(pruneTrackColorOverrides(prev, "a.slp", ["t0"])).toBe(prev);
    expect(pruneTrackColorOverrides(prev, "zzz", [])).toBe(prev);
  });
});

describe("capTrackColorOverrides", () => {
  it("returns the same map when under the cap", () => {
    const prev = { p1: { t0: "#111111" }, p2: { t0: "#222222" } };
    expect(capTrackColorOverrides(prev, 5)).toBe(prev);
  });

  it("keeps the most-recent N projects (by key insertion order), evicting oldest", () => {
    const prev = {
      p1: { t: "#111111" },
      p2: { t: "#222222" },
      p3: { t: "#333333" },
      p4: { t: "#444444" },
    };
    expect(capTrackColorOverrides(prev, 2)).toEqual({
      p3: { t: "#333333" },
      p4: { t: "#444444" },
    });
  });
});

describe("setTrackColorOverride recency", () => {
  it("bumps the touched project to most-recent (last key)", () => {
    const prev = { p1: { t0: "#111111" }, p2: { t0: "#222222" } };
    const next = setTrackColorOverride(prev, "p1", "t1", "#333333");
    expect(Object.keys(next)).toEqual(["p2", "p1"]);
  });
});
