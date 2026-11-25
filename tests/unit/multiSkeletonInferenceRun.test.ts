/**
 * Inference store on a mice + pellet project (#99): one sleap-nn run per
 * skeleton, each fed a copy of the project with only its skeleton, each
 * merged under its own skeleton. sleap-nn and file reads are mocked; the
 * merge is real.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { LabeledFrame, Labels, PredictedInstance, Skeleton, Video } from "@talmolab/sleap-io.js";

type RunOpts = { inputLabels?: Labels; outputTag?: string };
type RunConfig = { modelPaths: string[]; maxInstances?: number | null; tracking?: boolean; peakThreshold?: number };
const runCalls: Array<{ modelPaths: string[]; config: RunConfig; opts: RunOpts }> = [];
const outputs = new Map<string, Labels>();

const runInferenceMock = vi.fn(
  async (config: RunConfig, _projectPath: unknown, _onEvent: unknown, opts: RunOpts = {}) => {
    runCalls.push({ modelPaths: config.modelPaths, config, opts });
    return { success: true, outputPath: `/out/${opts.outputTag}.predictions.slp`, command: "sleap-nn predict" };
  },
);
vi.mock("@/platform/backend", () => ({
  runInference: runInferenceMock,
  cancelCommand: async () => {},
}));
vi.mock("@/platform", () => ({
  getPlatform: async () => ({ readFile: async (path: string) => new TextEncoder().encode(path) }),
}));
// Fetch & Load reads a worker's result blob; here the blob's "sha256" names
// the predictions file in `outputs`.
vi.mock("@/stores/connectStore", () => ({
  useConnectStore: {
    getState: () => ({
      activeTransport: "websocket",
      _client: null,
      fetchResultBlob: async (ref: { sha256: string }) => new TextEncoder().encode(ref.sha256),
    }),
  },
}));
vi.mock("@/lib/slpRead", () => ({
  loadSlp: async (bytes: Uint8Array) => outputs.get(new TextDecoder().decode(bytes))!,
  readSlpStreaming: async () => {
    throw new Error("not used");
  },
}));

import { mergeRemoteResults, useInferenceStore, type InferenceConfig } from "@/stores/inferenceStore";
import { DEFAULT_SKELETON_RUN_SETTINGS, type SkeletonRunSettings } from "@/lib/multiSkeletonInference";
import type { JobResult } from "@/lib/sleapConnect";
import { useAppStore } from "@/stores/appStore";
import { makeTwoSkeletonProject } from "./multiSkeletonFixture";

function predictionsFile(nodes: string[], frameIdx: number, xy: [number, number]): Labels {
  const skeleton = new Skeleton({ nodes, name: "model" });
  const video = new Video({ filename: "/data/arena.mp4", backendMetadata: { shape: [100, 480, 640, 3] }, openBackend: false });
  const inst = new PredictedInstance({
    skeleton,
    score: 0.8,
    points: nodes.map((name, i) => ({ xy: [xy[0] + i, xy[1] + i] as [number, number], visible: true, complete: true, score: 0.8, name })),
  });
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [new LabeledFrame({ video, frameIdx, instances: [inst] })] });
}

const baseConfig = {
  pipeline: "top-down",
  trackOnly: false,
  modelPaths: [],
  videoIndex: "all",
  frameRange: "user_labeled",
  existingPredictions: "replace",
  kfNodeIndices: [],
} as unknown as InferenceConfig;

describe("running inference on a mice + pellet project", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useInferenceStore.setState(useInferenceStore.getInitialState());
    runCalls.length = 0;
    outputs.clear();
    runInferenceMock.mockClear();
  });

  // The headline case: mouse top-down + pellet centroid, two runs, two merges.
  it("runs each skeleton's models on its own copy and merges under that skeleton", async () => {
    const { labels, mouse, pellet } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    outputs.set("/out/mouse.predictions.slp", predictionsFile(["head", "body", "tail"], 40, [10, 10]));
    outputs.set("/out/pellet.predictions.slp", predictionsFile(["centroid"], 40, [99, 99]));

    await useInferenceStore.getState().startInference({
      ...baseConfig,
      skeletonRuns: [
        { skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/centroid", "/m/ci"], pipeline: "top-down" },
        { skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/pellet"], pipeline: "centroid-only" },
      ],
    });

    expect(useInferenceStore.getState().error).toBeNull();
    expect(useInferenceStore.getState().status).toBe("completed");
    expect(runCalls.map((c) => c.modelPaths)).toEqual([["/m/centroid", "/m/ci"], ["/m/pellet"]]);
    expect(runCalls.map((c) => c.opts.outputTag)).toEqual(["mouse", "pellet"]);
    expect(runCalls[0].opts.inputLabels?.skeletons).toEqual([mouse]);
    expect(runCalls[1].opts.inputLabels?.skeletons).toEqual([pellet]);

    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 40)!;
    const predicted = frame.instances.filter((i) => i instanceof PredictedInstance);
    expect(predicted.map((i) => i.skeleton)).toEqual([mouse, pellet]);
    expect(labels.skeletons).toHaveLength(2);
  });

  // Per-skeleton tabs: each sleap-nn run gets its own skeleton's settings.
  it("runs each skeleton with its own tab's settings", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    outputs.set("/out/mouse.predictions.slp", predictionsFile(["head", "body", "tail"], 40, [10, 10]));
    outputs.set("/out/pellet.predictions.slp", predictionsFile(["centroid"], 40, [99, 99]));
    const settings = (over: Partial<SkeletonRunSettings>) => ({ ...DEFAULT_SKELETON_RUN_SETTINGS, ...over });

    await useInferenceStore.getState().startInference({
      ...baseConfig,
      maxInstances: 99,
      tracking: false,
      skeletonRuns: [
        { skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/centroid", "/m/ci"], pipeline: "top-down",
          settings: settings({ maxInstances: 2, tracking: true }) },
        { skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/pellet"], pipeline: "centroid-only",
          settings: settings({ maxInstances: 10, peakThreshold: 0.5 }) },
      ],
    });

    expect(useInferenceStore.getState().status).toBe("completed");
    expect(runCalls.map((c) => [c.config.maxInstances, c.config.tracking, c.config.peakThreshold])).toEqual([
      [2, true, 0.2],
      [10, false, 0.5],
    ]);
    const log = useInferenceStore.getState().log.join("\n");
    expect(log).toContain("max 2 instances, peak threshold 0.2, tracking");
    expect(log).toContain("max 10 instances, peak threshold 0.5, no tracking");
  });

  // Without matched runs (e.g. a stale config), nothing starts.
  it("refuses to start without per-skeleton runs", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    await useInferenceStore.getState().startInference({ ...baseConfig, modelPaths: ["/m/x"] });
    expect(runInferenceMock).not.toHaveBeenCalled();
    expect(useInferenceStore.getState().status).toBe("idle");
  });

  // A failed run stops the job with an error naming the skeleton.
  it("stops at a failed run and names its skeleton", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    runInferenceMock.mockImplementationOnce(async () => ({ success: false, outputPath: null, command: "x" }));
    await useInferenceStore.getState().startInference({
      ...baseConfig,
      skeletonRuns: [
        { skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/b"], pipeline: "bottom-up" },
        { skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/pellet"], pipeline: "centroid-only" },
      ],
    });
    expect(runInferenceMock).toHaveBeenCalledTimes(1);
    expect(useInferenceStore.getState().status).toBe("error");
    expect(useInferenceStore.getState().error).toContain("mouse");
  });

  // Review finding 4: suggested frames are read as empty frames, so the run
  // reads the project file itself — no per-skeleton copy is serialized.
  it("doesn't build a per-skeleton copy for suggested frames", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    outputs.set("/out/mouse.predictions.slp", predictionsFile(["head", "body", "tail"], 40, [10, 10]));
    await useInferenceStore.getState().startInference({
      ...baseConfig,
      frameRange: "suggestions",
      skeletonRuns: [{ skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/b"], pipeline: "bottom-up" }],
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].opts.inputLabels).toBeUndefined();
  });

  // Review finding 5: Cancel during run 1 stops there — run 2 never starts and
  // the job ends "cancelled", not as a red "mouse: Inference failed".
  it("stops between runs on Cancel", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    runInferenceMock.mockImplementationOnce(async () => {
      useInferenceStore.setState({ status: "cancelled" }); // what cancelInference does
      return { success: false, outputPath: null, command: "x" };
    });
    await useInferenceStore.getState().startInference({
      ...baseConfig,
      skeletonRuns: [
        { skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/b"], pipeline: "bottom-up" },
        { skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/pellet"], pipeline: "centroid-only" },
      ],
    });
    expect(runInferenceMock).toHaveBeenCalledTimes(1);
    expect(useInferenceStore.getState().status).toBe("cancelled");
    expect(useInferenceStore.getState().error).toBeNull();
  });

  // Review finding 5: Cancel right after a run succeeded skips its merge and the next run.
  it("doesn't merge or continue after Cancel at the end of a run", async () => {
    const { labels, mouse } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    outputs.set("/out/mouse.predictions.slp", predictionsFile(["head", "body", "tail"], 40, [10, 10]));
    runInferenceMock.mockImplementationOnce(async () => {
      useInferenceStore.setState({ status: "cancelled" });
      return { success: true, outputPath: "/out/mouse.predictions.slp", command: "x" };
    });
    await useInferenceStore.getState().startInference({
      ...baseConfig,
      skeletonRuns: [
        { skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/b"], pipeline: "bottom-up" },
        { skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/pellet"], pipeline: "centroid-only" },
      ],
    });
    expect(runInferenceMock).toHaveBeenCalledTimes(1);
    expect(useInferenceStore.getState().status).toBe("cancelled");
    expect(labels.labeledFrames.some((lf) => lf.instances.some((i) => i instanceof PredictedInstance && i.skeleton === mouse))).toBe(false);
  });

  // Review finding 1: Fetch & Load merges each worker result under the
  // skeleton it was run for — even a pellet skeleton with no instances yet —
  // so the pellet result can't wipe the mouse predictions on shared frames.
  it("Fetch & Load merges each result under its own skeleton", async () => {
    const { labels, mouse, pellet } = makeTwoSkeletonProject();
    for (const lf of labels.labeledFrames) lf.instances = lf.instances.filter((i) => i.skeleton !== pellet);
    useAppStore.getState().setLabels(labels);
    outputs.set("mouse-blob", predictionsFile(["head", "body", "tail"], 40, [10, 10]));
    outputs.set("pellet-blob", predictionsFile(["centroid"], 40, [99, 99]));
    const result = (sha256: string) =>
      ({ jobId: sha256, success: true, resultBlobs: { predictions: { sha256, size: 1 } } }) as unknown as JobResult;

    await mergeRemoteResults({
      results: [result("mouse-blob"), result("pellet-blob")],
      mode: "replace",
      trackOnly: false,
      skeletons: [{ name: "mouse", index: 0 }, { name: "pellet", index: 1 }],
    });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 40)!;
    expect(frame.instances.map((i) => i.skeleton)).toEqual([mouse, pellet]);
  });

  // Review finding 1: if the skeletons changed before Fetch & Load, refuse
  // rather than merge under a guessed skeleton.
  it("Fetch & Load refuses when the job's skeleton is gone", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    outputs.set("pellet-blob", predictionsFile(["centroid"], 40, [99, 99]));
    const result = { jobId: "p", success: true, resultBlobs: { predictions: { sha256: "pellet-blob", size: 1 } } } as unknown as JobResult;
    await expect(
      mergeRemoteResults({ results: [result], mode: "replace", trackOnly: false, skeletons: [{ name: "pellets", index: 1 }] }),
    ).rejects.toThrow("skeletons changed");
  });
});
