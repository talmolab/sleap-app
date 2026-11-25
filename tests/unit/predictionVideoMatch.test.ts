/**
 * Predictions merge onto the video they were predicted on, even when two
 * project videos share a basename (/data/day1/cam.mp4 and /data/day2/cam.mp4).
 * Plain basename matching sends both onto the first.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { MergePredictions, MergeTracks } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { knownPredictionVideos } from "@/lib/predictionVideoMatch";
import { Instance, LabeledFrame, Labels, PredictedInstance, Skeleton, Track, Video } from "@talmolab/sleap-io.js";

const PTS = [
  [10, 10],
  [11, 11],
];

function video(filename: string): Video {
  return new Video({ filename, backendMetadata: { shape: [100, 8, 8, 1] }, openBackend: false });
}

/** A project with two same-basename videos and a user instance on day2's frame 5. */
function setupProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"] });
  const day1 = video("/data/day1/cam.mp4");
  const day2 = video("/data/day2/cam.mp4");
  const userFrame = new LabeledFrame({ video: day2, frameIdx: 5, instances: [Instance.fromArray(PTS, skeleton)] });
  const labels = new Labels({ labeledFrames: [userFrame], skeletons: [skeleton], videos: [day1, day2] });
  useAppStore.getState().setLabels(labels, "project.slp");
  return { skeleton, day1, day2 };
}

function predictionsOn(filenames: string[], skeleton: Skeleton, frameIdx = 5, track?: Track): Labels {
  const videos = filenames.map(video);
  const frames = videos.map((v) => {
    const inst = PredictedInstance.fromArray(PTS, skeleton, 0.9);
    if (track) inst.track = track;
    return new LabeledFrame({ video: v, frameIdx, instances: [inst] });
  });
  return new Labels({ labeledFrames: frames, skeletons: [skeleton], videos, tracks: track ? [track] : [] });
}

const labels = () => useAppStore.getState().labels as Labels;
const predictedOn = (v: Video, frameIdx = 5) =>
  labels()
    .find({ video: v, frameIdx })
    .flatMap((lf) => lf.predictedInstances).length;

describe("MergePredictions — same-basename videos", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  it("a single-video run lands on its target video, not the first video with that basename", async () => {
    const { skeleton, day1, day2 } = setupProject();
    await ctx.execute(MergePredictions, {
      predictions: predictionsOn(["/data/day2/cam.mp4"], skeleton),
      videoTarget: 1,
    });
    expect(predictedOn(day2)).toBe(1);
    expect(predictedOn(day1)).toBe(0);
    expect(labels().videos).toHaveLength(2);
  });

  it("still lands on the target when the output names the video by another path (a worker mount)", async () => {
    const { skeleton, day1, day2 } = setupProject();
    await ctx.execute(MergePredictions, {
      predictions: predictionsOn(["/mnt/worker/cam.mp4"], skeleton),
      videoTarget: 1,
    });
    expect(predictedOn(day2)).toBe(1);
    expect(predictedOn(day1)).toBe(0);
  });

  it("a run on the project .slp pairs output videos with project videos by position", async () => {
    const { skeleton, day1, day2 } = setupProject();
    await ctx.execute(MergePredictions, {
      predictions: predictionsOn(["/data/day1/cam.mp4", "/data/day2/cam.mp4"], skeleton, 7),
      videoTarget: "project",
    });
    expect(predictedOn(day1, 7)).toBe(1);
    expect(predictedOn(day2, 7)).toBe(1);
  });

  it("without a known target, merging is plain basename matching (unchanged)", async () => {
    const { skeleton, day1, day2 } = setupProject();
    await ctx.execute(MergePredictions, { predictions: predictionsOn(["/elsewhere/cam.mp4"], skeleton) });
    expect(predictedOn(day1)).toBe(1);
    expect(predictedOn(day2)).toBe(0);
  });
});

describe("MergeTracks — same-basename videos", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("copies tracks onto the target video's instances", async () => {
    const { skeleton, day2 } = setupProject();
    const day2Frame = labels().find({ video: day2, frameIdx: 5 })[0];
    day2Frame.instances.push(PredictedInstance.fromArray(PTS, skeleton, 0.9));

    await new CommandContext().execute(MergeTracks, {
      retracked: predictionsOn(["/data/day2/cam.mp4"], skeleton, 5, new Track("track_0")),
      videoTarget: 1,
    });
    expect(day2Frame.predictedInstances[0].track?.name).toBe("track_0");
  });
});

describe("knownPredictionVideos", () => {
  it("leaves a position whose basename doesn't match to basename matching", () => {
    const project = [video("/a/one.mp4"), video("/a/two.mp4")];
    const output = [video("/w/one.mp4"), video("/w/three.mp4")];
    const known = knownPredictionVideos(output, project, "project");
    expect(known.get(output[0])).toBe(project[0]);
    expect(known.has(output[1])).toBe(false);
  });
});
