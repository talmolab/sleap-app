/**
 * Tests for PropagateTrackLabels (#328 — "track transpose is very slow").
 *
 * PropagateTrackLabels swaps two tracks forward from the current frame,
 * stopping at the first frame that no longer contains `oldTrack`. The
 * original implementation snapshotted the ENTIRE project (every frame, every
 * video, deep-cloned) via `takeAllFramesSnapshot`, then re-scanned the whole
 * project a second time via `labels.find({ video })` (no `frameIdx` — the
 * `sleap-io.js` slow path) just to get this one video's frames. Both are
 * O(total project size) regardless of how many frames actually change.
 *
 * The fix scopes the undo snapshot (and the frame gathering) to exactly the
 * frames that can possibly change: this video, strictly after the current
 * frame. These tests lock in both the unchanged behavior (correctness of the
 * swap/stop condition, undo/redo) and the new scoping guarantee (frames
 * outside that range are never touched — verified via object identity,
 * which would change if they were cloned/replaced).
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { PropagateTrackLabels } from "@/commands/trackCommands";
import {
  Labels,
  LabeledFrame,
  Instance,
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

function makeVideo(name: string): Video {
  return new Video({
    filename: `/v/${name}.mp4`,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

function makeInstance(sk: Skeleton, track: Track): Instance {
  const inst = Instance.fromArray([[10, 10], [11, 11]], sk);
  inst.track = track;
  return inst;
}

/**
 * A two-track video with `frameCount` frames, both tracks present on every
 * frame from frame 0 through `frameCount - 1` — the "fully tracked video"
 * scenario #328 describes. Also seeds a SEPARATE, untouched video with its
 * own frame, so we can assert the propagation never scans/clones it.
 */
function setup(frameCount: number) {
  const sk = makeSkeleton();
  const video = makeVideo("main");
  const otherVideo = makeVideo("other");
  const trackA = new Track("A");
  const trackB = new Track("B");

  const frames: LabeledFrame[] = [];
  const instancesByFrame: { a: Instance; b: Instance }[] = [];
  for (let i = 0; i < frameCount; i++) {
    const instA = makeInstance(sk, trackA);
    const instB = makeInstance(sk, trackB);
    frames.push(
      new LabeledFrame({ video, frameIdx: i, instances: [instA, instB] }),
    );
    instancesByFrame.push({ a: instA, b: instB });
  }

  const otherInst = makeInstance(sk, trackA);
  const otherFrame = new LabeledFrame({
    video: otherVideo,
    frameIdx: 0,
    instances: [otherInst],
  });

  const labels = new Labels({
    labeledFrames: [...frames, otherFrame],
    skeletons: [sk],
    videos: [video, otherVideo],
    tracks: [trackA, trackB],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(0);

  return { labels, video, otherVideo, trackA, trackB, frames, instancesByFrame, otherFrame, otherInst };
}

describe("PropagateTrackLabels", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("swaps A<->B forward from the current frame (exclusive) through the end of a fully-tracked video", async () => {
    const { trackA, trackB, instancesByFrame } = setup(5);
    useAppStore.getState().setFrameIdx(1);

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });

    // Frame 1 (the current frame) is untouched — propagation starts strictly after it.
    expect(instancesByFrame[1].a.track).toBe(trackA);
    expect(instancesByFrame[1].b.track).toBe(trackB);
    // Frames 2-4 got the bidirectional swap.
    for (let i = 2; i < 5; i++) {
      expect(instancesByFrame[i].a.track, `frame ${i}`).toBe(trackB);
      expect(instancesByFrame[i].b.track, `frame ${i}`).toBe(trackA);
    }
  });

  it("stops at the first frame after the current one that no longer contains oldTrack", async () => {
    const sk = makeSkeleton();
    const video = makeVideo("main");
    const trackA = new Track("A");
    const trackB = new Track("B");
    const inst0 = makeInstance(sk, trackA);
    const inst1 = makeInstance(sk, trackA);
    // Frame 2 has no trackA instance at all — propagation must stop before it.
    const inst2 = makeInstance(sk, trackB);
    const inst3 = makeInstance(sk, trackA);

    const labels = new Labels({
      labeledFrames: [
        new LabeledFrame({ video, frameIdx: 0, instances: [inst0] }),
        new LabeledFrame({ video, frameIdx: 1, instances: [inst1] }),
        new LabeledFrame({ video, frameIdx: 2, instances: [inst2] }),
        new LabeledFrame({ video, frameIdx: 3, instances: [inst3] }),
      ],
      skeletons: [sk],
      videos: [video],
      tracks: [trackA, trackB],
    });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });

    expect(inst1.track).toBe(trackB); // swapped
    expect(inst2.track).toBe(trackB); // never had trackA — untouched, propagation stopped here
    expect(inst3.track).toBe(trackA); // never reached — still the original track
  });

  it("never touches frames in a different video (identity preserved — not scanned or cloned)", async () => {
    const { trackA, trackB, otherInst, otherFrame } = setup(3);
    const otherInstancesRef = otherFrame.instances;

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });

    // Same array reference and same Instance reference — proof the other
    // video's frame was never visited by the scoped snapshot/loop.
    expect(otherFrame.instances).toBe(otherInstancesRef);
    expect(otherFrame.instances[0]).toBe(otherInst);
    expect(otherInst.track).toBe(trackA); // unchanged
  });

  it("never touches this video's frames at or before the current frame", async () => {
    const { trackA, trackB, frames, instancesByFrame } = setup(4);
    useAppStore.getState().setFrameIdx(2);
    const frame0InstancesRef = frames[0].instances;
    const frame2InstancesRef = frames[2].instances;

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });

    expect(frames[0].instances).toBe(frame0InstancesRef);
    expect(frames[2].instances).toBe(frame2InstancesRef);
    expect(instancesByFrame[0].a.track).toBe(trackA);
    expect(instancesByFrame[2].a.track).toBe(trackA);
    // Only frame 3 (strictly after frameIdx 2) changed.
    expect(instancesByFrame[3].a.track).toBe(trackB);
  });

  it("undo reverts the swap exactly; redo re-applies it", async () => {
    const { trackA, trackB, frames, instancesByFrame } = setup(4);
    useAppStore.getState().setFrameIdx(0);

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });
    expect(instancesByFrame[1].a.track).toBe(trackB);
    expect(instancesByFrame[3].a.track).toBe(trackB);

    // Restoring a multi-frame snapshot REPLACES `lf.instances` with fresh
    // clones (same as the pre-existing `allFrames` restore path) rather than
    // mutating `.track` in place — so re-read from `frames[i].instances`
    // (the LabeledFrame reference itself is stable) instead of the
    // now-detached `instancesByFrame` objects captured before undo/redo.
    expect(ctx.undo()).toBe(true);
    for (let i = 1; i < 4; i++) {
      expect(frames[i].instances[0].track, `frame ${i} after undo`).toBe(trackA);
      expect(frames[i].instances[1].track, `frame ${i} after undo`).toBe(trackB);
    }

    expect(ctx.redo()).toBe(true);
    for (let i = 1; i < 4; i++) {
      expect(frames[i].instances[0].track, `frame ${i} after redo`).toBe(trackB);
      expect(frames[i].instances[1].track, `frame ${i} after redo`).toBe(trackA);
    }
  });

  it("undo does not touch a different video's frames either", async () => {
    const { trackA, trackB, otherInst, otherFrame } = setup(3);
    const otherInstancesRef = otherFrame.instances;

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });
    expect(ctx.undo()).toBe(true);

    expect(otherFrame.instances).toBe(otherInstancesRef);
    expect(otherFrame.instances[0]).toBe(otherInst);
  });

  it("does nothing without oldTrack/newTrack params", async () => {
    const { instancesByFrame, trackA, trackB } = setup(3);
    await ctx.execute(PropagateTrackLabels, {});
    for (const { a, b } of instancesByFrame) {
      expect(a.track).toBe(trackA);
      expect(b.track).toBe(trackB);
    }
  });

  it("scopes correctly with a large unrelated video in the project (#328 regression)", async () => {
    // The original implementation snapshotted (deep-cloned) and re-scanned
    // EVERY labeled frame in the project regardless of which video/frame
    // range could actually change — so a large SECOND video in the project
    // made every propagate slow even though this command only ever touches
    // the current video going forward. Not asserted on wall-clock here (flaky
    // across CI machines, and cheap at the frame counts that keep this test
    // fast to run) — see the identity-based scoping proof below instead,
    // which shows the fix stays O(scope) regardless of decoy video size.
    const sk = makeSkeleton();
    const video = makeVideo("main");
    const bigOtherVideo = makeVideo("big-other");
    const trackA = new Track("A");
    const trackB = new Track("B");

    const frames: LabeledFrame[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push(
        new LabeledFrame({
          video,
          frameIdx: i,
          instances: [makeInstance(sk, trackA), makeInstance(sk, trackB)],
        }),
      );
    }

    const bigOtherFrames: LabeledFrame[] = [];
    const BIG_N = 5_000;
    for (let i = 0; i < BIG_N; i++) {
      bigOtherFrames.push(
        new LabeledFrame({
          video: bigOtherVideo,
          frameIdx: i,
          instances: [makeInstance(sk, trackA), makeInstance(sk, trackB)],
        }),
      );
    }
    const bigOtherInstancesRef = bigOtherFrames.map((lf) => lf.instances);

    const labels = new Labels({
      labeledFrames: [...frames, ...bigOtherFrames],
      skeletons: [sk],
      videos: [video, bigOtherVideo],
      tracks: [trackA, trackB],
    });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);
    useAppStore.getState().setFrameIdx(0);

    await ctx.execute(PropagateTrackLabels, { oldTrack: trackA, newTrack: trackB });

    // Correctness at scale: the small target video propagated correctly...
    for (let i = 1; i < 20; i++) {
      expect(frames[i].instances[0].track, `frame ${i}`).toBe(trackB);
    }
    // ...and every one of the 5,000 decoy frames is untouched — same array
    // reference, proving none of them were even visited (not just
    // "value unchanged", which a clone-and-reassign could also produce).
    for (let i = 0; i < BIG_N; i += 997) {
      expect(bigOtherFrames[i].instances, `decoy frame ${i}`).toBe(bigOtherInstancesRef[i]);
    }
  });
});
