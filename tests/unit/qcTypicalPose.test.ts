// Why: the typical-pose ghost must land on the instance (so it's readable) and expose the one misplaced node.
import { describe, it, expect } from "../bun-test";
import {
  alignTypicalPose,
  applySimilarity,
  fitSimilarity,
  typicalPose,
  type Pose,
} from "@/lib/analyze/qc/typicalPose";

const base: Pose = [[0, 0], [10, 0], [10, 5], [0, 5], [5, 8]];
/** Rotate by `deg`, scale by `s`, shift by (tx, ty). */
const transform = (p: Pose, deg: number, s: number, tx: number, ty: number): Pose => {
  const r = (deg * Math.PI) / 180;
  const a = s * Math.cos(r);
  const b = s * Math.sin(r);
  return applySimilarity({ a, b, tx, ty }, p);
};
const close = (p: Pose, q: Pose, tol = 1e-6) =>
  p.every((pt, i) => Math.hypot(pt[0] - q[i][0], pt[1] - q[i][1]) < tol);

describe("fitSimilarity", () => {
  it("recovers a rotation + scale + shift exactly", () => {
    const dst = transform(base, 30, 2, 5, -3);
    const t = fitSimilarity(base, dst)!;
    expect(close(applySimilarity(t, base), dst)).toBe(true);
  });

  it("uses only nodes both poses have, and needs two", () => {
    const dst = transform(base, 0, 1, 1, 1);
    dst[4] = [NaN, NaN];
    expect(close(applySimilarity(fitSimilarity(base, dst)!, base).slice(0, 4), dst.slice(0, 4))).toBe(true);
    const one: Pose = [[1, 1], [NaN, NaN], [NaN, NaN], [NaN, NaN], [NaN, NaN]];
    expect(fitSimilarity(base, one)).toBeNull();
  });
});

describe("typicalPose", () => {
  // Why: the same body in different places, sizes and headings is one shape.
  it("is the shared shape of rotated, scaled and shifted copies", () => {
    const poses = [transform(base, 0, 1, 0, 0), transform(base, 90, 3, 50, 20), transform(base, -40, 0.5, -7, 9)];
    const mean = typicalPose(poses)!;
    expect(close(alignTypicalPose(mean, base)!, base, 1e-6)).toBe(true);
  });

  // Why: a node missing from some poses must still get a typical position from the poses that have it.
  it("fills a node missing from some poses from the others", () => {
    const partial = transform(base, 20, 1, 3, 3);
    partial[4] = [NaN, NaN];
    const mean = typicalPose([base, partial, transform(base, 45, 2, 0, 0)])!;
    expect(Number.isFinite(mean[4][0])).toBe(true);
  });

  it("is null when no pose has 3 placed nodes", () => {
    expect(typicalPose([[[0, 0], [1, 1], [NaN, NaN]]])).toBeNull();
  });
});

describe("alignTypicalPose", () => {
  // Why: one far-off node is the usual flag; it must not drag the ghost away from the other nodes.
  it("ignores the single worst node, so the ghost sits on the good ones", () => {
    const target = transform(base, 10, 2, 100, 100);
    const wrong = target.map((p) => [...p]);
    wrong[4] = [wrong[4][0] + 60, wrong[4][1] - 60];
    const fitted = alignTypicalPose(base, wrong)!;
    expect(close(fitted.slice(0, 4), target.slice(0, 4), 1e-6)).toBe(true);
    // The ghost marks where the bad node should be.
    expect(Math.hypot(fitted[4][0] - target[4][0], fitted[4][1] - target[4][1])).toBeLessThan(1e-6);
  });
});

describe("typicalPose is robust to a few bad labels", () => {
  // Why: the poses QC hunts for are in the data the typical pose is built from; they mustn't move it.
  it("ignores one badly placed node among many good poses", () => {
    const bad = base.map((p) => [...p]);
    bad[4] = [40, -30];
    const poses = [base, base, base, base, transform(base, 30, 2, 5, 5), bad];
    const mean = typicalPose(poses)!;
    expect(close(alignTypicalPose(mean, base)!, base, 1e-6)).toBe(true);
  });
});
