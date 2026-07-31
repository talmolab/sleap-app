/**
 * Tests for the read-ahead prefetch policy (src/lib/videoPrefetch.ts).
 *
 * The frame-load effect in VideoPlayer feeds this the previous and next frame
 * indices plus the scrub state; it decides whether the backend should warm its
 * read-ahead window. The regression it guards: a large discrete jump (Next/Prev
 * Suggestion, Next/Prev Labeled Frame, Go-to-frame) must NOT fire the wasted
 * 8-ahead/2-behind reads that saturate a slow mount, while sequential stepping
 * and playback keep prefetch ON.
 */

import { describe, it, expect } from "../bun-test";
import {
  shouldPrefetch,
  PREFETCH_JUMP_THRESHOLD,
} from "@/lib/videoPrefetch";

describe("shouldPrefetch", () => {
  it("prefetches a single sequential step forward", () => {
    expect(
      shouldPrefetch({ prev: 10, next: 11, isScrubbing: false })
    ).toBe(true);
  });

  it("prefetches a single sequential step backward", () => {
    expect(
      shouldPrefetch({ prev: 10, next: 9, isScrubbing: false })
    ).toBe(true);
  });

  it("prefetches staying on the same frame", () => {
    expect(
      shouldPrefetch({ prev: 10, next: 10, isScrubbing: false })
    ).toBe(true);
  });

  it("does not prefetch a large forward jump (e.g. Next Suggestion)", () => {
    expect(
      shouldPrefetch({ prev: 10, next: 5000, isScrubbing: false })
    ).toBe(false);
  });

  it("does not prefetch a large backward jump (e.g. Prev Labeled Frame)", () => {
    expect(
      shouldPrefetch({ prev: 5000, next: 10, isScrubbing: false })
    ).toBe(false);
  });

  it("does not prefetch while scrubbing, even for a 1-frame move", () => {
    expect(
      shouldPrefetch({ prev: 10, next: 11, isScrubbing: true })
    ).toBe(false);
  });

  it("does not prefetch while scrubbing on a big move", () => {
    expect(
      shouldPrefetch({ prev: 10, next: 5000, isScrubbing: true })
    ).toBe(false);
  });

  it("prefetches on first load (prev === null) when not scrubbing", () => {
    expect(
      shouldPrefetch({ prev: null, next: 42, isScrubbing: false })
    ).toBe(true);
  });

  it("does not prefetch on first load while scrubbing", () => {
    expect(
      shouldPrefetch({ prev: null, next: 42, isScrubbing: true })
    ).toBe(false);
  });

  it("prefetches exactly at the threshold distance", () => {
    expect(
      shouldPrefetch({
        prev: 10,
        next: 10 + PREFETCH_JUMP_THRESHOLD,
        isScrubbing: false,
      })
    ).toBe(true);
  });

  it("does not prefetch just past the threshold distance", () => {
    expect(
      shouldPrefetch({
        prev: 10,
        next: 10 + PREFETCH_JUMP_THRESHOLD + 1,
        isScrubbing: false,
      })
    ).toBe(false);
  });

  it("honors a custom threshold", () => {
    // With a wide threshold, a 100-frame jump is treated as sequential.
    expect(
      shouldPrefetch({ prev: 0, next: 100, isScrubbing: false, threshold: 200 })
    ).toBe(true);
    // With threshold 0, only staying put prefetches.
    expect(
      shouldPrefetch({ prev: 10, next: 11, isScrubbing: false, threshold: 0 })
    ).toBe(false);
    expect(
      shouldPrefetch({ prev: 10, next: 10, isScrubbing: false, threshold: 0 })
    ).toBe(true);
  });

  it("defaults the threshold to a small value (a few frames)", () => {
    expect(PREFETCH_JUMP_THRESHOLD).toBeGreaterThanOrEqual(1);
    expect(PREFETCH_JUMP_THRESHOLD).toBeLessThanOrEqual(8);
  });
});
