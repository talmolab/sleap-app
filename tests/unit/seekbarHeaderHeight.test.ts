import { describe, it, expect } from "bun:test";
import {
  clampHeaderHeight,
  resizeHeaderHeight,
  SEEKBAR_HEADER_DEFAULT_HEIGHT,
  SEEKBAR_HEADER_MIN_HEIGHT,
  SEEKBAR_HEADER_MAX_HEIGHT,
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
