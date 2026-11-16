// Why: Claude gives positions in the picture it was shown; a wrong conversion would move nodes to the wrong place.
import { describe, it, expect } from "../../bun-test";
import { planCrop, renderToFrame, frameToRender, instanceBBox } from "@/automation/coords";

describe("render ↔ frame coordinates", () => {
  // Why: the basic inverse — picture pixels back to frame pixels.
  it("maps render pixels back to frame pixels", () => {
    const t = { originX: 512, originY: 384, scale: 4, offsetX: 0, offsetY: 0 };
    expect(renderToFrame(t, 612, 408)).toEqual([665, 486]);
    expect(frameToRender(t, 665, 486)).toEqual([612, 408]);
  });

  // Why: cropped videos (pkg.slp) store points in source coordinates, not crop-local ones.
  it("adds the video's crop offset so results are in source coordinates", () => {
    const t = { originX: 10, originY: 20, scale: 2, offsetX: 300, offsetY: 100 };
    expect(renderToFrame(t, 40, 40)).toEqual([330, 140]);
    expect(frameToRender(t, 330, 140)).toEqual([40, 40]);
  });
});

describe("planCrop", () => {
  // Why: a crop near the frame edge must not reach outside the image.
  it("stays inside the frame and fits the size budget", () => {
    const c = planCrop({ bbox: [1200, 950, 1270, 1010], frameW: 1280, frameH: 1024, maxEdge: 1092, pad: 0.5 });
    expect(c.originX).toBeGreaterThanOrEqual(0);
    expect(c.originY).toBeGreaterThanOrEqual(0);
    expect(c.originX + c.width).toBeLessThanOrEqual(1280);
    expect(c.originY + c.height).toBeLessThanOrEqual(1024);
    expect(Math.max(c.width, c.height) * c.scale).toBeLessThanOrEqual(1092);
    // The instance is in the crop.
    expect(c.originX).toBeLessThanOrEqual(1200);
    expect(c.originY + c.height).toBeGreaterThanOrEqual(1010);
  });

  // Why: a small animal should be enlarged so Claude can see where nodes are.
  it("enlarges small crops, at most 4×", () => {
    const c = planCrop({ bbox: [100, 100, 140, 120], frameW: 640, frameH: 480, maxEdge: 1092, pad: 0.5 });
    expect(c.scale).toBe(4);
  });

  // Why: a crop bigger than the size budget must be shrunk, not overflow it.
  it("shrinks crops larger than the budget", () => {
    const c = planCrop({ bbox: [0, 0, 1900, 1000], frameW: 2000, frameH: 2000, maxEdge: 1000, pad: 0.1 });
    expect(c.scale).toBeLessThan(1);
    expect(Math.max(c.width, c.height) * c.scale).toBeLessThanOrEqual(1000.0001);
  });

  // Why: an instance with no placed nodes still needs a picture (the whole frame).
  it("falls back to the whole frame without a bbox", () => {
    const c = planCrop({ bbox: null, frameW: 640, frameH: 480, maxEdge: 1092, pad: 0.5 });
    expect([c.originX, c.originY, c.width, c.height]).toEqual([0, 0, 640, 480]);
  });
});

describe("instanceBBox", () => {
  // Why: only placed, visible nodes decide where the crop goes.
  it("ignores unplaced nodes", () => {
    const pts = [
      { xy: [10, 20] as [number, number], visible: true },
      { xy: [NaN, NaN] as [number, number], visible: false },
      { xy: [30, 5] as [number, number], visible: true },
    ];
    expect(instanceBBox(pts)).toEqual([10, 5, 30, 20]);
    expect(instanceBBox([{ xy: [NaN, NaN], visible: false }])).toBeNull();
  });
});
