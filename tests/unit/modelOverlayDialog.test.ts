/**
 * Compare Model Predictions dialog: which files start ticked, the notes under
 * them, and the check cache that spares re-reading unchanged files.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { tickedByDefault, rowNote } from "@/components/dialogs/CompareModelsDialog";
import {
  checkCacheKey,
  clearCheckCache,
  getCachedCheck,
  setCachedCheck,
} from "@/lib/modelOverlay/checkCache";
import { targetFromVideo } from "@/lib/modelOverlay/core";
import { makeVideo } from "./modelOverlayTestData";

const usable = { ok: true as const, name: "m", frameCount: 5, matchedBy: "path" as const };

describe("default ticks and notes", () => {
  // A usable file for this video starts ticked.
  it("ticks an ordinary prediction file", () => {
    expect(tickedByDefault("/p/preds.slp", usable)).toBe(true);
    expect(rowNote("/p/preds.slp", usable)).toBeNull();
  });

  // Review: a run's train/val split predictions only cover labeled frames — listed, unticked, with a note.
  it("leaves training-split predictions unticked with a note", () => {
    expect(tickedByDefault("/p/models/run/labels_pr.val.slp", usable)).toBe(false);
    expect(rowNote("/p/models/run/labels_pr.val.slp", usable)).toContain("training split");
  });

  // Review: a name-only ("probable") video match is never ticked for you.
  it("leaves probable matches unticked with a note", () => {
    const probable = { ...usable, matchedBy: "probable" as const };
    expect(tickedByDefault("/p/preds.slp", probable)).toBe(false);
    expect(rowNote("/p/preds.slp", probable)).toContain("Probably this video");
  });
});

describe("check cache", () => {
  beforeEach(() => clearCheckCache());
  const target = targetFromVideo(makeVideo());

  // Reopening the dialog reuses the verdict for an unchanged file, without its poses.
  it("remembers a verdict by path, size and modified time, dropping the poses", () => {
    const key = checkCacheKey("/p/a.slp", 10, 1000, target, ["head"]);
    setCachedCheck(key, { ok: true, name: "a", frameCount: 1, matchedBy: "path", frames: new Map([[0, []]]) });
    expect(getCachedCheck(key)).toEqual({ ok: true, name: "a", frameCount: 1, matchedBy: "path" });
    // An edited file (new mtime) is checked again.
    expect(getCachedCheck(checkCacheKey("/p/a.slp", 10, 2000, target, ["head"]))).toBeUndefined();
  });

  // Without a modified time we can't tell an edited file apart, so nothing is cached.
  it("never caches when the modified time is unknown", () => {
    expect(checkCacheKey("/p/a.slp", 10, null, target, ["head"])).toBeNull();
  });
});
