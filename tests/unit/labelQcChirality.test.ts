import { describe, it, expect } from "../bun-test";
import {
  principalDirection,
  signedSideLocal,
  inferSymmetryPairsByName,
  buildChiralityModel,
  chiralityWrongFraction,
} from "@/lib/analyze/labelQcChirality";

describe("principalDirection", () => {
  it("finds the x-axis for points spread along x", () => {
    const pd = principalDirection([[0, 0], [1, 0], [2, 0]]);
    expect(Math.abs(pd!.axis[0])).toBeCloseTo(1, 6);
    expect(Math.abs(pd!.axis[1])).toBeCloseTo(0, 6);
  });
  it("finds the y-axis for points spread along y", () => {
    const pd = principalDirection([[0, 0], [0, 1], [0, 2]]);
    expect(Math.abs(pd!.axis[0])).toBeCloseTo(0, 6);
    expect(Math.abs(pd!.axis[1])).toBeCloseTo(1, 6);
  });
  it("returns null for coincident points", () => {
    expect(principalDirection([[1, 1], [1, 1]])).toBeNull();
  });
});

describe("signedSideLocal", () => {
  const midline = [[0, 0], [2, 0]]; // tangent (1,0)
  it("is +1 for a left point above the tangent, -1 below", () => {
    expect(signedSideLocal([1, 1], [1, -1], midline)).toBe(1);
    expect(signedSideLocal([1, -1], [1, 1], midline)).toBe(-1);
  });
});

describe("inferSymmetryPairsByName", () => {
  it("pairs L/R suffix names", () => {
    expect(inferSymmetryPairsByName(["Ear_L", "Ear_R", "nose"])).toEqual([[0, 1]]);
  });
  it("pairs left/right prefix names", () => {
    expect(inferSymmetryPairsByName(["left_eye", "right_eye", "tail"])).toEqual([[0, 1]]);
  });
  it("returns [] when there are no L/R tokens", () => {
    expect(inferSymmetryPairsByName(["nose", "tail", "spine"])).toEqual([]);
  });
});

// Skeleton: nose(0), tail(1) [midline]; earL(2)/earR(3), shoulderL(4)/shoulderR(5).
const pairs: [number, number][] = [[2, 3], [4, 5]];
const correct = [[0, 0], [2, 0], [1, 1], [1, -1], [1.5, 1], [1.5, -1]];
const flipped = [[0, 0], [2, 0], [1, -1], [1, 1], [1.5, -1], [1.5, 1]];

describe("chirality fit + score", () => {
  it("scores a correctly-labeled instance ~0 and a mirror-flipped one ~1", () => {
    const model = buildChiralityModel([correct, correct, correct], pairs, 6);
    expect(chiralityWrongFraction(correct, model).wrongFraction).toBe(0);
    expect(chiralityWrongFraction(flipped, model).wrongFraction).toBe(1);
  });
  it("returns 0 when fewer than min pairs are scorable", () => {
    const model = buildChiralityModel([correct], [[2, 3]], 6); // only 1 pair
    expect(chiralityWrongFraction(flipped, model).wrongFraction).toBe(0);
  });
});
