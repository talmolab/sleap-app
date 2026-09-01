import { describe, it, expect } from "../bun-test";
import { runLabelQc } from "@/lib/analyze/labelQc";

// A 4-node linear skeleton so the derived chain length is >= 4 (the auto gate).
const skel = { edgeIndices: [[0, 1], [1, 2], [2, 3]], nodes: [{}, {}, {}, {}] };
const instS = (points: number[][]) => ({ numpy: () => points, skeleton: skel });
const frame = (frameIdx: number, instances: unknown[]) => ({ frameIdx, instances, isNegative: false });
const mockLabels = (frames: unknown[]) => ({ videos: [{ shape: null }], find: () => frames }) as never;

describe("runLabelQc chain-order (Tier 3)", () => {
  it("flags a self-crossing chain", () => {
    const fs = runLabelQc(mockLabels([frame(0, [instS([[0, 0], [2, 2], [2, 0], [0, 2]])])]));
    expect(fs.find((f) => f.kind === "chain_order")).toMatchObject({ frameIdx: 0, instanceIdx: 0 });
  });
  it("does not flag a monotonic chain", () => {
    const fs = runLabelQc(mockLabels([frame(0, [instS([[0, 0], [1, 0], [2, 0], [3, 0]])])]));
    expect(fs.find((f) => f.kind === "chain_order")).toBeUndefined();
  });
});
