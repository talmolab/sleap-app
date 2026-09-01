import { describe, it, expect } from "../bun-test";
import { runLabelQc } from "@/lib/analyze/labelQc";

// 6-node skeleton with no declared symmetries -> pairs inferred from L/R names.
const nodes = [{}, {}, {}, {}, {}, {}];
const skel = {
  nodes,
  nodeNames: ["nose", "tail", "Ear_L", "Ear_R", "Shoulder_L", "Shoulder_R"],
  symmetries: [] as unknown[],
  index: (nd: object) => nodes.indexOf(nd as (typeof nodes)[number]),
};
const inst = (points: number[][]) => ({ numpy: () => points, skeleton: skel });
const correct = [[0, 0], [2, 0], [1, 1], [1, -1], [1.5, 1], [1.5, -1]];
const flipped = [[0, 0], [2, 0], [1, -1], [1, 1], [1.5, -1], [1.5, 1]];
const frame = (frameIdx: number, instances: unknown[]) => ({ frameIdx, instances, isNegative: false });
const mockLabels = (frames: unknown[]) => ({ videos: [{ shape: null }], find: () => frames }) as never;

describe("runLabelQc chirality (Tier 3)", () => {
  it("flags a mirror-flipped instance (canonical side learned from the majority)", () => {
    const fs = runLabelQc(
      mockLabels([
        frame(0, [inst(correct)]),
        frame(1, [inst(correct)]),
        frame(2, [inst(correct)]),
        frame(3, [inst(flipped)]),
      ]),
    );
    const c = fs.filter((f) => f.kind === "chirality");
    expect(c).toHaveLength(1);
    expect(c[0].frameIdx).toBe(3);
  });
});
