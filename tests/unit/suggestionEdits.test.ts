/**
 * Tests for pure suggestion-list helpers (#159).
 *
 * These are React-free, store-free list utilities operating on a plain
 * SuggestionFrame[] used structurally as { video, frameIdx }.
 */

import { describe, it, expect } from "../bun-test";
import {
  suggestionExists,
  addSuggestionFrame,
  removeSuggestionAt,
  labeledSummary,
  mergeSuggestions,
  shuffleSuggestions,
  removeUnlabeledSuggestions,
  userLabeledFramesAsSuggestions,
} from "@/lib/suggestionEdits";
import { mulberry32 } from "@/lib/seededRng";
import type { SuggestionFrame, Video } from "@/types";

// Lightweight distinct Video stubs; only reference identity matters here.
const v1 = { filename: "a.mp4" } as unknown as Video;
const v2 = { filename: "b.mp4" } as unknown as Video;

function frame(video: Video, frameIdx: number): SuggestionFrame {
  return { video, frameIdx } as SuggestionFrame;
}

/** key for asserting membership/order without relying on object identity. */
function key(s: SuggestionFrame): string {
  return `${(s.video as unknown as { filename: string }).filename}#${s.frameIdx}`;
}

describe("suggestionExists", () => {
  it("returns true for a present (video, frameIdx)", () => {
    const list = [frame(v1, 0), frame(v1, 5), frame(v2, 5)];
    expect(suggestionExists(list, v1, 5)).toBe(true);
  });

  it("returns false for a different frameIdx on the same video", () => {
    const list = [frame(v1, 0), frame(v1, 5)];
    expect(suggestionExists(list, v1, 7)).toBe(false);
  });

  it("returns false for the same frameIdx on a different video reference", () => {
    const list = [frame(v1, 5)];
    expect(suggestionExists(list, v2, 5)).toBe(false);
  });
});

describe("addSuggestionFrame", () => {
  it("appends a new (video, frameIdx)", () => {
    const list = [frame(v1, 0)];
    const next = addSuggestionFrame(list, v1, 5);
    expect(next.length).toBe(2);
    expect(next[1].video).toBe(v1);
    expect(next[1].frameIdx).toBe(5);
  });

  it("is a no-op (length unchanged, no duplicate) when the exact pair exists", () => {
    const list = [frame(v1, 0), frame(v1, 5)];
    const next = addSuggestionFrame(list, v1, 5);
    expect(next.length).toBe(2);
    // No duplicate of (v1, 5).
    expect(next.filter((s) => s.video === v1 && s.frameIdx === 5).length).toBe(1);
  });

  it("appends when only the frameIdx differs", () => {
    const list = [frame(v1, 5)];
    const next = addSuggestionFrame(list, v1, 6);
    expect(next.length).toBe(2);
    expect(next[1].frameIdx).toBe(6);
  });

  it("appends when only the video reference differs", () => {
    const list = [frame(v1, 5)];
    const next = addSuggestionFrame(list, v2, 5);
    expect(next.length).toBe(2);
    expect(next[1].video).toBe(v2);
    expect(next[1].frameIdx).toBe(5);
  });

  it("always returns a new array and does not mutate the input (append case)", () => {
    const list = [frame(v1, 0)];
    const next = addSuggestionFrame(list, v1, 5);
    expect(next).not.toBe(list);
    expect(list.length).toBe(1);
  });

  it("always returns a new array and does not mutate the input (no-op case)", () => {
    const list = [frame(v1, 0), frame(v1, 5)];
    const next = addSuggestionFrame(list, v1, 5);
    expect(next).not.toBe(list);
    expect(list.length).toBe(2);
  });
});

describe("removeSuggestionAt", () => {
  it("removes exactly the element at idx, preserving order of the rest", () => {
    const a = frame(v1, 0);
    const b = frame(v1, 5);
    const c = frame(v2, 5);
    const list = [a, b, c];
    const next = removeSuggestionAt(list, 1);
    expect(next.length).toBe(2);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(c);
  });

  it("returns an unchanged shallow copy for a negative idx", () => {
    const list = [frame(v1, 0), frame(v1, 5)];
    const next = removeSuggestionAt(list, -1);
    expect(next).not.toBe(list);
    expect(next).toEqual(list);
    expect(next.length).toBe(2);
  });

  it("returns an unchanged shallow copy for idx >= length", () => {
    const list = [frame(v1, 0), frame(v1, 5)];
    const next = removeSuggestionAt(list, 2);
    expect(next).not.toBe(list);
    expect(next).toEqual(list);
    expect(next.length).toBe(2);
  });

  it("does not mutate the input", () => {
    const list = [frame(v1, 0), frame(v1, 5), frame(v2, 5)];
    removeSuggestionAt(list, 0);
    expect(list.length).toBe(3);
  });
});

describe("labeledSummary", () => {
  it("returns zeros for an empty array", () => {
    expect(labeledSummary([])).toEqual({ labeled: 0, total: 0, pct: 0 });
  });

  it("computes labeled/total/pct for three true out of twenty", () => {
    const flags = Array.from({ length: 20 }, (_, i) => i < 3);
    expect(labeledSummary(flags)).toEqual({ labeled: 3, total: 20, pct: 15 });
  });

  it("returns pct 100 when all flags are true", () => {
    expect(labeledSummary([true, true, true, true])).toEqual({
      labeled: 4,
      total: 4,
      pct: 100,
    });
  });
});

describe("mergeSuggestions", () => {
  it("appends incoming and dedups against existing by (video, frameIdx)", () => {
    const existing = [frame(v1, 0), frame(v1, 5)];
    const incoming = [frame(v1, 5), frame(v1, 9), frame(v2, 0)];
    const out = mergeSuggestions(existing, incoming);
    expect(out.map(key)).toEqual(["a.mp4#0", "a.mp4#5", "a.mp4#9", "b.mp4#0"]);
  });

  it("dedups duplicates within incoming too", () => {
    const out = mergeSuggestions([], [frame(v1, 3), frame(v1, 3), frame(v2, 3)]);
    expect(out.map(key)).toEqual(["a.mp4#3", "b.mp4#3"]);
  });

  it("empty incoming returns a copy of existing (new array ref)", () => {
    const existing = [frame(v1, 1)];
    const out = mergeSuggestions(existing, []);
    expect(out.map(key)).toEqual(["a.mp4#1"]);
    expect(out).not.toBe(existing);
  });

  it("does not mutate its inputs", () => {
    const existing = [frame(v1, 0)];
    const incoming = [frame(v1, 1)];
    mergeSuggestions(existing, incoming);
    expect(existing.length).toBe(1);
    expect(incoming.length).toBe(1);
  });
});

describe("shuffleSuggestions", () => {
  it("returns the same elements (a permutation), length preserved", () => {
    const list = Array.from({ length: 10 }, (_, i) => frame(v1, i));
    const out = shuffleSuggestions(list, mulberry32(42));
    expect(out.length).toBe(10);
    expect(out.map(key).sort()).toEqual(list.map(key).sort());
  });

  it("is deterministic for a given seeded rng", () => {
    const list = Array.from({ length: 8 }, (_, i) => frame(v1, i));
    const a = shuffleSuggestions(list, mulberry32(7)).map(key);
    const b = shuffleSuggestions(list, mulberry32(7)).map(key);
    expect(a).toEqual(b);
  });

  it("actually reorders for a suitable seed (not identity)", () => {
    const list = Array.from({ length: 12 }, (_, i) => frame(v1, i));
    const out = shuffleSuggestions(list, mulberry32(1)).map(key);
    expect(out).not.toEqual(list.map(key));
  });

  it("does not mutate the input list", () => {
    const list = [frame(v1, 0), frame(v1, 1), frame(v1, 2)];
    const before = list.map(key);
    shuffleSuggestions(list, mulberry32(3));
    expect(list.map(key)).toEqual(before);
  });

  it("handles empty and single-element lists", () => {
    expect(shuffleSuggestions([], mulberry32(1))).toEqual([]);
    const one = [frame(v1, 0)];
    expect(shuffleSuggestions(one, mulberry32(1)).map(key)).toEqual(["a.mp4#0"]);
  });
});

describe("removeUnlabeledSuggestions", () => {
  it("keeps only frames the predicate marks labeled", () => {
    const list = [frame(v1, 0), frame(v1, 1), frame(v2, 0)];
    const labeled = new Set(["a.mp4#1", "b.mp4#0"]);
    const out = removeUnlabeledSuggestions(list, (s) => labeled.has(key(s)));
    expect(out.map(key)).toEqual(["a.mp4#1", "b.mp4#0"]);
  });

  it("returns [] when nothing is labeled", () => {
    const list = [frame(v1, 0), frame(v1, 1)];
    expect(removeUnlabeledSuggestions(list, () => false)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const list = [frame(v1, 0), frame(v1, 1)];
    removeUnlabeledSuggestions(list, () => true);
    expect(list.length).toBe(2);
  });
});

describe("userLabeledFramesAsSuggestions", () => {
  const lf = (
    video: Video,
    frameIdx: number,
    isUserLabeled: boolean
  ): { video: Video; frameIdx: number; isUserLabeled: boolean } => ({
    video,
    frameIdx,
    isUserLabeled,
  });

  it("keeps user-labeled frames and maps to { video, frameIdx }", () => {
    const frames = [lf(v1, 0, true), lf(v1, 1, false), lf(v2, 4, true)];
    expect(userLabeledFramesAsSuggestions(frames).map(key)).toEqual([
      "a.mp4#0",
      "b.mp4#4",
    ]);
  });

  it("drops predicted-only / empty frames (isUserLabeled false)", () => {
    const frames = [lf(v1, 0, false), lf(v2, 1, false)];
    expect(userLabeledFramesAsSuggestions(frames)).toEqual([]);
  });
});
