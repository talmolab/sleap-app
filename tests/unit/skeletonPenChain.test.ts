import { describe, it, expect } from "../bun-test";
import { nodesCrossedBySegment, penStrokeToEdges } from "@/lib/skeletonPenChain";

const P = (x: number, y: number) => ({ x, y });
// three nodes in a row at y=0: idx0 @x0, idx1 @x10, idx2 @x20
const pos = [P(0, 0), P(10, 0), P(20, 0)];

describe("nodesCrossedBySegment", () => {
  it("returns crossed node indices ordered along the segment", () => {
    expect(nodesCrossedBySegment(pos, 2, P(-1, 0), P(21, 0))).toEqual([0, 1, 2]);
  });
  it("orders by travel direction (right→left)", () => {
    expect(nodesCrossedBySegment(pos, 2, P(21, 0), P(-1, 0))).toEqual([2, 1, 0]);
  });
  it("excludes nodes outside the radius", () => {
    expect(nodesCrossedBySegment(pos, 2, P(-1, 5), P(21, 5))).toEqual([]);
  });
  it("skips null positions", () => {
    const p2 = [P(0, 0), null, P(20, 0)];
    expect(nodesCrossedBySegment(p2, 2, P(-1, 0), P(21, 0))).toEqual([0, 2]);
  });
});

describe("penStrokeToEdges", () => {
  it("chains consecutive distinct nodes into ordered edges", () => {
    const stroke = [P(-1, 0), P(5, 0), P(15, 0), P(21, 0)];
    expect(penStrokeToEdges(pos, 2, stroke)).toEqual([[0, 1], [1, 2]]);
  });
  it("handles a fast stroke that spans all nodes in one segment", () => {
    expect(penStrokeToEdges(pos, 2, [P(-1, 0), P(21, 0)])).toEqual([[0, 1], [1, 2]]);
  });
  it("emits a back-edge on revisit (validation is the caller's job)", () => {
    const stroke = [P(-1, 0), P(11, 0), P(-1, 0)]; // 0 → 1 → 0
    expect(penStrokeToEdges(pos, 2, stroke)).toEqual([[0, 1], [1, 0]]);
  });
  it("ignores staying within the same node", () => {
    expect(penStrokeToEdges(pos, 2, [P(0, 0), P(1, 0), P(0.5, 0)])).toEqual([]);
  });
});
