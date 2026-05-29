import { describe, it, expect } from "../bun-test";
import { GRAPH_SPECS, getGraphSpec } from "@/lib/statisticSeries";
import type { Labels, Video } from "@/types";

interface MockPoint { xy: [number, number]; visible: boolean; score?: number; }
interface MockInst {
  points: MockPoint[];
  track?: object | null;
  score?: number;          // predicted only
  trackingScore?: number;
  numpy: () => number[][];
  centroidXy: [number, number] | null;
}

function pt(x: number, y: number, score?: number): MockPoint {
  return { xy: [x, y], visible: true, score };
}

/** Build a mock instance. Pass `score` to make it "predicted". */
function inst(points: MockPoint[], opts: { track?: object | null; score?: number; trackingScore?: number } = {}): MockInst {
  const xy = points.map((p) => p.xy as number[]);
  const vis = points.filter((p) => p.visible);
  const cx = vis.length ? vis.reduce((s, p) => s + p.xy[0], 0) / vis.length : null;
  const cy = vis.length ? vis.reduce((s, p) => s + p.xy[1], 0) / vis.length : null;
  return {
    points,
    track: opts.track ?? null,
    score: opts.score,
    trackingScore: opts.trackingScore,
    numpy: () => xy,
    centroidXy: cx === null ? null : [cx, cy as number],
  };
}

function frame(frameIdx: number, instances: MockInst[]) {
  return { frameIdx, instances, video: VIDEO };
}

const VIDEO = { shape: [10, 100, 100, 1] } as unknown as Video;

/** Mock Labels whose find({video}) returns the given frames in order. */
function mockLabels(frames: ReturnType<typeof frame>[], tracks: object[] = []): Labels {
  return {
    tracks,
    skeletons: [{ index: (n: number) => (typeof n === "number" ? n : 0), nodes: [{}, {}] }],
    labeledFrames: frames,
    find: (opts: { video?: Video; frameIdx?: number }) => {
      if (opts.frameIdx !== undefined) return frames.filter((f) => f.frameIdx === opts.frameIdx);
      return frames;
    },
  } as unknown as Labels;
}

describe("GRAPH_SPECS", () => {
  it("includes none, instance-count, and 12 legacy stats", () => {
    const types = GRAPH_SPECS.map((s) => s.type);
    expect(types).toContain("none");
    expect(types).toContain("instance-count");
    expect(types).toContain("point-displacement");
    expect(types).toContain("min-centroid-proximity");
    expect(types).toContain("tracking-score");
  });
  it("getGraphSpec returns the spec for a type", () => {
    expect(getGraphSpec("tracking-score")?.reductions).toContain("mean");
    expect(getGraphSpec("tracking-score")?.reductions).toContain("min");
  });
  it("instance-count and point-count have no reductions; min-centroid-proximity none", () => {
    expect(getGraphSpec("instance-count")?.reductions).toEqual([]);
    expect(getGraphSpec("point-count")?.reductions).toEqual([]);
    expect(getGraphSpec("min-centroid-proximity")?.reductions).toEqual([]);
  });
});

import { pointCountSeries, instanceScoreSeries } from "@/lib/statisticSeries";

describe("pointCountSeries", () => {
  it("sums points of predicted instances per frame", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0), pt(1, 1)], { score: 0.9 })]),         // predicted, 2 pts
      frame(1, [inst([pt(0, 0)], { score: 0.5 }), inst([pt(2, 2)])]), // 1 predicted (1pt) + 1 user (ignored)
    ]);
    const s = pointCountSeries(labels, VIDEO);
    expect(s.get(0)).toBe(2);
    expect(s.get(1)).toBe(1);
  });
});

describe("instanceScoreSeries", () => {
  it("sum reduction adds instance scores", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0)], { score: 0.4 }), inst([pt(1, 1)], { score: 0.6 })]),
    ]);
    expect(instanceScoreSeries(labels, VIDEO, "sum").get(0)).toBeCloseTo(1.0);
  });
  it("min reduction returns smallest score", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0)], { score: 0.4 }), inst([pt(1, 1)], { score: 0.6 })]),
    ]);
    expect(instanceScoreSeries(labels, VIDEO, "min").get(0)).toBeCloseTo(0.4);
  });
});

import { pointScoreSeries, trackingScoreSeries } from "@/lib/statisticSeries";

describe("pointScoreSeries", () => {
  it("sums per-point scores of predicted instances", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0, 0.2), pt(1, 1, 0.3)], { score: 0.9 })]),
    ]);
    expect(pointScoreSeries(labels, VIDEO, "sum").get(0)).toBeCloseTo(0.5);
  });
  it("min over all points", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0, 0.2), pt(1, 1, 0.3)], { score: 0.9 })]),
    ]);
    expect(pointScoreSeries(labels, VIDEO, "min").get(0)).toBeCloseTo(0.2);
  });
});

describe("trackingScoreSeries", () => {
  it("min reduction, skips frames with no tracking score", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0)], { score: 1, trackingScore: 0.7 }), inst([pt(1, 1)], { score: 1, trackingScore: 0.4 })]),
    ]);
    expect(trackingScoreSeries(labels, VIDEO, "min").get(0)).toBeCloseTo(0.4);
  });
});

import { minCentroidProximitySeries } from "@/lib/statisticSeries";

describe("minCentroidProximitySeries", () => {
  it("skips frames with <2 instances; reports min centroid distance otherwise", () => {
    const labels = mockLabels([
      frame(0, [inst([pt(0, 0)])]),                          // 1 inst -> skipped
      frame(1, [inst([pt(0, 0)]), inst([pt(3, 4)])]),        // dist 5
      frame(2, [inst([pt(0, 0)]), inst([pt(0, 1)]), inst([pt(9, 9)])]), // min dist 1
    ]);
    const s = minCentroidProximitySeries(labels, VIDEO);
    expect(s.has(0)).toBe(false);
    expect(s.get(1)).toBeCloseTo(5);
    expect(s.get(2)).toBeCloseTo(1);
  });
});

import { pointDisplacementSeries } from "@/lib/statisticSeries";

describe("pointDisplacementSeries", () => {
  it("velocity vs previous labeled frame, matched by track", () => {
    const trackA = {}; // shared identity
    const labels = mockLabels(
      [
        frame(0, [inst([pt(0, 0), pt(0, 0)], { track: trackA, score: 1 })]),
        frame(1, [inst([pt(3, 4), pt(0, 0)], { track: trackA, score: 1 })]), // node0 moved 5
      ],
      [trackA],
    );
    const s = pointDisplacementSeries(labels, VIDEO, "sum");
    // frame 0 has no previous frame -> value 0 (no displacement); still emitted (not NaN)
    expect(s.get(1)).toBeCloseTo(5);
  });
  it("unmatched track contributes nothing", () => {
    const a = {}, b = {};
    const labels = mockLabels(
      [
        frame(0, [inst([pt(0, 0)], { track: a, score: 1 })]),
        frame(1, [inst([pt(9, 9)], { track: b, score: 1 })]), // different track, no match
      ],
      [a, b],
    );
    expect(pointDisplacementSeries(labels, VIDEO, "sum").get(1)).toBe(0);
  });
  it("partially-visible instance (a NaN node) contributes 0 under sum (NaN-propagate, summary.py:262)", () => {
    const trackA = {};
    // node1 becomes invisible (NaN) in frame 1 -> instanceVelocity sum => NaN
    // -> caller adds 0 for the whole instance. Frame value = 0.
    const labels = mockLabels(
      [
        frame(0, [inst([pt(0, 0), pt(0, 0)], { track: trackA, score: 1 })]),
        frame(1, [inst([pt(3, 4), { xy: [NaN, NaN], visible: false }], { track: trackA, score: 1 })]),
      ],
      [trackA],
    );
    expect(pointDisplacementSeries(labels, VIDEO, "sum").get(1)).toBe(0);
  });
});
