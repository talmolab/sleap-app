import { describe, it, expect } from "../bun-test";
import { rotatedSize } from "@/lib/analyze/instanceSizeCore";

describe("rotatedSize", () => {
  it("returns the raw size (max of w,h) when angle is 0", () => {
    expect(rotatedSize(90, 60, 0)).toBe(90);
    expect(rotatedSize(40, 40, 0)).toBe(40);
  });

  it("grows a square by sqrt(2) at 45 degrees", () => {
    // 40x40 rotated 45deg -> bbox 40*(cos45+sin45) = 40*sqrt(2)
    expect(rotatedSize(40, 40, 45)).toBeCloseTo(56.5685, 3);
  });

  it("matches the +/-45 worst case for a 90x60 box", () => {
    // (90+60)/sqrt(2) = 106.066
    expect(rotatedSize(90, 60, 45)).toBeCloseTo(106.066, 2);
  });

  it("for +/-180 clamps to 90deg symmetry and checks 45 as worst case", () => {
    // angles checked: {0, 90, 45}; 0->90, 90->90, 45->106.066
    expect(rotatedSize(90, 60, 180)).toBeCloseTo(106.066, 2);
  });

  it("keeps the un-rotated size for very elongated shapes at small angles", () => {
    // 100x10 at +/-15: worst case stays at 0deg (100), not the boundary
    expect(rotatedSize(100, 10, 15)).toBeCloseTo(100, 5);
  });

  it("is symmetric in the sign of the angle", () => {
    expect(rotatedSize(90, 60, -45)).toBeCloseTo(rotatedSize(90, 60, 45), 6);
  });
});
