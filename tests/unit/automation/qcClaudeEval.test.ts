// Why: the accuracy numbers in the PR come from this script; its planting and scoring must be right.
import { describe, it, expect } from "../../bun-test";
import {
  plantErrors,
  plantPredictionErrors,
  scoreCorrections,
  scoreProposals,
  type Planted,
  type PlantedPrediction,
  type ProposalOut,
} from "../../../scripts/qc-claude-eval";

const pose = (dx: number) => ({
  points: [
    { xy: [10 + dx, 10] as [number, number], visible: true },
    { xy: [20 + dx, 20] as [number, number], visible: true },
    { xy: [NaN, NaN] as [number, number], visible: false },
  ],
});
const frames = () => [0, 1, 2, 3, 4].map((f) => ({ videoIdx: 0, frameIdx: f, userInstances: [pose(0), pose(100)] }));

describe("plantErrors", () => {
  // Why: a repeatable plant (same seed, same errors) lets runs be compared.
  it("moves one visible node on N distinct instances, repeatably", () => {
    const a = plantErrors(frames(), ["a", "b", "c"], { n: 4, seed: 1, min: 10, max: 40 });
    const b = plantErrors(frames(), ["a", "b", "c"], { n: 4, seed: 1, min: 10, max: 40 });
    expect(a).toEqual(b);
    expect(new Set(a.map((p) => `${p.frameIdx}:${p.instIdx}`)).size).toBe(4);
    for (const p of a) {
      expect(p.node).not.toBe(2); // never the hidden node
      expect(p.distance).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.distance).toBeLessThanOrEqual(40 + 1e-9);
    }
  });

  // Why: a node moved off the picture can't be judged; planting stays inside the frame.
  it("keeps moved nodes inside the frame", () => {
    const planted = plantErrors(frames(), ["a", "b", "c"], { n: 10, seed: 3, min: 30, max: 40, bounds: [25, 25] });
    for (const p of planted) {
      expect(p.moved[0]).toBeGreaterThanOrEqual(0);
      expect(p.moved[0]).toBeLessThanOrEqual(24);
    }
  });
});

describe("scoreProposals", () => {
  const planted: Planted[] = [
    { videoIdx: 0, frameIdx: 1, instIdx: 0, node: 0, nodeName: "a", original: [10, 10], moved: [30, 10], distance: 20 },
    { videoIdx: 0, frameIdx: 2, instIdx: 1, node: 1, nodeName: "b", original: [0, 0], moved: [0, 30], distance: 30 },
    { videoIdx: 0, frameIdx: 3, instIdx: 0, node: 0, nodeName: "a", original: [0, 0], moved: [0, 30], distance: 30 },
  ];
  const fix = (frame: number, instance: number, after: ProposalOut["after"]): ProposalOut => ({
    proposal_id: `p${frame}${instance}`,
    kind: "fix",
    status: "pending",
    video: 0,
    frame,
    instance,
    after,
  });
  const ignore = (frame: number, instance: number): ProposalOut => ({ ...fix(frame, instance, {}), kind: "ignore" });

  // Why: each number in the report must count what its name says.
  it("counts found errors, pixel error, misses and false alarms", () => {
    const s = scoreProposals(
      planted,
      [fix(1, 0, { a: [13, 14] }), fix(2, 1, { b: [0, 8] }), ignore(3, 0), ignore(4, 0), fix(4, 1, { a: [1, 1] })],
      [
        { video: 0, frame: 1, instance: 0 },
        { video: 0, frame: 3, instance: 0 },
      ],
    );
    expect(s.planted).toBe(3);
    expect(s.flaggedByQc).toBe(2);
    expect(s.flaggedNoProposal).toBe(0);
    expect(s.wrongNodeFixes).toBe(0);
    expect(s.rightNodePct).toBe(100);
    expect(s.found).toBe(2);
    expect(s.medianErrorPx).toBe(6.5); // errors 5 and 8
    expect(s.within5PxPct).toBe(50);
    expect(s.within10PxPct).toBe(100);
    expect(s.improvedPct).toBe(100);
    expect(s.ignoredPlanted).toBe(1);
    expect(s.otherIgnored).toBe(1);
    expect(s.otherFixed).toBe(1);
    expect(s.falseAlarmsIgnoredPct).toBe(50);
  });

  // Why: a fix that moves a different node is a wrong fix, and must be counted as one, not dropped.
  it("counts a fix on the wrong node as wrong", () => {
    const s = scoreProposals(planted, [fix(1, 0, { b: [10, 10] }), fix(2, 1, { b: [0, 1], a: [3, 3] })]);
    expect(s.found).toBe(1);
    expect(s.wrongNodeFixes).toBe(1);
    expect(s.fixesOnPlanted).toBe(2);
    expect(s.rightNodePct).toBe(50);
    expect(s.fixesWithExtraNodes).toBe(1);
  });
});

describe("plantPredictionErrors", () => {
  type ScoredPose = { points: { xy: [number, number]; visible: boolean; score?: number }[] };
  const predFrames = () =>
    [0, 1, 2, 3, 4].map((f) => ({ videoIdx: 0, frameIdx: f, poses: [pose(0), pose(100)] as ScoredPose[] }));

  // Why: errors are moved AND scored low, decoys only scored low; everything else scores high, so the low score is the only hint.
  it("plants N moved low-scored nodes and D unmoved low-scored decoys, repeatably", () => {
    const frames = predFrames();
    const planted = plantPredictionErrors(frames, ["a", "b", "c"], { n: 3, decoys: 2, seed: 2, min: 10, max: 40 });
    expect(plantPredictionErrors(predFrames(), ["a", "b", "c"], { n: 3, decoys: 2, seed: 2, min: 10, max: 40 })).toEqual(planted);
    expect(planted.filter((p) => p.kind === "error")).toHaveLength(3);
    expect(planted.filter((p) => p.kind === "decoy")).toHaveLength(2);
    expect(new Set(planted.map((p) => `${p.frameIdx}:${p.predIdx}`)).size).toBe(5);
    for (const p of planted) {
      const pt = frames[p.frameIdx].poses[p.predIdx].points[p.node];
      expect(pt.score!).toBeLessThan(0.36);
      expect(pt.xy).toEqual(p.moved);
      expect(p.truth[p.nodeName]).toEqual(p.original);
      expect(p.truth.c).toBeNull(); // the hidden node
      if (p.kind === "decoy") expect(p.distance).toBe(0);
      else expect(p.distance).toBeGreaterThanOrEqual(10 - 1e-9);
    }
    // Every other node is confident.
    const lows = frames.flatMap((f) => f.poses.flatMap((q) => q.points.filter((pt) => pt.score! < 0.6)));
    expect(lows).toHaveLength(5);
  });
});

describe("scoreCorrections", () => {
  const truth = { a: [10, 10] as [number, number], b: [20, 20] as [number, number], c: null };
  const planted: PlantedPrediction[] = [
    { kind: "error", videoIdx: 0, frameIdx: 1, predIdx: 0, node: 0, nodeName: "a", original: [10, 10], moved: [30, 10], distance: 20, truth },
    { kind: "error", videoIdx: 0, frameIdx: 2, predIdx: 1, node: 1, nodeName: "b", original: [20, 20], moved: [20, 50], distance: 30, truth },
    { kind: "error", videoIdx: 0, frameIdx: 3, predIdx: 0, node: 0, nodeName: "a", original: [10, 10], moved: [10, 40], distance: 30, truth },
    { kind: "error", videoIdx: 0, frameIdx: 5, predIdx: 0, node: 0, nodeName: "a", original: [10, 10], moved: [10, 40], distance: 30, truth },
    { kind: "decoy", videoIdx: 0, frameIdx: 4, predIdx: 0, node: 1, nodeName: "b", original: [20, 20], moved: [20, 20], distance: 0, truth },
    { kind: "decoy", videoIdx: 0, frameIdx: 4, predIdx: 1, node: 1, nodeName: "b", original: [20, 20], moved: [20, 20], distance: 0, truth },
    { kind: "decoy", videoIdx: 0, frameIdx: 6, predIdx: 0, node: 0, nodeName: "a", original: [10, 10], moved: [10, 10], distance: 0, truth },
  ];
  const corr = (frame: number, prediction: number, after: ProposalOut["after"]): ProposalOut => ({
    proposal_id: `p${frame}${prediction}`,
    kind: "correct",
    status: "pending",
    video: 0,
    frame,
    prediction,
    after,
  });

  // Why: each number in the correction report must count what its name says.
  it("counts found errors, pixel error, misses, decoys left right or broken, and collateral moves", () => {
    const s = scoreCorrections(planted, [
      corr(1, 0, { a: [13, 14] }), // found, 5 px
      corr(2, 1, { a: [40, 40] }), // wrong node, and moves a away from the truth
      corr(3, 0, {}), // accepted an error as is
      corr(4, 0, {}), // decoy accepted as is: right
      corr(4, 1, { b: [50, 50] }), // decoy broken
      corr(9, 0, { a: [1, 1] }), // not planted
      { ...corr(5, 0, { a: [10, 10] }), status: "rejected" }, // set aside, not scored
    ]);
    expect(s).toMatchObject({
      errors: 4,
      decoys: 3,
      found: 1,
      foundPct: 25,
      notReviewed: 1,
      acceptedAsIs: 1,
      wrongNode: 1,
      medianErrorPx: 5,
      within5PxPct: 100,
      improvedPct: 100,
      decoysNotReviewed: 1, // frame 6: never proposed, so not counted as "left right"
      decoysLeftRight: 1, // the one accepted as is
      decoysLeftRightPct: 50,
      decoysAcceptedAsIs: 1,
      decoysBroken: 1,
      collateralNodes: 1,
      otherCorrections: 1,
      rejectedOrOutdated: 1,
    });
  });
});
