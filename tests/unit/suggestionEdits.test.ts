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
} from "@/lib/suggestionEdits";
import type { SuggestionFrame, Video } from "@/types";

// Lightweight distinct Video stubs; only reference identity matters here.
const v1 = { filename: "a.mp4" } as unknown as Video;
const v2 = { filename: "b.mp4" } as unknown as Video;

function frame(video: Video, frameIdx: number): SuggestionFrame {
  return { video, frameIdx } as SuggestionFrame;
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
