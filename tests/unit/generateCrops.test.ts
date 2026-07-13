/**
 * Tests for the crop-center / crop-rect math (issue #212, Phase 1).
 *
 * Covers the correctness-critical pure helpers that must match sleap-nn's
 * cropping (anchor node → else bbox midpoint). The full generateCrops() flow
 * builds virtual crop Videos and is exercised in-app.
 */

import { describe, it, expect } from "../bun-test";
import { Skeleton, Instance } from "@talmolab/sleap-io.js";
import { instanceCropCenter, cropRectForCenter } from "@/lib/activeLearning/generateCrops";

function makeInstance(
  skeleton: Skeleton,
  points: Record<string, [number, number]>,
): Instance {
  const inst = Instance.empty({ skeleton });
  for (const [name, xy] of Object.entries(points)) {
    const i = skeleton.nodes.findIndex((n) => n.name === name);
    inst.points[i].xy = xy;
    inst.points[i].visible = true;
    inst.points[i].complete = true;
  }
  return inst;
}

describe("crop center", () => {
  const skeleton = new Skeleton({
    nodes: ["body_center", "head", "tail"],
    name: "test",
  });

  it("uses the anchor node when it is placed", () => {
    const inst = makeInstance(skeleton, {
      body_center: [100, 200],
      head: [50, 50],
      tail: [400, 400],
    });
    expect(instanceCropCenter(inst, skeleton, "body_center")).toEqual([100, 200]);
  });

  it("falls back to the bbox midpoint when the anchor is not placed", () => {
    const inst = makeInstance(skeleton, { head: [10, 20], tail: [30, 60] });
    // anchor "body_center" is unplaced → midpoint of {(10,20),(30,60)} = (20,40)
    expect(instanceCropCenter(inst, skeleton, "body_center")).toEqual([20, 40]);
  });

  it("uses the bbox midpoint when no anchor is given", () => {
    const inst = makeInstance(skeleton, {
      head: [0, 0],
      body_center: [100, 0],
      tail: [50, 80],
    });
    expect(instanceCropCenter(inst, skeleton)).toEqual([50, 40]);
  });

  it("returns null for an instance with no visible points", () => {
    const inst = Instance.empty({ skeleton });
    expect(instanceCropCenter(inst, skeleton, "body_center")).toBeNull();
  });

  it("ignores an anchor node that is present but not visible", () => {
    const inst = makeInstance(skeleton, { head: [10, 10], tail: [30, 30] });
    // Explicitly mark the anchor invisible at a real coordinate.
    const ai = skeleton.nodes.findIndex((n) => n.name === "body_center");
    inst.points[ai].xy = [999, 999];
    inst.points[ai].visible = false;
    expect(instanceCropCenter(inst, skeleton, "body_center")).toEqual([20, 20]);
  });
});

describe("crop rect", () => {
  it("builds a square rect centered on the point (x2/y2 exclusive)", () => {
    expect(cropRectForCenter([100, 100], 256)).toEqual([-28, -28, 228, 228]);
  });

  it("rounds the origin to integer pixels", () => {
    expect(cropRectForCenter([10.4, 20.6], 4)).toEqual([8, 19, 12, 23]);
  });
});
