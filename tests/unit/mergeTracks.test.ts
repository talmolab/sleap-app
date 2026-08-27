/**
 * Tests for the MergeTracks command (track-only inference merge-back).
 *
 * Unlike MergePredictions, a track-only re-track run never adds, removes, or
 * moves an instance — it only (re)assigns `.track`/`.trackingScore` on
 * instances that already exist. MergeTracks routes through sleap-io.js's
 * "update_tracks" frame strategy (spatial match + copy track fields only),
 * which is exhaustively tested upstream — these are THIN-INTEGRATION tests
 * asserting the command wires the right options and doesn't touch geometry.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { MergeTracks } from "@/commands/editCommands";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";

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

function predInst(
  skeleton: Skeleton,
  x: number,
  y: number,
  score = 0.9
): PredictedInstance {
  return PredictedInstance.fromArray(
    [
      [x, y],
      [x + 1, y + 1],
    ],
    skeleton,
    score
  );
}

function setupBase(opts: {
  skeleton: Skeleton;
  video: Video;
  frames: LabeledFrame[];
  tracks?: Track[];
}): Labels {
  const labels = new Labels({
    labeledFrames: opts.frames,
    skeletons: [opts.skeleton],
    videos: [opts.video],
    tracks: opts.tracks ?? [],
  });
  useAppStore.getState().setLabels(labels, "base.slp");
  return labels;
}

function currentLabels(): Labels {
  return useAppStore.getState().labels as Labels;
}

function frameAt(labels: Labels, video: Video, frameIdx: number): LabeledFrame {
  const found = labels.find({ video, frameIdx });
  expect(found.length).toBe(1);
  return found[0];
}

describe("MergeTracks — assigns tracks without touching geometry or counts", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("assigns a track to a previously-untracked USER instance, geometry unchanged", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseInst = userInst(skeleton, 10, 10);
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [baseInst],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    // Retracked output: same spatial position (within match threshold), now
    // carrying a track. Round-tripped through a temp file in real usage, so
    // it's a DISTINCT object graph, not the same Instance.
    const retrackSkel = makeSkeleton();
    const retrackVideo = makeVideo("/compute-node/test.mp4"); // same basename
    const track = new Track("animal_0");
    const retrackedInst = userInst(retrackSkel, 10, 10);
    retrackedInst.track = track;
    const retrackedFrame = new LabeledFrame({
      video: retrackVideo,
      frameIdx: 0,
      instances: [retrackedInst],
    });
    const retracked = new Labels({
      labeledFrames: [retrackedFrame],
      videos: [retrackVideo],
      skeletons: [retrackSkel],
      tracks: [track],
    });

    await ctx.execute(MergeTracks, { retracked });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    // No instance added or removed.
    expect(merged.instances.length).toBe(1);
    // Track assigned...
    expect(merged.instances[0].track?.name).toBe("animal_0");
    // ...geometry untouched (still the original instance's own points).
    expect(merged.instances[0].points[0].xy).toEqual([10, 10]);
  });

  it("assigns a track to a PREDICTED instance the same way", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseInst = predInst(skeleton, 20, 20, 0.87);
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [baseInst],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    const retrackSkel = makeSkeleton();
    const retrackVideo = makeVideo("/compute-node/test.mp4");
    const track = new Track("animal_1");
    const retrackedInst = predInst(retrackSkel, 20, 20, 0.87);
    retrackedInst.track = track;
    const retrackedFrame = new LabeledFrame({
      video: retrackVideo,
      frameIdx: 0,
      instances: [retrackedInst],
    });
    const retracked = new Labels({
      labeledFrames: [retrackedFrame],
      videos: [retrackVideo],
      skeletons: [retrackSkel],
      tracks: [track],
    });

    await ctx.execute(MergeTracks, { retracked });

    const merged = frameAt(currentLabels(), baseVideo, 0);
    expect(merged.instances.length).toBe(1);
    expect(merged.instances[0].track?.name).toBe("animal_1");
    // Score (a PredictedInstance-only field) is untouched by the merge.
    expect((merged.instances[0] as PredictedInstance).score).toBeCloseTo(0.87);
  });

  it("collapses same-named tracks instead of duplicating them (track:'name' wiring)", async () => {
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseTrack = new Track("animal_0");
    const baseInst = userInst(skeleton, 10, 10);
    // Already tracked in the project under an OBJECT-DISTINCT Track with the
    // same name as what the retrack run will assign.
    baseInst.track = baseTrack;
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [baseInst],
    });
    setupBase({
      skeleton,
      video: baseVideo,
      frames: [baseFrame],
      tracks: [baseTrack],
    });

    const retrackSkel = makeSkeleton();
    const retrackVideo = makeVideo("/compute-node/test.mp4");
    const retrackTrack = new Track("animal_0"); // same name, distinct object
    const retrackedInst = userInst(retrackSkel, 10, 10);
    retrackedInst.track = retrackTrack;
    const retrackedFrame = new LabeledFrame({
      video: retrackVideo,
      frameIdx: 0,
      instances: [retrackedInst],
    });
    const retracked = new Labels({
      labeledFrames: [retrackedFrame],
      videos: [retrackVideo],
      skeletons: [retrackSkel],
      tracks: [retrackTrack],
    });

    await ctx.execute(MergeTracks, { retracked });

    const labels = currentLabels();
    // If the command forgot track:"name", io's IDENTITY default would append
    // retrackTrack as a second "animal_0" → length 2. It must stay 1.
    const animalTracks = labels.tracks.filter((t) => t.name === "animal_0");
    expect(animalTracks.length).toBe(1);
  });
});

describe("MergeTracks — wiring & guards", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("reports a track-update summary via toast", async () => {
    const spy = vi.spyOn(toast, "success");
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    const baseFrame = new LabeledFrame({
      video: baseVideo,
      frameIdx: 0,
      instances: [userInst(skeleton, 10, 10)],
    });
    setupBase({ skeleton, video: baseVideo, frames: [baseFrame] });

    const retrackSkel = makeSkeleton();
    const retrackVideo = makeVideo("/compute-node/test.mp4");
    const track = new Track("animal_0");
    const retrackedInst = userInst(retrackSkel, 10, 10);
    retrackedInst.track = track;
    const retracked = new Labels({
      labeledFrames: [
        new LabeledFrame({ video: retrackVideo, frameIdx: 0, instances: [retrackedInst] }),
      ],
      videos: [retrackVideo],
      skeletons: [retrackSkel],
      tracks: [track],
    });

    await ctx.execute(MergeTracks, { retracked });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/track/i);
    spy.mockRestore();
  });

  it("is a no-op when no retracked labels are provided", async () => {
    const spy = vi.spyOn(toast, "success");
    const skeleton = makeSkeleton();
    const baseVideo = makeVideo();
    setupBase({ skeleton, video: baseVideo, frames: [] });

    await ctx.execute(MergeTracks, {}); // no retracked

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
