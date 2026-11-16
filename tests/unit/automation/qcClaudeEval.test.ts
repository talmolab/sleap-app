// Why: the accuracy numbers in the PR come from this script; its planting and scoring must be right.
import { describe, it, expect } from "../../bun-test";
import { plantErrors, scoreProposals, type Planted, type ProposalOut } from "../../../scripts/qc-claude-eval";

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

  // Why: a fix that moves a different node doesn't count as finding the planted error.
  it("needs the planted node itself", () => {
    const s = scoreProposals(planted, [fix(1, 0, { b: [10, 10] })]);
    expect(s.found).toBe(0);
    expect(s.medianErrorPx).toBeNull();
  });
});
