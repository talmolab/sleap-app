/**
 * Thin-integration tests for MergeConflictsCommand (A3 apply + undo).
 *
 * The pure apply is covered in mergeConflicts.test.ts; here we assert the
 * WIRING: the command mutates the store's Labels per the resolutions and that a
 * single undo snapshot reverts the whole thing (data + count).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { MergeConflictsCommand } from "@/commands/mergeConflictCommands";
import { enumerateConflicts, type ResolvedConflict } from "@/lib/mergeConflicts";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
} from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}
function makeSkeleton(name = "s"): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}
function makeVideo(filename: string): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}
function userInst(sk: Skeleton, x: number, y: number): Instance {
  return Instance.fromArray(
    [
      [x, y],
      [x + 1, y + 1],
    ],
    sk
  );
}
const x0 = (inst: Instance): number => inst.numpy()[0][0];

/** Base user instance at (10,10) on frame 0; donor a ~2.8px clash at (12,12). */
function setup() {
  const sk = makeSkeleton();
  const baseVideo = makeVideo("/base/clip.mp4");
  const base = new Labels({
    labeledFrames: [
      new LabeledFrame({
        video: baseVideo,
        frameIdx: 0,
        instances: [userInst(sk, 10, 10)],
      }),
    ],
    skeletons: [sk],
    videos: [baseVideo],
  });
  useAppStore.getState().setLabels(base, "base.slp");
  useAppStore.setState({
    labeledFrame: base.find({ video: baseVideo, frameIdx: 0 })[0],
  });

  const donorSk = makeSkeleton("d");
  const donorVideo = makeVideo("/other/clip.mp4"); // same basename → matches
  const donor = new Labels({
    labeledFrames: [
      new LabeledFrame({
        video: donorVideo,
        frameIdx: 0,
        instances: [userInst(donorSk, 12, 12)],
      }),
    ],
    skeletons: [donorSk],
    videos: [donorVideo],
  });
  return { base, donor, baseVideo };
}

function frame0(base: Labels, video: Video): LabeledFrame {
  return base.find({ video, frameIdx: 0 })[0];
}

describe("MergeConflictsCommand", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("keep-both adds both poses; undo reverts to one", async () => {
    const { base, donor, baseVideo } = setup();
    const conflicts = await enumerateConflicts(base, donor);
    const resolutions: ResolvedConflict[] = conflicts.map((c) => ({
      conflict: c,
      choice: "both",
    }));

    await ctx.execute(MergeConflictsCommand, { other: donor, resolutions });
    expect(frame0(base, baseVideo).instances).toHaveLength(2);

    expect(ctx.undo()).toBe(true);
    expect(frame0(base, baseVideo).instances).toHaveLength(1);
    expect(x0(frame0(base, baseVideo).instances[0])).toBe(10);
  });

  it("keep-donor replaces the base pose; undo restores it", async () => {
    const { base, donor, baseVideo } = setup();
    const conflicts = await enumerateConflicts(base, donor);
    const resolutions: ResolvedConflict[] = conflicts.map((c) => ({
      conflict: c,
      choice: "donor",
    }));

    await ctx.execute(MergeConflictsCommand, { other: donor, resolutions });
    let insts = frame0(base, baseVideo).instances;
    expect(insts).toHaveLength(1);
    expect(x0(insts[0])).toBe(12); // donor pose won

    expect(ctx.undo()).toBe(true);
    insts = frame0(base, baseVideo).instances;
    expect(insts).toHaveLength(1);
    expect(x0(insts[0])).toBe(10); // base pose restored
  });

  it("is a no-op without a donor", async () => {
    const { base, baseVideo } = setup();
    await ctx.execute(MergeConflictsCommand, {});
    expect(frame0(base, baseVideo).instances).toHaveLength(1);
    expect(ctx.canUndo).toBe(false);
  });
});
