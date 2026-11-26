/**
 * "Random sample (all videos)" runs inference once per video and merges each
 * result. With "Clear all", every merge used to strip all predictions
 * project-wide, so each video's merge wiped what the previous ones added and
 * only the last video's predictions survived. Only the first merge may clear.
 *
 * The local loop, the remote "Fetch & Load" and the post-training loop are
 * driven here with real `MergePredictions` merges into a real project; only
 * sleap-nn (runInference / runTraining), the disk and the worker are faked.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";
import type { InferenceConfig } from "@/stores/inferenceStore";
import type { JobResult } from "@/lib/sleapConnect";
import { mergeModeForRun } from "@/lib/predictionMergeMode";

/** Fake disk: predictions files sleap-nn "wrote", by path. */
const files = new Map<string, Uint8Array>();
/** Predictions each video's run produces, by video index. */
let predictionsByVideo: Record<number, Labels> = {};

const runInferenceMock = vi.fn(async (cfg: InferenceConfig) => {
  const videoIndex = cfg.videoIndex as number;
  const outputPath = `/out/video${videoIndex}.predictions.slp`;
  files.set(outputPath, await saveSlpToBytes(predictionsByVideo[videoIndex]));
  return { success: true, outputPath, command: "" };
});

const fetchResultBlobMock = vi.fn(async (ref: { sha256: string }) => files.get(ref.sha256)!);

vi.mock("@/platform", () => ({
  isTauri: true,
  getPlatform: async () => ({ readFile: async (p: string) => files.get(p)! }),
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async () => false, remove: async () => {} }));
// Spread the real module: stores reached through the app store import more
// of it than these runs use.
const realBackend = await import("@/platform/backend");
vi.mock("@/platform/backend", () => ({
  ...realBackend,
  runInference: runInferenceMock,
  runTraining: async (_y: string, _l: string, runName: string, _e: unknown, modelDir?: string) => ({
    success: true,
    command: "",
    modelPath: `${modelDir}/${runName}`,
  }),
  cancelCommand: async () => {},
  startZmqRelay: async () => {},
  stopZmqRelay: async () => {},
  startProgressRelay: async () => {},
  stopProgressRelay: async () => {},
  listenTrainingProgress: async () => () => {},
}));
vi.mock("@/stores/connectStore", () => ({
  useConnectStore: { getState: () => ({ fetchResultBlob: fetchResultBlobMock, activeTransport: "websocket" }) },
}));

let useInferenceStore: typeof import("@/stores/inferenceStore").useInferenceStore;
let mergeRemoteResults: typeof import("@/stores/inferenceStore").mergeRemoteResults;
let useTrainingStore: typeof import("@/stores/trainingStore").useTrainingStore;
let buildPostTrainingInferenceConfig: typeof import("@/stores/trainingStore").buildPostTrainingInferenceConfig;
let useAppStore: typeof import("@/stores/appStore").useAppStore;

beforeAll(async () => {
  ({ useInferenceStore, mergeRemoteResults } = await import("@/stores/inferenceStore"));
  ({ useTrainingStore, buildPostTrainingInferenceConfig } = await import("@/stores/trainingStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
});

// ── Fixture ──────────────────────────────────────────────────────

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: ["a", "b"], name: "s" });
}

function makeVideo(name: string, dir = "/data"): Video {
  return new Video({
    filename: `${dir}/${name}.mp4`,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}

const pred = (sk: Skeleton, x: number) => PredictedInstance.fromArray([[x, x], [x + 1, x + 1]], sk, 0.9);

/**
 * Two videos. Video A: frame 0 has a user instance and a stale prediction,
 * frame 50 only a stale prediction. Video B: frame 3 only a stale prediction.
 * The new runs predict frame 10 of A and frame 20 of B.
 */
function setupProject() {
  const sk = makeSkeleton();
  const videoA = makeVideo("a");
  const videoB = makeVideo("b");
  const labels = new Labels({
    labeledFrames: [
      new LabeledFrame({ video: videoA, frameIdx: 0, instances: [Instance.fromArray([[5, 5], [6, 6]], sk), pred(sk, 1)] }),
      new LabeledFrame({ video: videoA, frameIdx: 50, instances: [pred(sk, 2)] }),
      new LabeledFrame({ video: videoB, frameIdx: 3, instances: [pred(sk, 3)] }),
    ],
    skeletons: [sk],
    videos: [videoA, videoB],
  });
  useAppStore.getState().setLabels(labels, "/data/project.slp");

  // Each run's output only covers its own video, at a compute-node path.
  const outputFor = (name: string, frameIdx: number, x: number) => {
    const s = makeSkeleton();
    const v = makeVideo(name, "/node");
    return new Labels({
      labeledFrames: [new LabeledFrame({ video: v, frameIdx, instances: [pred(s, x)] })],
      skeletons: [s],
      videos: [v],
    });
  };
  predictionsByVideo = { 0: outputFor("a", 10, 40), 1: outputFor("b", 20, 70) };
}

/** Predicted frame indices per video basename, plus frames with a user instance. */
function summary() {
  const labels = useAppStore.getState().labels!;
  const out: Record<string, { predicted: number[]; user: number[] }> = {};
  for (const lf of labels.labeledFrames) {
    const name = String(lf.video.filename).split("/").pop()!;
    out[name] ??= { predicted: [], user: [] };
    if (lf.predictedInstances.length > 0) out[name].predicted.push(lf.frameIdx);
    if (lf.userInstances.length > 0) out[name].user.push(lf.frameIdx);
  }
  for (const v of Object.values(out)) {
    v.predicted.sort((a, b) => a - b);
    v.user.sort((a, b) => a - b);
  }
  return out;
}

const randomConfig = (existingPredictions: InferenceConfig["existingPredictions"]): InferenceConfig =>
  buildPostTrainingInferenceConfig({
    modelType: "top_down",
    modelPaths: ["/models/centroid", "/models/ci"],
    inferenceTarget: "random",
    videoIndex: "all",
    sampleCount: 5,
    existingPredictions,
  });

beforeEach(() => {
  files.clear();
  runInferenceMock.mockClear();
  useInferenceStore.setState(useInferenceStore.getInitialState());
  useTrainingStore.setState(useTrainingStore.getInitialState());
  setupProject();
});

// ── Tests ────────────────────────────────────────────────────────

describe("mergeModeForRun", () => {
  it("clears only on the first merge of a clear_all run", () => {
    expect(mergeModeForRun("clear_all", 0)).toBe("clear_all");
    expect(mergeModeForRun("clear_all", 1)).toBe("replace");
    expect(mergeModeForRun("clear_all", 5)).toBe("replace");
  });

  it("leaves replace and keep unchanged on every run", () => {
    for (const i of [0, 1, 3]) {
      expect(mergeModeForRun("replace", i)).toBe("replace");
      expect(mergeModeForRun("keep", i)).toBe("keep");
    }
  });
});

describe("local Random sample (all videos) with Clear all", () => {
  it("keeps every video's new predictions and still removes the stale ones", async () => {
    await useInferenceStore.getState().startInference(randomConfig("clear_all"));

    expect(useInferenceStore.getState().status).toBe("completed");
    expect(runInferenceMock).toHaveBeenCalledTimes(2);
    expect(summary()).toEqual({
      "a.mp4": { predicted: [10], user: [0] },
      "b.mp4": { predicted: [20], user: [] },
    });
  });

  it("still clears when the first video is skipped (no frames)", async () => {
    const labels = useAppStore.getState().labels!;
    const empty = new Video({ filename: "/data/empty.mp4", backendMetadata: { shape: [0, 480, 640, 3] }, openBackend: false });
    labels.videos.unshift(empty);
    predictionsByVideo = { 1: predictionsByVideo[0], 2: predictionsByVideo[1] };

    await useInferenceStore.getState().startInference(randomConfig("clear_all"));

    expect(runInferenceMock).toHaveBeenCalledTimes(2);
    expect(summary()).toEqual({
      "a.mp4": { predicted: [10], user: [0] },
      "b.mp4": { predicted: [20], user: [] },
    });
  });

  it("Replace keeps stale predictions on frames no run covered", async () => {
    await useInferenceStore.getState().startInference(randomConfig("replace"));

    expect(summary()).toEqual({
      "a.mp4": { predicted: [0, 10, 50], user: [0] },
      "b.mp4": { predicted: [3, 20], user: [] },
    });
  });
});

describe("remote Fetch & Load of several results with Clear all", () => {
  const result = (id: string, path: string | null): JobResult =>
    ({
      jobId: id,
      success: true,
      resultBlobs: path ? { predictions: { sha256: path, size: 0 } } : undefined,
    }) as unknown as JobResult;

  it("keeps every result's predictions and still removes the stale ones", async () => {
    files.set("blobA", await saveSlpToBytes(predictionsByVideo[0]));
    files.set("blobB", await saveSlpToBytes(predictionsByVideo[1]));

    await mergeRemoteResults({
      results: [result("j1", "blobA"), result("j2", "blobB")],
      mode: "clear_all",
      trackOnly: false,
    });

    expect(summary()).toEqual({
      "a.mp4": { predicted: [10], user: [0] },
      "b.mp4": { predicted: [20], user: [] },
    });
  });

  it("clears on the first result that has predictions, even if an earlier one has none", async () => {
    files.set("blobB", await saveSlpToBytes(predictionsByVideo[1]));

    await mergeRemoteResults({
      results: [result("j1", null), result("j2", "blobB")],
      mode: "clear_all",
      trackOnly: false,
    });

    expect(summary()).toEqual({
      "a.mp4": { predicted: [], user: [0] },
      "b.mp4": { predicted: [20], user: [] },
    });
  });
});

describe("post-training Random sample (all videos) with Clear all", () => {
  const profile = (name: string) =>
    readFileSync(join(import.meta.dir, `../../src/assets/training_profiles/${name}`), "utf8");

  it("keeps every video's new predictions and still removes the stale ones", async () => {
    const s = useTrainingStore.getState();
    s.setConfig("modelType", "top_down");
    s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
    s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!);
    useAppStore.setState({ projectPath: "/data/project.slp", hasChanges: false });

    await useTrainingStore.getState().startTraining({
      inferenceTarget: "random",
      sampleCount: 5,
      existingPredictions: "clear_all",
    });

    expect(useTrainingStore.getState().status).toBe("completed");
    expect(runInferenceMock).toHaveBeenCalledTimes(2);
    expect(summary()).toEqual({
      "a.mp4": { predicted: [10], user: [0] },
      "b.mp4": { predicted: [20], user: [] },
    });
  });
});
