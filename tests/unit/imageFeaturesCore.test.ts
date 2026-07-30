import { describe, it, expect } from "../bun-test";
import { clampCropRect, capDimensions } from "@/lib/imageFeaturesCore";

describe("clampCropRect", () => {
  it("returns an in-bounds rect unchanged (as integers)", () => {
    expect(clampCropRect({ x: 10, y: 10, width: 50, height: 50 }, 100, 100)).toEqual(
      { x: 10, y: 10, width: 50, height: 50 }
    );
  });

  it("clamps a rect that overflows the right/bottom edge", () => {
    expect(clampCropRect({ x: 80, y: 80, width: 50, height: 50 }, 100, 100)).toEqual(
      { x: 80, y: 80, width: 20, height: 20 }
    );
  });

  it("clamps a negative origin by shrinking to the visible part", () => {
    expect(clampCropRect({ x: -10, y: -10, width: 50, height: 50 }, 100, 100)).toEqual(
      { x: 0, y: 0, width: 40, height: 40 }
    );
  });

  it("rounds fractional inputs to integer pixels", () => {
    expect(
      clampCropRect({ x: 10.4, y: 10.6, width: 50.2, height: 49.9 }, 100, 100)
    ).toEqual({ x: 10, y: 11, width: 50, height: 50 });
  });

  it("returns null for a zero-area rect", () => {
    expect(clampCropRect({ x: 0, y: 0, width: 0, height: 50 }, 100, 100)).toBeNull();
  });

  it("returns null for a rect fully outside the image", () => {
    expect(clampCropRect({ x: 100, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
  });
});

describe("capDimensions", () => {
  it("leaves dimensions unchanged when the long side is already within the cap", () => {
    expect(capDimensions(100, 50, 128)).toEqual({ width: 100, height: 50 });
  });

  it("does not upscale a small image", () => {
    expect(capDimensions(32, 16, 128)).toEqual({ width: 32, height: 16 });
  });

  it("downscales a landscape image so the width hits the cap, preserving aspect", () => {
    expect(capDimensions(256, 128, 128)).toEqual({ width: 128, height: 64 });
  });

  it("downscales a portrait image so the height hits the cap", () => {
    expect(capDimensions(128, 256, 128)).toEqual({ width: 64, height: 128 });
  });

  it("never collapses a dimension below 1 pixel", () => {
    expect(capDimensions(1000, 3, 128)).toEqual({ width: 128, height: 1 });
  });
});
