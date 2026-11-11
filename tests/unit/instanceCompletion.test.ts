/**
 * Legacy SLEAP's instance-completion gestures, and the sleap-app gestures that
 * moved to make room for them:
 *
 *   - Shift+click a node → MarkInstanceComplete (legacy QtNode, Shift).
 *   - Double-click a user instance → AddMissingInstanceNodes (legacy
 *     `AddMissingInstanceNodes`).
 *   - Shift+double-click a prediction → accept it with every node complete
 *     (legacy `newInstance(mark_complete=True)`).
 *   - Toggle one node in the selection: Alt+Shift+click (was Shift+click).
 *   - Select every node of the instance: Shift+A (was double-click).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import {
  AddMissingInstanceNodes,
  MarkInstanceComplete,
  ConvertPredictionToInstance,
} from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { fillMissingUserNodes } from "@/lib/instancePlacement";
import { nodeClickAction, instanceDoubleClickAction } from "@/lib/canvasGestures";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
} from "@talmolab/sleap-io.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const N = NaN;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function makeVideo() {
  return new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

/** Load `frames` (frame 0 = current) into the store, selecting `selected`. */
function load(sk: Skeleton, video: Video, frames: LabeledFrame[], selected: Instance | null) {
  const labels = new Labels({ labeledFrames: frames, skeletons: [sk], videos: [video] });
  const store = useAppStore.getState();
  store.setLabels(labels, "test.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setLabeledFrame(frames[0]);
  store.setInstance(selected);
  return labels;
}

describe("gesture bindings", () => {
  it("Shift+click marks the instance complete; Alt+Shift+click toggles the node", () => {
    expect(nodeClickAction({ shiftKey: true, altKey: false })).toBe("mark-instance-complete");
    expect(nodeClickAction({ shiftKey: true, altKey: true })).toBe("toggle-selection");
    expect(nodeClickAction({ shiftKey: false, altKey: false })).toBe("select-and-drag");
    // Alt alone is still a drag (Alt+drag moves the whole instance).
    expect(nodeClickAction({ shiftKey: false, altKey: true })).toBe("select-and-drag");
  });

  it("double-click: user instance adds missing nodes; Shift accepts a prediction complete", () => {
    expect(instanceDoubleClickAction(false, { shiftKey: false })).toBe("add-missing-nodes");
    expect(instanceDoubleClickAction(false, { shiftKey: true })).toBe("add-missing-nodes");
    expect(instanceDoubleClickAction(true, { shiftKey: false })).toBe("accept-prediction");
    expect(instanceDoubleClickAction(true, { shiftKey: true })).toBe("accept-prediction-complete");
  });

  it("Select every node of the instance is Shift+A", () => {
    expect(DEFAULT_SHORTCUTS["select instance nodes"]).toBe("Shift+KeyA");
    // Doesn't collide with Accept All Predictions on Current Frame.
    expect(DEFAULT_SHORTCUTS["accept all predictions"]).toBe("$mod+Shift+KeyA");
  });
});

describe("MarkInstanceComplete (Shift+click a node)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("marks every placed node complete, leaves missing ones, and undoes", async () => {
    const sk = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo();
    const inst = Instance.fromArray([[1, 1], [2, 2], [N, N]], sk);
    inst.points[1].visible = false; // non-visible but placed: still marked
    load(sk, video, [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })], inst);

    await ctx.execute(MarkInstanceComplete, { instance: inst });
    expect(inst.points.map((p) => p.complete)).toEqual([true, true, false]);
    // Positions and visibility don't change.
    expect(inst.points[1].visible).toBe(false);
    expect(ctx.undoCommandName).toBe("MarkInstanceComplete");

    expect(ctx.undo()).toBe(true);
    const restored = useAppStore.getState().labels!.labeledFrames[0].instances[0];
    expect(restored.points.map((p) => p.complete)).toEqual([false, false, false]);
  });

  it("adds no undo step when everything is already complete", async () => {
    const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = makeVideo();
    const inst = Instance.fromArray([[1, 1], [2, 2]], sk);
    inst.points.forEach((p) => (p.complete = true));
    load(sk, video, [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })], inst);

    await ctx.execute(MarkInstanceComplete, { instance: inst });
    expect(ctx.canUndo).toBe(false);
  });

  it("leaves predictions alone", async () => {
    const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = makeVideo();
    const pred = PredictedInstance.fromArray([[1, 1], [2, 2]], sk);
    load(sk, video, [new LabeledFrame({ video, frameIdx: 0, instances: [pred] })], pred);

    await ctx.execute(MarkInstanceComplete, { instance: pred });
    expect(pred.points.every((p) => !p.complete)).toBe(true);
    expect(ctx.canUndo).toBe(false);
  });
});

describe("Shift+double-click a prediction (ConvertPredictionToInstance markComplete)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  function setup() {
    const sk = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo();
    const pred = PredictedInstance.fromArray([[10, 10], [20, 20], [N, N]], sk);
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [pred] });
    load(sk, video, [lf], null);
    return lf;
  }

  it("marks every node the model placed complete", async () => {
    const lf = setup();
    await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0, markComplete: true });
    const inst = lf.instances[0];
    expect(inst).not.toBeInstanceOf(PredictedInstance);
    // The node the model missed is filled in as non-visible and stays incomplete.
    expect(inst.points.map((p) => p.complete)).toEqual([true, true, false]);
    expect(inst.points[2].visible).toBe(false);
  });

  it("plain double-click still leaves them unconfirmed", async () => {
    const lf = setup();
    await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });
    expect(lf.instances[0].points.map((p) => p.complete)).toEqual([false, false, false]);
  });
});

describe("AddMissingInstanceNodes (double-click a user instance)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  /**
   * A reference instance on frame 5 at a=(0,0), b=(10,0), c=(10,10). The
   * target on frame 0 has a=(100,100), b=(100,110): the reference turned 90°
   * and moved, so c belongs at (90,110).
   */
  function setup() {
    const sk = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo();
    const ref = Instance.fromArray([[0, 0], [10, 0], [10, 10]], sk);
    const target = Instance.fromArray([[100, 100], [100, 110], [N, N]], sk);
    target.points[0].complete = true;
    const lf0 = new LabeledFrame({ video, frameIdx: 0, instances: [target] });
    const lf5 = new LabeledFrame({ video, frameIdx: 5, instances: [ref] });
    const labels = load(sk, video, [lf0, lf5], target);
    return { sk, video, labels, lf0, target, ref };
  }

  it("places a missing node from the other user instances, aligned to this one", async () => {
    const { target } = setup();
    await ctx.execute(AddMissingInstanceNodes, { instance: target });
    const [x, y] = target.points[2].xy;
    expect(close(x, 90) && close(y, 110)).toBe(true);
  });

  it("adds it non-visible and incomplete, and leaves the labeled nodes alone", async () => {
    const { target } = setup();
    await ctx.execute(AddMissingInstanceNodes, { instance: target });
    expect(target.points[2].visible).toBe(false);
    expect(target.points[2].complete).toBe(false);
    expect(target.points[0].xy).toEqual([100, 100]);
    expect(target.points[0].complete).toBe(true);
    expect(target.points[1].xy).toEqual([100, 110]);
  });

  it("is one undo step", async () => {
    const { target, lf0 } = setup();
    await ctx.execute(AddMissingInstanceNodes, { instance: target });
    expect(ctx.undoCommandName).toBe("AddMissingInstanceNodes");
    expect(ctx.undo()).toBe(true);
    expect(lf0.instances[0].points[2].xy.every(Number.isNaN)).toBe(true);
  });

  it("does nothing (no undo step) when nothing is missing", async () => {
    const { ref } = setup();
    await ctx.execute(AddMissingInstanceNodes, { instance: ref });
    expect(ref.points[2].xy).toEqual([10, 10]);
    expect(ctx.canUndo).toBe(false);
  });

  it("ignores predictions, as instance and as reference", async () => {
    const sk = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
    const video = makeVideo();
    const pred = PredictedInstance.fromArray([[0, 0], [10, 0], [N, N]], sk);
    load(sk, video, [new LabeledFrame({ video, frameIdx: 0, instances: [pred] })], pred);
    await ctx.execute(AddMissingInstanceNodes, { instance: pred });
    expect(pred.points[2].xy.every(Number.isNaN)).toBe(true);

    // A prediction is never used to place a user instance's node.
    const target = Instance.fromArray([[100, 100], [100, 110], [N, N]], sk);
    const decoy = PredictedInstance.fromArray([[0, 0], [10, 0], [500, 500]], sk);
    const labels = new Labels({
      labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances: [target, decoy] })],
      skeletons: [sk],
      videos: [video],
    });
    fillMissingUserNodes(target, labels, video, 0);
    const [x, y] = target.points[2].xy;
    // No user reference → near its own nodes, not at the decoy's far-off spot.
    expect(Math.hypot(x - 100, y - 105)).toBeLessThan(10);
  });
});

describe("fillMissingUserNodes", () => {
  const sk = new Skeleton({ nodes: ["a", "b", "c"], name: "s" });
  const video = makeVideo();

  it("averages several references and prefers the nearest frames", () => {
    const target = Instance.fromArray([[0, 0], [10, 0], [N, N]], sk);
    const near1 = Instance.fromArray([[0, 0], [10, 0], [0, 10]], sk);
    const near2 = Instance.fromArray([[0, 0], [10, 0], [0, 20]], sk);
    const labels = new Labels({
      labeledFrames: [
        new LabeledFrame({ video, frameIdx: 0, instances: [target] }),
        new LabeledFrame({ video, frameIdx: 1, instances: [near1] }),
        new LabeledFrame({ video, frameIdx: 2, instances: [near2] }),
      ],
      skeletons: [sk],
      videos: [video],
    });
    expect(fillMissingUserNodes(target, labels, video, 0)).toBe(1);
    const [x, y] = target.points[2].xy;
    expect(close(x, 0) && close(y, 15)).toBe(true);
  });

  it("works from one shared node (translation only)", () => {
    const target = Instance.fromArray([[50, 50], [N, N], [N, N]], sk);
    const ref = Instance.fromArray([[0, 0], [5, 0], [0, 5]], sk);
    const labels = new Labels({
      labeledFrames: [
        new LabeledFrame({ video, frameIdx: 0, instances: [target] }),
        new LabeledFrame({ video, frameIdx: 3, instances: [ref] }),
      ],
      skeletons: [sk],
      videos: [video],
    });
    expect(fillMissingUserNodes(target, labels, video, 0)).toBe(2);
    expect(target.points[1].xy).toEqual([55, 50]);
    expect(target.points[2].xy).toEqual([50, 55]);
  });

  it("centers an instance with no labeled node on the fallback point", () => {
    const target = Instance.fromArray([[N, N], [N, N], [N, N]], sk);
    expect(fillMissingUserNodes(target, null, video, 0)).toBe(0);
    expect(fillMissingUserNodes(target, null, video, 0, [200, 100])).toBe(3);
    for (const p of target.points) {
      expect(Math.hypot(p.xy[0] - 200, p.xy[1] - 100)).toBeLessThan(20);
      expect(p.visible).toBe(false);
    }
  });
});
