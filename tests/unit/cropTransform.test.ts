/**
 * Tests for virtual-crop coordinate transforms (cropped pkg.slp / SLP 2.3).
 *
 * A cropped video displays a window of the source frame; sleap-io.js serves the
 * cropped image in crop-local pixel space, but instance points are stored in
 * SOURCE coords. These helpers bridge the two, keyed on the video's single crop
 * rect (per-video). For an uncropped video (cropRect === null) they are the
 * identity, so normal videos are unaffected.
 */
import { describe, it, expect } from "../bun-test";
import { cropOrigin, toImageCoords, toSourceCoords } from "@/lib/cropTransform";
import type { Video } from "@/types";

/** A video whose only relevant property is its crop rect. */
function vid(cropRect: [number, number, number, number] | null): Video {
  return { cropRect } as unknown as Video;
}

const CROP = vid([64, 96, 320, 288]); // origin (64, 96)
const UNCROPPED = vid(null);

describe("cropOrigin", () => {
  it("returns the [x1, y1] origin for a cropped video", () => {
    expect(cropOrigin(CROP)).toEqual([64, 96]);
  });
  it("returns null for an uncropped video", () => {
    expect(cropOrigin(UNCROPPED)).toBeNull();
  });
  it("returns null for a null video", () => {
    expect(cropOrigin(null)).toBeNull();
  });
});

describe("toImageCoords (source -> crop-local, for display)", () => {
  it("subtracts the crop origin when cropped", () => {
    expect(toImageCoords(CROP, 152, 158)).toEqual([88, 62]);
  });
  it("is the identity when uncropped", () => {
    expect(toImageCoords(UNCROPPED, 152, 158)).toEqual([152, 158]);
    expect(toImageCoords(null, 5, 6)).toEqual([5, 6]);
  });
  it("preserves NaN (unplaced nodes)", () => {
    const [x, y] = toImageCoords(CROP, NaN, NaN);
    expect(Number.isNaN(x)).toBe(true);
    expect(Number.isNaN(y)).toBe(true);
  });
});

describe("toSourceCoords (crop-local -> source, for edits)", () => {
  it("adds the crop origin when cropped", () => {
    expect(toSourceCoords(CROP, 88, 62)).toEqual([152, 158]);
  });
  it("is the identity when uncropped", () => {
    expect(toSourceCoords(UNCROPPED, 88, 62)).toEqual([88, 62]);
  });
});

describe("round-trip", () => {
  it("toSourceCoords(toImageCoords(p)) === p when cropped", () => {
    const [ix, iy] = toImageCoords(CROP, 200, 150);
    expect(toSourceCoords(CROP, ix, iy)).toEqual([200, 150]);
  });
});
