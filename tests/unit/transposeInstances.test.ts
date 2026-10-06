/**
 * Tests for TransposeInstances and requestTranspose (legacy-parity redesign,
 * issue follow-up to #328).
 *
 * Legacy SLEAP (`sleap/gui/commands.py`) bakes track-swap propagation into
 * the same transpose/set-track action via a persistent "Propagate Track
 * Labels" preference, and prompts the user to click-select exactly 2
 * instances when a frame has more than 2 (there's no reliable way to guess
 * which pair). Previously, sleap-app had TWO separate, disconnected actions:
 * `TransposeInstances` (current frame only, heuristic pairing) and a
 * `PropagateTrackLabels` menu item that GUESSED the "other" track as
 * "whichever track is next in the array" — silently swapping the wrong pair
 * in any project with more than 2 tracks.
 *
 * This file tests the fix: `TransposeInstances` now handles propagation
 * itself (via the `propagateTrackLabels` preference and, when active, the
 * seekbar's selected frame range), and `requestTranspose` — the actual
 * shortcut/menu entry point — auto-pairs on an exactly-2-instance frame or
 * starts the click-select picker on 3+, instead of ever guessing.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { TransposeInstances, requestTranspose } from "@/commands/trackCommands";
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

/** A two-instance video with `frameCount` frames, both tracks on every frame. */
function setup(frameCount: number, instancesPerFrame = 2) {
  const sk = makeSkeleton();
  const video = makeVideo();
  const tracks = Array.from({ length: Math.max(instancesPerFrame, 2) }, (_, i) => new Track(String.fromCharCode(65 + i)));

  const frames: LabeledFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const instances = tracks.slice(0, instancesPerFrame).map((t) => makeInstance(sk, t));
    frames.push(new LabeledFrame({ video, frameIdx: i, instances }));
  }

  const labels = new Labels({
    labeledFrames: frames,
    skeletons: [sk],
    videos: [video],
    tracks,
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(0);

  return { labels, video, tracks, frames };
}

describe("TransposeInstances", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("auto-pairs and swaps the only two instances on the frame (no propagation by default)", async () => {
    const { tracks, frames } = setup(3);
    const [trackA, trackB] = tracks;

    await ctx.execute(TransposeInstances);

    expect(frames[0].instances[0].track).toBe(trackB);
    expect(frames[0].instances[1].track).toBe(trackA);
    // Propagation is off by default — later frames are untouched.
    expect(frames[1].instances[0].track).toBe(trackA);
    expect(frames[2].instances[0].track).toBe(trackA);
  });

  it("does nothing on a frame with more than 2 instances and no explicit pair (never guesses)", async () => {
    const { tracks, frames } = setup(1, 3);
    await ctx.execute(TransposeInstances);
    // Nothing changed — a 3+-instance frame needs requestTranspose's picker.
    for (let i = 0; i < 3; i++) {
      expect(frames[0].instances[i].track).toBe(tracks[i]);
    }
  });

  it("swaps an explicit pair from params.instances regardless of frame instance count", async () => {
    const { tracks, frames } = setup(1, 3);
    const [instA, instB, instC] = frames[0].instances;
    await ctx.execute(TransposeInstances, { instances: [instA, instC] });

    expect(instA.track).toBe(tracks[2]);
    expect(instC.track).toBe(tracks[0]);
    expect(instB.track).toBe(tracks[1]); // untouched — wasn't part of the pair
  });

  it("propagates forward (bidirectional, stopping at the first non-matching frame) when the preference is on", async () => {
    const { tracks, frames } = setup(4);
    const [trackA, trackB] = tracks;
    useAppStore.getState().set("propagateTrackLabels", true);

    await ctx.execute(TransposeInstances);

    // Every frame from the current one onward gets the bidirectional swap.
    for (let i = 0; i < 4; i++) {
      expect(frames[i].instances[0].track, `frame ${i}`).toBe(trackB);
      expect(frames[i].instances[1].track, `frame ${i}`).toBe(trackA);
    }
  });

  it("stops propagating at the first frame where the swapped-out track no longer appears", async () => {
    const { tracks, frames } = setup(4);
    const [trackA, trackB] = tracks;
    useAppStore.getState().set("propagateTrackLabels", true);
    // Frame 2 has neither original track — a third, unrelated one.
    const unrelated = new Track("Z");
    frames[2].instances[0].track = unrelated;
    frames[2].instances[1].track = null;

    await ctx.execute(TransposeInstances);

    expect(frames[0].instances[0].track).toBe(trackB);
    expect(frames[1].instances[0].track).toBe(trackB);
    expect(frames[2].instances[0].track).toBe(unrelated); // untouched, propagation stopped here
    expect(frames[3].instances[0].track).toBe(trackA); // never reached
  });

  it("clips propagation to the active seekbar frame range instead of going to the end of the video", async () => {
    const { tracks, frames } = setup(5);
    const [trackA, trackB] = tracks;
    useAppStore.getState().set("propagateTrackLabels", true);
    useAppStore.getState().set("frameRange", [0, 2]); // inclusive [0, 2]

    await ctx.execute(TransposeInstances);

    for (let i = 0; i <= 2; i++) {
      expect(frames[i].instances[0].track, `frame ${i}`).toBe(trackB);
    }
    // Frames 3-4 are outside the selected range — untouched.
    expect(frames[3].instances[0].track).toBe(trackA);
    expect(frames[4].instances[0].track).toBe(trackA);
  });

  it("does not propagate when either instance has no track (nothing meaningful to propagate)", async () => {
    const { tracks, frames } = setup(3);
    const [trackA, trackB] = tracks;
    frames[0].instances[0].track = null;
    useAppStore.getState().set("propagateTrackLabels", true);

    await ctx.execute(TransposeInstances);

    // Current-frame swap still happens: instances[0] takes on whatever
    // instances[1] had (trackB), and instances[1] takes on the un-set track.
    // Cast away TS's (incorrect) narrowing of `.track` to literal `null`
    // from the assignment above — `ctx.execute` mutates it in between.
    expect(frames[0].instances[0].track as Track | null).toBe(trackB);
    expect(frames[0].instances[1].track).toBeNull();
    // ...but frame 1's tracks are untouched, since there's no real (non-null)
    // track pair to chase forward.
    expect(frames[1].instances[0].track).toBe(trackA);
    expect(frames[1].instances[1].track).toBe(trackB);
  });

  it("undo reverts the whole propagating transpose (current frame + forward) as ONE step", async () => {
    const { tracks, frames } = setup(3);
    const [trackA, trackB] = tracks;
    useAppStore.getState().set("propagateTrackLabels", true);

    await ctx.execute(TransposeInstances);
    for (let i = 0; i < 3; i++) {
      expect(frames[i].instances[0].track, `frame ${i}`).toBe(trackB);
    }

    expect(ctx.undo()).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(frames[i].instances[0].track, `frame ${i} after undo`).toBe(trackA);
      expect(frames[i].instances[1].track, `frame ${i} after undo`).toBe(trackB);
    }
    // A single undo fully reverted it — no second undo needed/available for
    // "the other half" of the operation.
    expect(ctx.undo()).toBe(false);

    expect(ctx.redo()).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(frames[i].instances[0].track, `frame ${i} after redo`).toBe(trackB);
    }
  });

  it("does nothing with fewer than 2 instances", async () => {
    const { tracks, frames } = setup(1, 1);
    await ctx.execute(TransposeInstances);
    expect(frames[0].instances[0].track).toBe(tracks[0]);
  });
});

describe("requestTranspose", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("executes the swap directly when the frame has exactly 2 instances", () => {
    const { tracks, frames } = setup(1, 2);
    requestTranspose(ctx);
    expect(frames[0].instances[0].track).toBe(tracks[1]);
    expect(useAppStore.getState().instanceSequencePick).toBeNull();
  });

  it("starts the click-select picker (seqLen 2) instead of guessing when the frame has 3+ instances", () => {
    const { tracks, frames } = setup(1, 3);
    requestTranspose(ctx);

    // Nothing swapped yet — waiting on the user's two clicks.
    for (let i = 0; i < 3; i++) {
      expect(frames[0].instances[i].track).toBe(tracks[i]);
    }
    expect(useAppStore.getState().instanceSequencePick?.seqLen).toBe(2);
    expect(useAppStore.getState().instanceSequencePick?.collected).toEqual([]);
  });

  it("does nothing on a frame with fewer than 2 instances", () => {
    setup(1, 1);
    requestTranspose(ctx);
    expect(useAppStore.getState().instanceSequencePick).toBeNull();
  });
});
