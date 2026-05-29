import { describe, it, expect } from "../bun-test";
import { runWorkerJob } from "@/lib/statisticSeriesWorkerCore";

describe("runWorkerJob", () => {
  it("computes min-centroid-proximity from extracted frame arrays", () => {
    const res = runWorkerJob({
      graph: "min-centroid-proximity",
      reduction: "sum",
      trackCount: 0,
      primaryNodeIdx: 0,
      frames: [
        {
          frameIdx: 1,
          instances: [
            { trackIdx: -1, points: [[0, 0]] },
            { trackIdx: -1, points: [[3, 4]] },
          ],
        },
      ],
    });
    expect(res.entries).toEqual([[1, 5]]);
  });

  it("min-centroid-proximity uses the MEDIAN centroid (not mean)", () => {
    // For each instance the centroid is the per-axis median of its points.
    // Instance A points -> median (0, 0); instance B points -> median (10, 0).
    // A mean centroid would skew B toward (20/3, 0); the median keeps it at 10.
    const res = runWorkerJob({
      graph: "min-centroid-proximity",
      reduction: "sum",
      trackCount: 0,
      primaryNodeIdx: 0,
      frames: [
        {
          frameIdx: 0,
          instances: [
            { trackIdx: -1, points: [[-1, 0], [0, 0], [1, 0]] },
            { trackIdx: -1, points: [[0, 0], [10, 0], [100, 0]] },
          ],
        },
      ],
    });
    expect(res.entries).toEqual([[0, 10]]);
  });

  it("min-centroid-proximity skips frames with < 2 centroids", () => {
    const res = runWorkerJob({
      graph: "min-centroid-proximity",
      reduction: "sum",
      trackCount: 0,
      primaryNodeIdx: 0,
      frames: [
        { frameIdx: 0, instances: [{ trackIdx: -1, points: [[0, 0]] }] },
        {
          frameIdx: 1,
          instances: [
            { trackIdx: -1, points: [[0, 0]] },
            { trackIdx: -1, points: [[0, 6]] },
          ],
        },
      ],
    });
    expect(res.entries).toEqual([[1, 6]]);
  });

  it("point-displacement matches same-track instances vs the previous frame", () => {
    const res = runWorkerJob({
      graph: "point-displacement",
      reduction: "sum",
      trackCount: 1,
      primaryNodeIdx: 0,
      frames: [
        { frameIdx: 0, instances: [{ trackIdx: 0, points: [[0, 0]] }] },
        { frameIdx: 1, instances: [{ trackIdx: 0, points: [[3, 4]] }] },
        { frameIdx: 2, instances: [{ trackIdx: 0, points: [[3, 4]] }] },
      ],
    });
    // frame 0: no prior -> 0; frame 1: dist 5; frame 2: dist 0.
    expect(res.entries).toEqual([
      [0, 0],
      [1, 5],
      [2, 0],
    ]);
  });

  it("point-displacement NaN-propagates a partially-visible node under sum (contributes 0)", () => {
    const res = runWorkerJob({
      graph: "point-displacement",
      reduction: "sum",
      trackCount: 1,
      primaryNodeIdx: 0,
      frames: [
        {
          frameIdx: 0,
          instances: [{ trackIdx: 0, points: [[0, 0], [0, 0]] }],
        },
        {
          frameIdx: 1,
          // second node is NaN -> instanceVelocity returns NaN under sum,
          // so this instance contributes 0 to the frame total.
          instances: [{ trackIdx: 0, points: [[3, 4], [NaN, NaN]] }],
        },
      ],
    });
    expect(res.entries).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("primary-point-displacement reduces the anchor node across tracks", () => {
    const res = runWorkerJob({
      graph: "primary-point-displacement",
      reduction: "sum",
      trackCount: 1,
      primaryNodeIdx: 0,
      frames: [
        { frameIdx: 0, instances: [{ trackIdx: 0, points: [[0, 0], [9, 9]] }] },
        { frameIdx: 1, instances: [{ trackIdx: 0, points: [[3, 4], [9, 9]] }] },
      ],
    });
    // anchor (node 0) moves (0,0) -> (3,4) = 5; arrival index 1.
    expect(res.entries).toEqual([
      [0, 0],
      [1, 5],
    ]);
  });
});
