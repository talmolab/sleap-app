// Why: Swap L/R is the one-click fix for a chirality flag in Label QC Review; it must swap only symmetric pairs and undo in one step.
import { describe, it, expect, beforeEach } from "../bun-test";
import { Instance, LabeledFrame, Labels, Skeleton, Video } from "@talmolab/sleap-io.js";
import { SwapSymmetricNodes } from "@/commands/editCommands";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";

function load(skeleton: Skeleton, points: number[][]) {
  useAppStore.setState(useAppStore.getInitialState());
  const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [10, 100, 100, 1] } });
  const inst = Instance.fromNumpy({ pointsData: points, skeleton });
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })],
  });
  useAppStore.getState().setLabels(labels, "clip.slp");
  const app = useAppStore.getState();
  app.setVideo(video);
  app.setFrameIdx(0);
  useAppStore.getState().setInstance(inst);
  return { ctx: new CommandContext(), inst };
}

const xy = (inst: Instance) => inst.points.map((p) => [p.xy[0], p.xy[1]]);

describe("SwapSymmetricNodes", () => {
  let ctx: CommandContext;
  let inst: Instance;

  describe("with declared symmetries", () => {
    beforeEach(() => {
      const skeleton = new Skeleton({
        nodes: ["head", "earA", "earB", "tail"],
        edges: [["head", "tail"]],
        symmetries: [["earA", "earB"]],
      });
      ({ ctx, inst } = load(skeleton, [[50, 50], [40, 45], [60, 45], [50, 90]]));
    });

    // Why: only the pair trades places; midline nodes must stay put.
    it("swaps the symmetric pair and leaves the rest", async () => {
      await ctx.execute(SwapSymmetricNodes);
      expect(xy(inst)).toEqual([[50, 50], [60, 45], [40, 45], [50, 90]]);
    });

    // Why: a swap that took two ⌘Z presses (or none) would be a trap during review.
    it("undoes in one step", async () => {
      await ctx.execute(SwapSymmetricNodes);
      expect(ctx.undo()).toBe(true);
      const restored = useAppStore.getState().instance!;
      expect(xy(restored)).toEqual([[50, 50], [40, 45], [60, 45], [50, 90]]);
      expect(ctx.canUndo).toBe(false);
    });

    // Why: visibility belongs to the position, so a hidden left ear stays hidden on its new side.
    it("carries visibility with the position", async () => {
      inst.points[1].visible = false;
      await ctx.execute(SwapSymmetricNodes);
      expect(inst.points[1].visible).toBe(true);
      expect(inst.points[2].visible).toBe(false);
    });
  });

  // Why: many skeletons declare no symmetries; Label QC infers L/R pairs from names, so the fix must too.
  it("falls back to L/R pairs inferred from node names", async () => {
    const skeleton = new Skeleton({ nodes: ["nose", "ear_L", "ear_R"], edges: [] });
    ({ ctx, inst } = load(skeleton, [[50, 50], [40, 45], [60, 45]]));
    await ctx.execute(SwapSymmetricNodes);
    expect(xy(inst)).toEqual([[50, 50], [60, 45], [40, 45]]);
  });

  // Why: with nothing to swap there must be no silent no-op undo step.
  it("does nothing on a skeleton without left/right pairs", async () => {
    const skeleton = new Skeleton({ nodes: ["nose", "head", "tail"], edges: [] });
    ({ ctx, inst } = load(skeleton, [[1, 1], [2, 2], [3, 3]]));
    await ctx.execute(SwapSymmetricNodes);
    expect(xy(inst)).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(ctx.canUndo).toBe(false);
  });
});
