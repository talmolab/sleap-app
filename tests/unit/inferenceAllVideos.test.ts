/**
 * Inference "All videos": one "Entire video" run per project video, each result
 * merged as it arrives. A single run on the project .slp predicts only its
 * already-labeled frames. "Clear all" must clear once, not once per video.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { Instance, LabeledFrame, Labels, PredictedInstance, Skeleton, Video } from "@talmolab/sleap-io.js";
import type { InferenceConfig } from "@/stores/inferenceStore";

const runs: InferenceConfig[] = [];
let nothingToPredictFor = new Set<number>();
vi.mock("@/platform/backend", () => ({
  cancelCommand: async () => {},
  runInference: async (config: InferenceConfig) => {
    runs.push(config);
    if (nothingToPredictFor.has(config.videoIndex as number)) {
      return { success: true, outputPath: null, command: "", nothingToPredict: true };
    }
    return { success: true, outputPath: `/out/video${config.videoIndex}.slp`, command: "sleap-nn predict" };
  },
}));
vi.mock("@/platform", () => ({
  getPlatform: async () => ({ readFile: async () => new Uint8Array([1]) }),
}));
vi.mock("@/lib/unsavedGuard", () => ({ confirmSaveBeforeRun: async () => true }));

const skeleton = new Skeleton({ nodes: ["a", "b"] });
const PTS = [
  [1, 1],
  [2, 2],
];
const FILENAMES = ["/data/day1/cam.mp4", "/data/day2/cam.mp4"];

// Each run's output: its video (same basename as the other!) with a prediction on frame 10 + index.
vi.mock("@/lib/slpRead", () => ({
  readSlpStreaming: async () => null,
  loadSlp: async (_bytes: Uint8Array, opts: { h5: { filenameHint: string } }) => {
    const vi = Number(/video(\d+)\.slp$/.exec(opts.h5.filenameHint)![1]);
    const v = new Video({ filename: FILENAMES[vi], backendMetadata: { shape: [100, 8, 8, 1] }, openBackend: false });
    const lf = new LabeledFrame({ video: v, frameIdx: 10 + vi, instances: [PredictedInstance.fromArray(PTS, skeleton, 0.9)] });
    return new Labels({ labeledFrames: [lf], skeletons: [skeleton], videos: [v] });
  },
}));

import { useInferenceStore } from "@/stores/inferenceStore";
import { useAppStore } from "@/stores/appStore";
import { buildPostTrainingInferenceConfig } from "@/stores/trainingStore";
import { mergeModeForRun } from "@/lib/predictionMergeMode";

function setupProject() {
  const videos = FILENAMES.map(
    (filename) => new Video({ filename, backendMetadata: { shape: [100, 8, 8, 1] }, openBackend: false }),
  );
  const frames = [
    new LabeledFrame({ video: videos[0], frameIdx: 50, instances: [PredictedInstance.fromArray(PTS, skeleton, 0.5)] }),
    new LabeledFrame({ video: videos[1], frameIdx: 5, instances: [Instance.fromArray(PTS, skeleton)] }),
  ];
  const labels = new Labels({ labeledFrames: frames, skeletons: [skeleton], videos });
  useAppStore.getState().setLabels(labels, "project.slp", "/proj/project.slp");
  useAppStore.setState({ skeleton });
  return videos;
}

const allVideos = (existingPredictions: InferenceConfig["existingPredictions"]): InferenceConfig =>
  buildPostTrainingInferenceConfig({
    modelType: "top_down",
    modelPaths: ["/m/centroid", "/m/centered_instance"],
    inferenceTarget: "all_videos",
    videoIndex: "all",
    existingPredictions,
  });

const predictedOn = (v: Video, frameIdx: number) =>
  (useAppStore.getState().labels as Labels).find({ video: v, frameIdx }).flatMap((lf) => lf.predictedInstances)
    .length;

describe("Inference All videos — one Entire video run per video", () => {
  beforeEach(() => {
    runs.length = 0;
    nothingToPredictFor = new Set();
    useAppStore.setState(useAppStore.getInitialState());
    useInferenceStore.setState(useInferenceStore.getInitialState());
  });

  it("runs each video as an Entire video run", async () => {
    setupProject();
    await useInferenceStore.getState().startInference(allVideos("replace"));
    expect(runs.map((c) => [c.frameRange, c.videoIndex])).toEqual([
      ["video", 0],
      ["video", 1],
    ]);
    expect(useInferenceStore.getState().status).toBe("completed");
  });

  it("Clear all keeps every video's new predictions and drops only the old ones", async () => {
    const [day1, day2] = setupProject();
    await useInferenceStore.getState().startInference(allVideos("clear_all"));

    expect(predictedOn(day1, 50)).toBe(0);
    expect(predictedOn(day1, 10)).toBe(1);
    // Same basename as day1: still lands on day2.
    expect(predictedOn(day2, 11)).toBe(1);
    expect(predictedOn(day1, 11)).toBe(0);
  });

  it("skips a video with nothing left to predict and still runs the rest", async () => {
    const [, day2] = setupProject();
    nothingToPredictFor = new Set([0]);
    await useInferenceStore.getState().startInference({ ...allVideos("clear_all"), excludeUserLabeled: true });

    expect(predictedOn(day2, 11)).toBe(1);
    expect(useInferenceStore.getState().log.some((l) => l.includes("skipped"))).toBe(true);
    expect(useInferenceStore.getState().status).toBe("completed");
  });
});

describe("mergeModeForRun", () => {
  it("clears only on the first merge of a multi-run inference", () => {
    expect(mergeModeForRun("clear_all", 0)).toBe("clear_all");
    expect(mergeModeForRun("clear_all", 1)).toBe("replace");
    expect(mergeModeForRun("keep", 3)).toBe("keep");
    expect(mergeModeForRun("replace", 2)).toBe("replace");
  });
});
