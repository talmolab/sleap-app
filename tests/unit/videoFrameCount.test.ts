/**
 * Tests for displayFrameCount — the number shown in the Videos panel "Frames"
 * column / detail.
 *
 * For an embedded pkg.slp video the meaningful count is the number of stored
 * (embedded) images — Video.embeddedFrameIndices.length — NOT the source
 * extent (shape[0]), which is the seekbar range. This matches PyQt SLEAP, whose
 * Frames column shows the embedded image count. Regular videos have no embedded
 * set, so they fall back to the source frame count.
 */

import { describe, it, expect } from "../bun-test";
import { displayFrameCount } from "@/lib/videoFrameCount";
import type { Video } from "@/types";

/** Minimal stand-in exposing just the two getters the helper reads. */
function fakeVideo(
  embeddedFrameIndices: number[] | null,
  shape: [number, number, number, number] | null,
): Video {
  return { embeddedFrameIndices, shape } as unknown as Video;
}

describe("displayFrameCount", () => {
  it("returns the embedded image count for an embedded (pkg.slp) video", () => {
    // 58 stored images of a source video with extent 12168.
    const v = fakeVideo([214, 705, 12167], [12168, 1024, 1280, 1]);
    expect(displayFrameCount(v)).toBe(3);
  });

  it("falls back to the source frame count for a regular video (no embedded set)", () => {
    expect(displayFrameCount(fakeVideo(null, [1800, 720, 1280, 3]))).toBe(1800);
  });

  it("falls back to the source frame count when the embedded set is empty", () => {
    expect(displayFrameCount(fakeVideo([], [500, 480, 640, 1]))).toBe(500);
  });

  it("returns null when neither an embedded set nor a shape is available", () => {
    expect(displayFrameCount(fakeVideo(null, null))).toBeNull();
    expect(displayFrameCount(null)).toBeNull();
  });
});
