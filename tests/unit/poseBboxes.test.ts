/**
 * Boxes around poses (View ▸ Show Boxes Around Poses, Boxes from Poses) follow
 * sleap-nn's `_derived_frame_bboxes` rules, and the drawn-box coverage the
 * Training panel warns about.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Instance,
  Labels,
  LabeledFrame,
  PredictedBoundingBox,
  PredictedInstance,
  Skeleton,
  UserBoundingBox,
  Video,
} from "@talmolab/sleap-io.js";
import { derivePoseBboxes, drawnBoxCoverage, normalizeBboxPadding } from "@/lib/poseBboxes";
import { CommandContext } from "@/commands/CommandContext";
import { BboxesFromPoses } from "@/commands/bboxCommands";
import { useAppStore } from "@/stores/appStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const N = Number.NaN;
const sk = new Skeleton({ nodes: ["a", "b", "c"] });
const video = new Video({ filename: "/v/a.mp4", backendMetadata: { shape: [10, 64, 64, 1] }, openBackend: false });
const user = (pts: number[][]) => Instance.fromArray(pts, sk);
const pred = (pts: number[][]) => {
  const p = new PredictedInstance({ points: { a: pts[0], b: pts[1], c: pts[2] }, skeleton: sk, score: 0.8 });
  return p;
};
const extent = (b: { x1: number; y1: number; x2: number; y2: number }) => [b.x1, b.y1, b.x2, b.y2];

describe("normalizeBboxPadding", () => {
  it("is a finite number ≥ 0, as sleap-nn requires", () => {
    expect(normalizeBboxPadding(4)).toBe(4);
    expect(normalizeBboxPadding("2.5")).toBe(2.5);
    expect(normalizeBboxPadding(-10)).toBe(0);
    expect(normalizeBboxPadding("x")).toBe(0);
    expect(normalizeBboxPadding(Infinity)).toBe(0);
  });
});

describe("derivePoseBboxes", () => {
  it("tight box over visible points, padded on every side", () => {
    const u = user([[10, 20], [30, 5], [N, N]]);
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [u] });
    const [d] = derivePoseBboxes(lf, { padding: 2 });
    expect(d.instance).toBe(u);
    expect(extent(d.box)).toEqual([8, 3, 32, 22]);
    expect(d.box.instance).toBe(u);
    expect(d.box.isPredicted).toBe(false);
  });

  it("negative padding is treated as 0", () => {
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [user([[10, 20], [30, 5], [N, N]])] });
    expect(extent(derivePoseBboxes(lf, { padding: -50 })[0].box)).toEqual([10, 5, 30, 20]);
  });

  it("skips empty instances and zero-size boxes (one visible point, no padding), like sleap-nn", () => {
    const one = user([[10, 10], [N, N], [N, N]]);
    const none = user([[N, N], [N, N], [N, N]]);
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [one, none] });
    expect(derivePoseBboxes(lf, { padding: 0 })).toHaveLength(0);
    // With padding the single point gets a real box.
    expect(derivePoseBboxes(lf, { padding: 3 }).map((d) => d.instance)).toEqual([one]);
  });

  it("predictions only on request, as predicted boxes; instances with a stored box are skipped", () => {
    const u1 = user([[0, 0], [10, 10], [N, N]]);
    const u2 = user([[20, 0], [30, 10], [N, N]]);
    const p1 = pred([[40, 0], [50, 10], [N, N]]);
    const p2 = pred([[60, 0], [70, 10], [N, N]]);
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [u1, u2, p1, p2],
      bboxes: [
        new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10, instance: u1 }),
        // A predicted box linked to a user instance doesn't count as its box.
        new PredictedBoundingBox({ x1: 20, y1: 0, x2: 30, y2: 10, score: 0.5, instance: u2 }),
        new PredictedBoundingBox({ x1: 40, y1: 0, x2: 50, y2: 10, score: 0.5, instance: p1 }),
      ],
    });
    expect(derivePoseBboxes(lf, { padding: 0 }).map((d) => d.instance)).toEqual([u2]);
    const withPred = derivePoseBboxes(lf, { padding: 0, includePredicted: true });
    expect(withPred.map((d) => d.instance)).toEqual([u2, p2]);
    expect(withPred[1].box.isPredicted).toBe(true);
  });
});

describe("drawnBoxCoverage", () => {
  it("counts frames left out of, or partly background in, detector training", () => {
    const frames = [
      // boxed: 1 box, 1 pose
      new LabeledFrame({ video, frameIdx: 0, instances: [user([[0, 0], [5, 5], [N, N]])], bboxes: [new UserBoundingBox({ x1: 0, y1: 0, x2: 5, y2: 5 })] }),
      // poses, no box
      new LabeledFrame({ video, frameIdx: 1, instances: [user([[0, 0], [5, 5], [N, N]])] }),
      // 2 poses, 1 box
      new LabeledFrame({
        video,
        frameIdx: 2,
        instances: [user([[0, 0], [5, 5], [N, N]]), user([[9, 9], [15, 15], [N, N]])],
        bboxes: [new UserBoundingBox({ x1: 0, y1: 0, x2: 5, y2: 5 })],
      }),
      // predictions only: not counted
      new LabeledFrame({ video, frameIdx: 3, instances: [pred([[0, 0], [5, 5], [N, N]])] }),
    ];
    expect(drawnBoxCoverage({ labeledFrames: frames })).toEqual({ hasDrawnBoxes: true, posesWithoutBoxes: 1, partlyBoxed: 1 });
    // A zero-size drawn box doesn't count (sleap-nn drops it).
    const zero = [new LabeledFrame({ video, frameIdx: 0, bboxes: [new UserBoundingBox({ x1: 1, y1: 1, x2: 1, y2: 1 })] })];
    expect(drawnBoxCoverage({ labeledFrames: zero }).hasDrawnBoxes).toBe(false);
  });
});

describe("BboxesFromPoses command", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  function setup(instances: Instance[]) {
    const lf = new LabeledFrame({ video, frameIdx: 0, instances });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [video] });
    const s = useAppStore.getState();
    s.setLabels(labels, "t.slp");
    s.setVideo(video);
    s.setFrameIdx(0);
    s.setLabeledFrame(lf);
    return lf;
  }

  it("adds no zero-size box and clamps negative padding", async () => {
    const lf = setup([user([[10, 10], [N, N], [N, N]]), user([[0, 0], [4, 8], [N, N]])]);
    await ctx.execute(BboxesFromPoses, { padding: -5, scope: "frame" });
    expect(lf.bboxes.map(extent)).toEqual([[0, 0, 4, 8]]);
  });

  it("includePredicted also boxes predictions, as predicted boxes; one undo step", async () => {
    const lf = setup([user([[0, 0], [4, 8], [N, N]]), pred([[20, 0], [24, 8], [N, N]])]);
    await ctx.execute(BboxesFromPoses, { padding: 0, scope: "frame", includePredicted: true });
    expect(lf.bboxes.map((b) => b.isPredicted)).toEqual([false, true]);
    expect(ctx.undo()).toBe(true);
    expect(useAppStore.getState().labels!.labeledFrames[0].bboxes).toHaveLength(0);
  });
});
