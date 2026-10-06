import { describe, it, expect } from "bun:test";
import {
  clampHeaderHeight,
  resizeHeaderHeight,
  SEEKBAR_HEADER_DEFAULT_HEIGHT,
  SEEKBAR_HEADER_MIN_HEIGHT,
  SEEKBAR_HEADER_MAX_HEIGHT,
  autoTracksHeight,
  effectiveTracksHeight,
  resizeTracksHeight,
  tracksLaneMetrics,
  TRACKS_LANE_PX,
  TRACKS_MIN_LANE_PX,
  TRACKS_TOP_PAD_PX,
  TRACKS_MIN_HEIGHT,
  TRACKS_AUTO_MAX_HEIGHT,
  TRACKS_MAX_HEIGHT,
} from "@/lib/seekbarHeaderHeight";

describe("clampHeaderHeight", () => {
  it("returns values inside the range unchanged (rounded to whole px)", () => {
    expect(clampHeaderHeight(40)).toBe(40);
    expect(clampHeaderHeight(40.4)).toBe(40);
    expect(clampHeaderHeight(40.6)).toBe(41);
  });

  it("clamps below the minimum up to min", () => {
    expect(clampHeaderHeight(SEEKBAR_HEADER_MIN_HEIGHT - 100)).toBe(
      SEEKBAR_HEADER_MIN_HEIGHT
    );
    expect(clampHeaderHeight(-5)).toBe(SEEKBAR_HEADER_MIN_HEIGHT);
  });

  it("clamps above the maximum down to max", () => {
    expect(clampHeaderHeight(SEEKBAR_HEADER_MAX_HEIGHT + 1000)).toBe(
      SEEKBAR_HEADER_MAX_HEIGHT
    );
  });

  it("honors custom min/max bounds", () => {
    expect(clampHeaderHeight(5, { min: 10, max: 20 })).toBe(10);
    expect(clampHeaderHeight(25, { min: 10, max: 20 })).toBe(20);
    expect(clampHeaderHeight(15, { min: 10, max: 20 })).toBe(15);
  });

  it("falls back to min for non-finite input", () => {
    expect(clampHeaderHeight(Number.NaN)).toBe(SEEKBAR_HEADER_MIN_HEIGHT);
    expect(clampHeaderHeight(Number.POSITIVE_INFINITY)).toBe(
      SEEKBAR_HEADER_MAX_HEIGHT
    );
    expect(clampHeaderHeight(Number.NEGATIVE_INFINITY)).toBe(
      SEEKBAR_HEADER_MIN_HEIGHT
    );
  });
});

describe("resizeHeaderHeight (px -> height mapping for a top-edge drag)", () => {
  it("dragging UP (cursor Y decreases) makes the header taller", () => {
    // start 40px tall, pointer moved up 30px => 70px
    expect(resizeHeaderHeight(40, 200, 170)).toBe(70);
  });

  it("dragging DOWN (cursor Y increases) makes the header shorter", () => {
    // start 80px tall, pointer moved down 30px => 50px
    expect(resizeHeaderHeight(80, 200, 230)).toBe(50);
  });

  it("no movement leaves the height unchanged", () => {
    expect(resizeHeaderHeight(SEEKBAR_HEADER_DEFAULT_HEIGHT, 100, 100)).toBe(
      SEEKBAR_HEADER_DEFAULT_HEIGHT
    );
  });

  it("clamps the result to the allowed range", () => {
    // dragging far down from the default can't go below the minimum
    expect(resizeHeaderHeight(SEEKBAR_HEADER_DEFAULT_HEIGHT, 100, 500)).toBe(
      SEEKBAR_HEADER_MIN_HEIGHT
    );
    // dragging far up can't exceed the maximum
    expect(resizeHeaderHeight(SEEKBAR_HEADER_DEFAULT_HEIGHT, 500, 0)).toBe(
      SEEKBAR_HEADER_MAX_HEIGHT
    );
  });
});

describe("seekbar header height constants", () => {
  it("has a sane ordering: min <= default <= max", () => {
    expect(SEEKBAR_HEADER_MIN_HEIGHT).toBeLessThanOrEqual(
      SEEKBAR_HEADER_DEFAULT_HEIGHT
    );
    expect(SEEKBAR_HEADER_DEFAULT_HEIGHT).toBeLessThanOrEqual(
      SEEKBAR_HEADER_MAX_HEIGHT
    );
  });
});

describe("autoTracksHeight (band auto-sizes to track count)", () => {
  it("scales with track count at TRACKS_LANE_PX per lane", () => {
    // 10 tracks × slot px, within [MIN, AUTO_MAX] (uncapped)
    expect(autoTracksHeight(10)).toBe(10 * TRACKS_LANE_PX);
  });
  it("never drops below the floor for few/zero tracks", () => {
    expect(autoTracksHeight(0)).toBe(TRACKS_MIN_HEIGHT);
    expect(autoTracksHeight(1)).toBe(TRACKS_MIN_HEIGHT); // 1*3 < min → min
  });
  it("caps the AUTO height so a huge track count doesn't explode the band", () => {
    expect(autoTracksHeight(1000)).toBe(TRACKS_AUTO_MAX_HEIGHT);
  });
});

describe("effectiveTracksHeight (auto vs. manual override)", () => {
  it("uses the auto height when stored is 0 (never resized / reset)", () => {
    expect(effectiveTracksHeight(0, 29)).toBe(autoTracksHeight(29));
  });
  it("uses the stored height when the user has dragged it (> 0)", () => {
    expect(effectiveTracksHeight(150, 29)).toBe(150);
  });
  it("clamps a stored override to the drag range", () => {
    expect(effectiveTracksHeight(9999, 5)).toBe(TRACKS_MAX_HEIGHT);
    expect(effectiveTracksHeight(1, 5)).toBe(TRACKS_MIN_HEIGHT);
  });
});

describe("resizeTracksHeight (top-edge drag, tracks band range)", () => {
  it("dragging up grows, down shrinks, clamped to the band range", () => {
    expect(resizeTracksHeight(40, 200, 170)).toBe(70); // up 30
    expect(resizeTracksHeight(80, 200, 230)).toBe(50); // down 30
    expect(resizeTracksHeight(40, 100, 900)).toBe(TRACKS_MIN_HEIGHT); // far down
    expect(resizeTracksHeight(40, 900, 0)).toBe(TRACKS_MAX_HEIGHT); // far up
  });
});

describe("tracksLaneMetrics (lanes grow to fill, then scroll)", () => {
  it("few tracks / tall band: lanes fill the band (minus top pad), no scroll", () => {
    // 4 tracks in a 120px band: (120-4 pad)/4 = 29px lanes; canvas = pad + lanes
    // = 4 + 116 = 120 == band (fits, no scroll)
    const m = tracksLaneMetrics(120, 4);
    expect(m.laneHeight).toBe((120 - TRACKS_TOP_PAD_PX) / 4);
    expect(m.canvasHeight).toBe(120);
  });

  it("lanes GROW as the band gets taller (fill regime)", () => {
    const small = tracksLaneMetrics(60, 5).laneHeight; // 12
    const large = tracksLaneMetrics(200, 5).laneHeight; // 40
    expect(large).toBeGreaterThan(small);
  });

  it("many tracks: lanes bottom out at the minimum and the canvas overflows (scroll)", () => {
    // 40 tracks in a 120px band → 120/40=3 < MIN(5) → clamp to MIN; canvas
    // 40*5=200 > 120 band → scroll.
    const m = tracksLaneMetrics(120, 40);
    expect(m.laneHeight).toBe(TRACKS_MIN_LANE_PX);
    expect(m.canvasHeight).toBe(TRACKS_TOP_PAD_PX + 40 * TRACKS_MIN_LANE_PX);
    expect(m.canvasHeight).toBeGreaterThan(120);
  });

  it("tolerates zero tracks without dividing by zero", () => {
    const m = tracksLaneMetrics(120, 0);
    expect(m.laneHeight).toBe(120 - TRACKS_TOP_PAD_PX); // max(MIN, usable/1)
    expect(m.canvasHeight).toBe(0); // 0 lanes → nothing to draw
  });
});
