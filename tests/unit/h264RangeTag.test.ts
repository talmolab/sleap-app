/**
 * WebKit's WebCodecs encoder writes limited-range H.264 but tags it full range,
 * so clips read back washed out. Fixtures:
 *  - webkit-fullrange-gray50.mp4: five frames of gray 50 from the macOS app;
 *    the full-range tag is in the `colr` box (its SPS has no VUI). FFmpeg /
 *    OpenCV decode it as ~61.
 *  - x264-fullrange-sps.mp4: a full-range x264 clip whose tag is the SPS VUI
 *    `video_full_range_flag` (no `colr` box).
 * `clearFullRangeTag` clears whichever flags are set, in place.
 */
import { describe, it, expect } from "../bun-test";
import fs from "fs";
import path from "path";
import {
  clearFullRangeTag,
  isWebKitEncoder,
  spsFullRangeFlagPosition,
} from "@/lib/h264RangeTag";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../fixtures", name)));
const webkit = fixture("webkit-fullrange-gray50.mp4");
const x264 = fixture("x264-fullrange-sps.mp4");

/** The avcC box's first SPS NAL unit. */
function firstSps(mp4: Uint8Array): Uint8Array {
  const i = Buffer.from(mp4).indexOf("avcC");
  const p = i + 4 + 6;
  const len = (mp4[p] << 8) | mp4[p + 1];
  return mp4.slice(p + 2, p + 2 + len);
}

/** The colr box's full_range_flag, or null with no colr box. */
function colrFullRange(mp4: Uint8Array): boolean | null {
  const i = Buffer.from(mp4).indexOf("colr");
  return i < 0 ? null : (mp4[i + 4 + 4 + 6] & 0x80) !== 0;
}

/** The SPS's video_full_range_flag, or null when it has none. */
function spsFullRange(mp4: Uint8Array): boolean | null {
  const sps = firstSps(mp4);
  const at = spsFullRangeFlagPosition(sps);
  return at ? ((sps[at.byte] >> at.bit) & 1) === 1 : null;
}

const changedBytes = (a: Uint8Array, b: Uint8Array) =>
  [...a].filter((v, i) => v !== b[i]).length;

describe("clearFullRangeTag", () => {
  it("WebKit clip: clears the colr box's flag (its SPS carries none)", () => {
    expect(colrFullRange(webkit)).toBe(true);
    expect(spsFullRange(webkit)).toBeNull();
    const fixed = clearFullRangeTag(webkit)!;
    expect(fixed.length).toBe(webkit.length);
    expect(colrFullRange(fixed)).toBe(false);
    expect(changedBytes(fixed, webkit)).toBe(1);
    expect(colrFullRange(webkit)).toBe(true); // input untouched
  });

  it("x264 clip: clears the SPS VUI video_full_range_flag", () => {
    expect(colrFullRange(x264)).toBeNull();
    expect(spsFullRange(x264)).toBe(true);
    const fixed = clearFullRangeTag(x264)!;
    expect(fixed.length).toBe(x264.length);
    expect(spsFullRange(fixed)).toBe(false);
    expect(changedBytes(fixed, x264)).toBeGreaterThan(0);
  });

  it("leaves an already-limited clip alone", () => {
    expect(clearFullRangeTag(clearFullRangeTag(webkit)!)).toBeNull();
    expect(clearFullRangeTag(clearFullRangeTag(x264)!)).toBeNull();
  });

  it("leaves bytes that aren't an mp4 alone", () => {
    expect(clearFullRangeTag(new Uint8Array(64))).toBeNull();
  });
});

describe("isWebKitEncoder", () => {
  it("is WebKit (macOS app, Safari), not Chromium (Windows WebView2, Chrome)", () => {
    expect(
      isWebKitEncoder("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")
    ).toBe(true);
    expect(
      isWebKitEncoder(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"
      )
    ).toBe(false);
    expect(isWebKitEncoder("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0")).toBe(false);
  });
});
