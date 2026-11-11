/**
 * Labels ▸ Merge Instance (Shift+M), ported from legacy SLEAP's
 * `MergeInstances` (sleap/gui/commands.py): fold a second user instance on the
 * frame into the selected one, filling only the nodes the selected one is
 * missing, then remove the second.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { MergeInstance } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { classifyDirty } from "@/lib/autosaveDirty";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const N = NaN;

/**
 * Frame 0 of one video with a 4-node skeleton. `front` has nodes a, b;
 * `back` has nodes c, d (and its own guess for b). Extra instances can be
 * appended per test.
 */
function setup(extra: (sk: Skeleton) => Instance[] = () => []) {
  const sk = new Skeleton({ nodes: ["a", "b", "c", "d"], name: "s" });
  const video = new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [10, 480, 640, 3] },
    openBackend: false,
  });
  const trackA = new Track("A");
  const trackB = new Track("B");
  const front = Instance.fromArray([[1, 1], [2, 2], [N, N], [N, N]], sk);
  front.track = trackA;
  const back = Instance.fromArray([[N, N], [9, 9], [3, 3], [4, 4]], sk);
  back.track = trackB;
  back.points[2].complete = true;
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [front, back, ...extra(sk)] });
  const labels = new Labels({
    labeledFrames: [lf],
    skeletons: [sk],
    videos: [video],
    tracks: [trackA, trackB],
  });
  const store = useAppStore.getState();
  store.setLabels(labels, "test.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setLabeledFrame(lf);
  store.setInstance(front);
  return { labels, lf, sk, front, back, trackA };
}

const xy = (inst: Instance) => inst.points.map((p) => [p.xy[0], p.xy[1]]);

describe("MergeInstance", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("fills the selected instance's missing nodes from the other one and removes it", async () => {
    const { lf, front, back, trackA } = setup();
    await ctx.execute(MergeInstance);

    expect(lf.instances).toEqual([front]);
    expect(lf.instances).not.toContain(back);
    // b is kept from the survivor (both had it); c, d come from the donor.
    expect(xy(front)).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(front.points.map((p) => p.visible)).toEqual([true, true, true, true]);
    // Completeness travels with the copied node.
    expect(front.points[2].complete).toBe(true);
    expect(front.points[3].complete).toBe(false);
    // The survivor keeps its own track and stays selected.
    expect(front.track).toBe(trackA);
    expect(useAppStore.getState().instance).toBe(front);
  });

  it("fills a node the survivor has but marked non-visible", async () => {
    const { front } = setup();
    front.points[1].visible = false;
    await ctx.execute(MergeInstance);
    expect(xy(front)[1]).toEqual([9, 9]);
    expect(front.points[1].visible).toBe(true);
  });

  it("doesn't copy a node the donor has as non-visible", async () => {
    const { front, back } = setup();
    back.points[3].visible = false;
    await ctx.execute(MergeInstance);
    expect(xy(front)[3].every(Number.isNaN)).toBe(true);
  });

  it("is one undo step that brings both instances back", async () => {
    const { lf, front, back } = setup();
    await ctx.execute(MergeInstance);
    expect(ctx.undoCommandName).toBe("MergeInstance");

    expect(ctx.undo()).toBe(true);
    expect(lf.instances).toHaveLength(2);
    // Undo restores by value; check the poses rather than object identity.
    const restored = lf.instances.map(xy);
    expect(restored[0][2].every(Number.isNaN)).toBe(true);
    expect(restored[1]).toEqual(xy(back));
    expect(ctx.canUndo).toBe(false);
    void front;
  });

  it("merges the explicitly given donor when the frame has more than two", async () => {
    let third!: Instance;
    const { lf, front, back } = setup((sk) => {
      third = Instance.fromArray([[N, N], [N, N], [7, 7], [8, 8]], sk);
      return [third];
    });
    await ctx.execute(MergeInstance, { donor: third });
    expect(lf.instances).toEqual([front, back]);
    expect(xy(front)).toEqual([[1, 1], [2, 2], [7, 7], [8, 8]]);
  });

  it("uses the Instances panel's second pick (mergePartner) as the donor", async () => {
    let third!: Instance;
    const { lf, front, back } = setup((sk) => {
      third = Instance.fromArray([[N, N], [N, N], [7, 7], [8, 8]], sk);
      return [third];
    });
    useAppStore.getState().setMergePartner(third);
    await ctx.execute(MergeInstance);
    expect(lf.instances).toEqual([front, back]);
    expect(useAppStore.getState().mergePartner).toBeNull();
  });

  it("does nothing with three user instances and no donor picked", async () => {
    const { lf } = setup((sk) => [Instance.fromArray([[5, 5], [N, N], [N, N], [N, N]], sk)]);
    await ctx.execute(MergeInstance);
    expect(lf.instances).toHaveLength(3);
    expect(ctx.canUndo).toBe(false);
  });

  it("never merges a prediction, or into one", async () => {
    let pred!: PredictedInstance;
    const { lf, front, back } = setup((sk) => {
      pred = PredictedInstance.fromArray([[N, N], [N, N], [6, 6], [6, 6]], sk);
      return [pred];
    });
    // A prediction as the donor is refused.
    await ctx.execute(MergeInstance, { donor: pred });
    expect(lf.instances).toHaveLength(3);

    // With the prediction selected, nothing happens either.
    useAppStore.getState().setInstance(pred);
    await ctx.execute(MergeInstance);
    expect(lf.instances).toEqual([front, back, pred]);

    // Two user instances + a prediction: the prediction isn't counted, so the
    // other user instance is the donor and the prediction stays.
    useAppStore.getState().setInstance(front);
    await ctx.execute(MergeInstance);
    expect(lf.instances).toEqual([front, pred]);
  });

  it("does nothing with only one user instance on the frame", async () => {
    const { lf, back } = setup();
    lf.instances = lf.instances.filter((i) => i !== back);
    await ctx.execute(MergeInstance);
    expect(lf.instances).toHaveLength(1);
    expect(ctx.canUndo).toBe(false);
  });

  it("refuses instances with different skeletons", async () => {
    const { lf, back } = setup();
    const other = new Skeleton({ nodes: ["a", "b", "c", "x"], name: "o" });
    back.skeleton = other;
    await ctx.execute(MergeInstance);
    expect(lf.instances).toHaveLength(2);
  });

  it("is a frame-level edit for incremental autosave", () => {
    const { lf } = setup();
    for (const commandName of ["MergeInstance", "AddMissingInstanceNodes", "MarkInstanceComplete"]) {
      expect(
        classifyDirty({
          commandName,
          frame: { videoRef: lf.video, frameIdx: 0 },
          scopedFrames: null,
          allFrames: null,
          activeVideo: lf.video,
          activeFrameIdx: 0,
        }),
      ).toEqual({ kind: "frames", frames: [{ video: lf.video, frameIdx: 0 }] });
    }
  });

  it("is bound to Shift+M", () => {
    expect(DEFAULT_SHORTCUTS["merge instance"]).toBe("Shift+KeyM");
  });
});
