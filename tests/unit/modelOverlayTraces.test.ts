/**
 * Compare Model Predictions, part 3: per-node traces (x/y over time, one line
 * per model), and the guards that keep uPlot away from non-finite values.
 */
import { describe, it, expect } from "../bun-test";
import {
  buildAnimalIndex,
  buildTraces,
  traceAnimalCount,
  traceRange,
  traceTrackNames,
} from "@/lib/modelOverlay/traces";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import type { OverlayModel } from "@/stores/modelOverlayStore";
import { makeVideo, poseAt } from "./modelOverlayTestData";

function pose(xy: [number, number][], trackName: string | null = null): OverlayPose {
  return { xy: Float64Array.from(xy.flat()), score: 0.9, trackName };
}

function model(id: string, frames: Record<number, OverlayPose[]>): OverlayModel {
  const trackNames = new Set<string>();
  for (const ps of Object.values(frames)) for (const p of ps) if (p.trackName) trackNames.add(p.trackName);
  return {
    id,
    name: id,
    source: id,
    color: MODEL_COLORS[0],
    visible: true,
    video: makeVideo(),
    frames: new Map(Object.entries(frames).map(([f, p]) => [Number(f), p])),
    trackNames,
  };
}

describe("buildTraces", () => {
  // One line per model over the union of frames; a frame a model skipped is a gap (null), not NaN.
  it("lines up models on the union of frames with null gaps", () => {
    const a = model("a", { 0: [pose(poseAt(10, 20))], 2: [pose(poseAt(12, 22))] });
    const b = model("b", { 2: [pose(poseAt(14, 24))], 5: [pose(poseAt(16, 26))] });
    const t = buildTraces([a, b], 1, { kind: "animal", index: 0 });
    expect(t.frames).toEqual([0, 2, 5]);
    expect(t.x).toEqual([
      [10, 12, null],
      [null, 14, 16],
    ]);
    expect(t.y[0]).toEqual([20, 22, null]);
  });

  // A node a model didn't place must never reach uPlot as NaN (#379 froze the app).
  it("turns missing nodes into null", () => {
    const p = poseAt(10, 20);
    p[1] = [NaN, NaN];
    const t = buildTraces([model("a", { 3: [pose(p)] })], 1, { kind: "animal", index: 0 });
    expect(t.x).toEqual([[null]]);
    expect(t.y).toEqual([[null]]);
  });

  // With shared tracks the user picks a track, and each model's line follows that track.
  it("follows a track by name", () => {
    const a = model("a", { 0: [pose(poseAt(100, 0), "t1"), pose(poseAt(300, 0), "t2")] });
    const b = model("b", { 0: [pose(poseAt(305, 0), "t2"), pose(poseAt(98, 0), "t1")] });
    const t = buildTraces([a, b], 1, { kind: "track", name: "t2" });
    expect(t.x).toEqual([[300], [305]]);
  });

  // Without tracks, "animal k" matches the models' poses by position on each frame.
  it("matches animals by position without tracks", () => {
    const a = model("a", { 0: [pose(poseAt(100, 0)), pose(poseAt(300, 0))] });
    const b = model("b", { 0: [pose(poseAt(305, 0)), pose(poseAt(98, 0))] });
    expect(buildTraces([a, b], 1, { kind: "animal", index: 1 }).x).toEqual([[300], [305]]);
  });
});

describe("buildAnimalIndex", () => {
  // Review: untracked lines hopped between animals when a model listed them in another order.
  it("keeps an animal's number when the models list animals in a different order", () => {
    const a = model("a", {
      0: [pose(poseAt(100, 100)), pose(poseAt(300, 300))],
      1: [pose(poseAt(305, 302)), pose(poseAt(104, 101))],
    });
    const b = model("b", {
      0: [pose(poseAt(299, 301)), pose(poseAt(101, 99))],
      1: [pose(poseAt(103, 102)), pose(poseAt(306, 300))],
    });
    const index = buildAnimalIndex([a, b]);
    expect(index.count).toBe(2);
    const t = buildTraces([a, b], 1, { kind: "animal", index: 0 }, index);
    // Animal 0 is the one near (100, 100) on both frames, for both models.
    expect(t.x).toEqual([
      [100, 104],
      [101, 103],
    ]);
  });

  // An animal far from every known one (e.g. walks in) gets a new number instead of stealing one.
  it("starts a new animal beyond the link distance", () => {
    const a = model("a", { 0: [pose(poseAt(100, 100))], 1: [pose(poseAt(600, 600))] });
    expect(buildAnimalIndex([a]).count).toBe(2);
  });
});

describe("trace choices and ranges", () => {
  // The animal picker offers the animals found; track names sort naturally.
  it("counts animals and lists track names", () => {
    const a = model("a", { 0: [pose(poseAt(0, 0), "t10"), pose(poseAt(300, 300), "t2")], 1: [pose(poseAt(0, 0), "t2")] });
    expect(traceAnimalCount(buildAnimalIndex([a]))).toBe(2);
    expect(traceTrackNames([a], true)).toEqual(["t2", "t10"]);
    expect(traceTrackNames([a], false)).toEqual([]);
  });

  // The y range is always finite and non-empty, even with no data or one flat value.
  it("always gives uPlot a finite range", () => {
    expect(traceRange([])).toEqual([0, 1]);
    expect(traceRange([[null, null]])).toEqual([0, 1]);
    expect(traceRange([[5, 5]])).toEqual([4, 6]);
    const [lo, hi] = traceRange([[0, null, 100]]);
    expect(lo).toBeCloseTo(-5);
    expect(hi).toBeCloseTo(105);
  });
});
