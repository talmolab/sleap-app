/**
 * Legacy-parity tests for PasteTrack and SetInstanceTrack — porting
 * `PasteInstanceTrack` and `SetSelectedInstanceTrack`'s behavior from
 * `sleap/gui/commands.py`:
 *
 * - Mutual exclusivity: a track identifies one animal per frame, so
 *   assigning a track to an instance unassigns it from any OTHER instance
 *   on the same frame that already had it.
 * - SetInstanceTrack additionally keeps a linked predicted instance's track
 *   in sync, and — when the instance already had a track and "Propagate
 *   Track Labels" is on — swaps forward instead of only touching the
 *   current frame (same mechanism as TransposeInstances).
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { PasteTrack, SetInstanceTrack } from "@/commands/trackCommands";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

function makeSkeleton(): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name: "s" });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}

function makeVideo(): Video {
  return new Video({
    filename: "/v/main.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

function makeInstance(sk: Skeleton, track: Track | null): Instance {
  const inst = Instance.fromArray([[10, 10], [11, 11]], sk);
  inst.track = track;
  return inst;
}

describe("PasteTrack", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("unassigns the pasted track from any other instance on the current frame", async () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const trackA = new Track("A");
    const trackB = new Track("B");
    const target = makeInstance(sk, trackB);
    const other = makeInstance(sk, trackA); // already has trackA — must be cleared
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [target, other] });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [video], tracks: [trackA, trackB] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setLabeledFrame(lf);
    useAppStore.getState().set("clipboardTrack", trackA);

    useAppStore.getState().setInstance(target);
    await ctx.execute(PasteTrack);

    expect(target.track).toBe(trackA);
    expect(other.track).toBeNull(); // cleared — mutual exclusivity
  });

  it("undo reverts the paste and the exclusivity unassignment together", async () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const trackA = new Track("A");
    const trackB = new Track("B");
    const target = makeInstance(sk, trackB);
    const other = makeInstance(sk, trackA);
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [target, other] });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [video], tracks: [trackA, trackB] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setLabeledFrame(lf);
    useAppStore.getState().set("clipboardTrack", trackA);

    useAppStore.getState().setInstance(target);
    await ctx.execute(PasteTrack);
    expect(target.track).toBe(trackA);
    expect(other.track).toBeNull();

    expect(ctx.undo()).toBe(true);
    expect(lf.instances[0].track).toBe(trackB);
    expect(lf.instances[1].track).toBe(trackA);
  });
});

describe("SetInstanceTrack", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  function setupSingleFrame() {
    const sk = makeSkeleton();
    const video = makeVideo();
    const trackA = new Track("A");
    const trackB = new Track("B");
    const target = makeInstance(sk, null);
    const other = makeInstance(sk, trackB); // already on the target track
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [target, other] });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [video], tracks: [trackA, trackB] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setLabeledFrame(lf);
    useAppStore.getState().setInstance(target);
    return { video, trackA, trackB, target, other, lf };
  }

  it("unassigns the target track from any other instance on the current frame", async () => {
    const { trackB, target, other } = setupSingleFrame();
    await ctx.execute(SetInstanceTrack, { trackIdx: 1 }); // trackB
    expect(target.track).toBe(trackB);
    expect(other.track).toBeNull();
  });

  it("keeps a linked predicted instance's track in sync", async () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const trackA = new Track("A");
    const predicted = PredictedInstance.fromArray([[0, 0], [1, 1]], sk, 1);
    const target = Instance.fromArray([[10, 10], [11, 11]], sk);
    target.fromPredicted = predicted;
    const lf = new LabeledFrame({ video, frameIdx: 0, instances: [target] });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [video], tracks: [trackA] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setLabeledFrame(lf);
    useAppStore.getState().setInstance(target);

    await ctx.execute(SetInstanceTrack, { trackIdx: 0 });

    expect(target.track).toBe(trackA);
    expect(predicted.track).toBe(trackA);
  });

  it("propagates forward instead of just the current frame when the instance already had a track and propagation is on", async () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const trackA = new Track("A");
    const trackB = new Track("B");
    const frames = Array.from({ length: 3 }, (_, i) =>
      new LabeledFrame({ video, frameIdx: i, instances: [makeInstance(sk, trackA), makeInstance(sk, trackB)] }),
    );
    const labels = new Labels({ labeledFrames: frames, skeletons: [sk], videos: [video], tracks: [trackA, trackB] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setLabeledFrame(frames[0]);
    useAppStore.getState().setInstance(frames[0].instances[0]); // currently trackA
    useAppStore.getState().set("propagateTrackLabels", true);

    await ctx.execute(SetInstanceTrack, { trackIdx: 1 }); // -> trackB

    for (let i = 0; i < 3; i++) {
      expect(frames[i].instances[0].track, `frame ${i}`).toBe(trackB);
      expect(frames[i].instances[1].track, `frame ${i}`).toBe(trackA);
    }
  });

  it("does not propagate when the instance had no prior track, even with propagation on", async () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const trackA = new Track("A");
    const frames = Array.from({ length: 2 }, (_, i) =>
      new LabeledFrame({ video, frameIdx: i, instances: [makeInstance(sk, i === 0 ? null : trackA)] }),
    );
    const labels = new Labels({ labeledFrames: frames, skeletons: [sk], videos: [video], tracks: [trackA] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);
    useAppStore.getState().setLabeledFrame(frames[0]);
    useAppStore.getState().setInstance(frames[0].instances[0]);
    useAppStore.getState().set("propagateTrackLabels", true);

    await ctx.execute(SetInstanceTrack, { trackIdx: 0 });

    expect(frames[0].instances[0].track).toBe(trackA);
    // Frame 1 already had trackA independently — untouched either way, but
    // confirm no propagation logic ran by checking it's still exactly trackA
    // (not, say, cleared by a stray mutual-exclusivity pass across frames).
    expect(frames[1].instances[0].track).toBe(trackA);
  });

  it("undo reverts a propagating SetInstanceTrack as one step", async () => {
    const { trackA, trackB, target, lf } = setupSingleFrame();
    useAppStore.getState().set("propagateTrackLabels", true);
    target.track = trackA; // give it a prior track so the propagate branch is taken
    // Re-seed: target currently has trackA, other has trackB, both frame 0.

    await ctx.execute(SetInstanceTrack, { trackIdx: 1 }); // trackA -> trackB
    expect(target.track).toBe(trackB);

    // The propagate branch's restore replaces `lf.instances` with fresh
    // clones (same as TransposeInstances/PropagateTrackLabels), detaching
    // the original `target` reference — re-read via the stable `lf` handle.
    expect(ctx.undo()).toBe(true);
    expect(lf.instances[0].track).toBe(trackA);
  });
});
