/**
 * Thin-integration tests for MergeIntoProjectCommand.
 *
 * io's `Labels.merge` is exhaustively tested upstream; here we assert only the
 * WIRING: (1) a donor-only frame lands in the current project, (2) the strategy
 * param actually reaches io (keep_both vs base_wins differ on a conflict), and
 * (3) an undo snapshot is pushed. Mirrors mergePredictions.test.ts.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { MergeIntoProjectCommand } from "@/commands/mergeProjectCommands";
import { Labels, LabeledFrame, Instance, Video, Skeleton } from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

function makeSkeleton(name = "test"): Skeleton {
  const s = new Skeleton({ nodes: ["node_0", "node_1"], name });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}

function makeVideo(filename = "/base/test.mp4"): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

function userInst(skeleton: Skeleton, x: number, y: number): Instance {
  return Instance.fromArray(
    [
      [x, y],
      [x + 1, y + 1],
    ],
    skeleton
  );
}

function currentLabels(): Labels {
  return useAppStore.getState().labels as Labels;
}

function frame0(labels: Labels, video: Video): LabeledFrame {
  return labels.find({ video, frameIdx: 0 })[0];
}

/**
 * Base project: video "test.mp4", frame 0 has a user instance at (10,10).
 * Donor: SAME skeleton, same-basename video (other path), a CONFLICTING frame-0
 * instance at (12,12) (~2.8px away → within io's 5px spatial matcher), plus a
 * donor-only frame 5.
 */
function setup() {
  const skeleton = makeSkeleton();
  const baseVideo = makeVideo("/base/test.mp4");
  const base = new Labels({
    labeledFrames: [
      new LabeledFrame({
        video: baseVideo,
        frameIdx: 0,
        instances: [userInst(skeleton, 10, 10)],
      }),
    ],
    skeletons: [skeleton],
    videos: [baseVideo],
  });
  useAppStore.getState().setLabels(base, "base.slp");

  const donorVideo = makeVideo("/compute/test.mp4");
  const donor = new Labels({
    labeledFrames: [
      new LabeledFrame({
        video: donorVideo,
        frameIdx: 0,
        instances: [userInst(makeSkeleton(), 12, 12)],
      }),
      new LabeledFrame({
        video: donorVideo,
        frameIdx: 5,
        instances: [userInst(makeSkeleton(), 50, 50)],
      }),
    ],
    skeletons: [donor_skeleton_placeholder()],
    videos: [donorVideo],
  });
  return { base, donor, baseVideo };
}

// donor frames were built with fresh skeletons above; give the donor Labels a
// skeleton that structurally matches base (2 nodes + 1 edge) so the merge isn't
// skeleton-blocked.
function donor_skeleton_placeholder(): Skeleton {
  return makeSkeleton("donor");
}

describe("MergeIntoProjectCommand", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("adds a donor-only frame into the current project and enables undo", async () => {
    const { donor, baseVideo } = setup();
    await ctx.execute(MergeIntoProjectCommand, { other: donor, strategy: "smart" });

    const labels = currentLabels();
    const f5 = labels.find({ video: baseVideo, frameIdx: 5 });
    expect(f5.length).toBe(1);
    expect(f5[0].instances.length).toBe(1);
    expect(ctx.canUndo).toBe(true);
  });

  it("keep_both keeps both conflicting instances on the shared frame", async () => {
    const { donor, baseVideo } = setup();
    await ctx.execute(MergeIntoProjectCommand, { other: donor, strategy: "keep_both" });
    expect(frame0(currentLabels(), baseVideo).instances.length).toBe(2);
  });

  it("base_wins keeps only the project's instance on the conflicting frame", async () => {
    const { donor, baseVideo } = setup();
    await ctx.execute(MergeIntoProjectCommand, { other: donor, strategy: "base_wins" });
    expect(frame0(currentLabels(), baseVideo).instances.length).toBe(1);
  });

  it("is a no-op without a donor", async () => {
    setup();
    await ctx.execute(MergeIntoProjectCommand, {});
    // Base frame 0 untouched; no donor frame 5.
    const labels = currentLabels();
    expect(labels.find({ video: labels.videos[0], frameIdx: 5 }).length).toBe(0);
  });

  it("undo after a same-frame-count merge reverts the shared frame (stale-index regression)", async () => {
    // Donor conflicts ONLY on the existing frame 0 (no donor-only frame), so the
    // merge leaves the labeled-frame COUNT unchanged (1 → 1). io guards its frame
    // index by frame COUNT, so undo's wipe+rebuild of `labeledFrames` left the
    // index pointing at the stale, post-merge frame — `find()` handed back the
    // 2-instance frame after undo and the canvas kept the merged instances.
    // Regression guard for the `reindex()` call in restoreSnapshot.
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo("/base/test.mp4");
    const base = new Labels({
      labeledFrames: [
        new LabeledFrame({
          video: baseVideo,
          frameIdx: 0,
          instances: [userInst(skeleton, 10, 10)],
        }),
      ],
      skeletons: [skeleton],
      videos: [baseVideo],
    });
    useAppStore.getState().setLabels(base, "base.slp");
    // Mirror the user having navigated to frame 0 — the status bar reads the
    // store's `labeledFrame` pointer directly.
    const f0 = base.find({ video: baseVideo, frameIdx: 0 })[0];
    useAppStore.setState({ labeledFrame: f0, instance: f0.instances[0] });

    const donorVideo = makeVideo("/compute/test.mp4");
    const donor = new Labels({
      labeledFrames: [
        new LabeledFrame({
          video: donorVideo,
          frameIdx: 0,
          instances: [userInst(makeSkeleton(), 12, 12)],
        }),
      ],
      skeletons: [makeSkeleton("donor")],
      videos: [donorVideo],
    });

    await ctx.execute(MergeIntoProjectCommand, { other: donor, strategy: "keep_both" });
    // Sanity: the conflict landed on the shared frame; frame count is unchanged.
    expect(currentLabels().labeledFrames.length).toBe(1);
    expect(frame0(currentLabels(), baseVideo).instances.length).toBe(2);

    expect(ctx.undo()).toBe(true);

    // io-level truth the canvas/status bar derive from.
    expect(frame0(currentLabels(), baseVideo).instances.length).toBe(1);
    // Store pointer the status bar / VideoPlayer overlay read directly.
    expect(useAppStore.getState().labeledFrame?.instances.length).toBe(1);
  });

  it("undo removes a video the merge added (snapshot must cover labels.videos)", async () => {
    // Donor references a DIFFERENT-basename video, so the merge appends it as a
    // second project video. The undo snapshot captured only frames + tracks, so
    // the added video survived undo (status bar stuck on "Video 1 / 2"). Guard
    // that restoreSnapshot reverts labels.videos too.
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo("/base/test.mp4");
    const base = new Labels({
      labeledFrames: [
        new LabeledFrame({
          video: baseVideo,
          frameIdx: 0,
          instances: [userInst(skeleton, 10, 10)],
        }),
      ],
      skeletons: [skeleton],
      videos: [baseVideo],
    });
    useAppStore.getState().setLabels(base, "base.slp");

    // Different basename → no video match → merge appends it as a new video.
    const donorVideo = makeVideo("/other/camera_B.mp4");
    const donor = new Labels({
      labeledFrames: [
        new LabeledFrame({
          video: donorVideo,
          frameIdx: 0,
          instances: [userInst(makeSkeleton(), 50, 50)],
        }),
      ],
      skeletons: [makeSkeleton("donor")],
      videos: [donorVideo],
    });

    await ctx.execute(MergeIntoProjectCommand, { other: donor, strategy: "smart" });
    expect(currentLabels().videos.length).toBe(2); // sanity: donor video added

    expect(ctx.undo()).toBe(true);
    expect(currentLabels().videos.length).toBe(1);
    expect(currentLabels().videos[0]).toBe(baseVideo);
  });
});
