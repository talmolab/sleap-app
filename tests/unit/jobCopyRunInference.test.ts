/**
 * The real `runInference` and copy writer, with only the Tauri APIs mocked:
 * for a project whose file is still in SLP format 3.0, what `--data_path`
 * sleap-nn gets, when a 2.x copy is written, and when it is deleted; and the
 * route a large embedded package's copy takes (the streaming writer, as the
 * app's own large saves do).
 *
 * The labels carry a stand-in `sourceFormat`, shaped like sleap-io.js 0.6's,
 * so this runs against any sleap-io.js.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import * as sio from "@talmolab/sleap-io.js";
import type { InferenceConfig } from "@/stores/inferenceStore";

const files = new Map<string, Uint8Array>();
const removed: string[] = [];
const commands: string[][] = [];
const streamed: Array<[unknown, string, string | null]> = [];
const saveSlpToBytesCalls: Array<[unknown, unknown]> = [];
const realSaveSlpToBytes = sio.saveSlpToBytes;
let sourceSize = 1000;

vi.mock("@talmolab/sleap-io.js", () => ({
  ...sio,
  saveSlpToBytes: async (
    labels: sio.Labels,
    options?: Parameters<typeof sio.saveSlpToBytes>[1],
  ) => {
    saveSlpToBytesCalls.push([labels, options]);
    return realSaveSlpToBytes(labels, options);
  },
}));

vi.mock("@/platform/index", () => ({
  isTauri: true,
  getPlatform: async () => ({}),
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { program?: string; args?: string[] }) => {
    if (cmd.endsWith("run_python_command")) {
      commands.push([args.program ?? "", ...(args.args ?? [])]);
      return true;
    }
    return undefined;
  },
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "/tmp",
  appCacheDir: async () => "/cache",
  appLocalDataDir: async () => "/data-local",
  join: async (...parts: string[]) => parts.join("/"),
  dirname: async (p: string) => p.replace(/\/[^/]*$/, ""),
  basename: async (p: string) => p.split("/").pop() ?? p,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
  remove: async (path: string) => {
    removed.push(path);
    files.delete(path);
  },
  readDir: async () => [],
  mkdir: async () => {},
  exists: async () => false,
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: async () => sourceSize,
  readRange: async () => new Uint8Array(0),
}));
vi.mock("@/lib/saveEmbeddedPkgStreaming", () => ({
  saveEmbeddedPkgStreaming: async (labels: unknown, dest: string, source: string | null) => {
    streamed.push([labels, dest, source]);
    files.set(dest, new Uint8Array([1]));
  },
  tempPathFor: (p: string) => `${p}.sleap-tmp-x`,
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { runInference } = await import("@/platform/backend");
const { createJobLabelsCopy, jobLabelsPath } = await import("@/lib/jobLabelsFile");
const { useAppStore } = await import("@/stores/appStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");

/** A small project opened for editing from a format 3.0 file at /data/flies.slp. */
function project(embedded = false): sio.Labels {
  const skeleton = new sio.Skeleton({ nodes: ["a", "b"] });
  const video = new sio.Video({ filename: "/data/movie.mp4" });
  if (embedded) Object.defineProperty(video, "hasEmbeddedImages", { get: () => true });
  const inst = new sio.Instance({
    skeleton,
    points: [
      { xy: [10, 20], visible: true, complete: true },
      { xy: [30, 40], visible: true, complete: true },
    ],
  });
  const labels = new sio.Labels({
    labeledFrames: [new sio.LabeledFrame({ video, frameIdx: 0, instances: [inst] })],
    videos: [video],
    skeletons: [skeleton],
  });
  (labels as unknown as { sourceFormat: unknown }).sourceFormat = {
    formatId: 3,
    access: "edit",
    summary: {
      formatId: 3, unlabeledPoints: 0, unlabeledUserPoints: 0, unlabeledPredictedPoints: 0,
      metadataKeys: { instances: [], frames: [], bboxes: [] }, unknownColumns: [], lossless: true,
    },
    labelsPath: "/data/flies.slp",
  };
  return labels;
}

/** A complete config, as the inference panel builds one. */
function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    pipeline: "top-down", trackOnly: false, modelPaths: ["/models/c", "/models/ci"],
    videoIndex: "all", frameRange: "video", sampleCount: 20, excludeUserLabeled: false,
    existingPredictions: "replace", batchSize: 4, device: "auto", runtime: "auto",
    maxInstances: null, peakThreshold: 0.2, integralRefinement: false, integralPatchSize: 5,
    nPoints: 10, maxEdgeLengthRatio: 0.25, distPenaltyWeight: 1, minLineScores: 0.25,
    tracking: false, trackerMethod: "simple", similarityMethod: "oks", matchingMethod: "hungarian",
    trackingWindowSize: 5, maxTracks: null, connectSingleBreaks: false, robust: 1,
    minMatchPoints: 0, minNewTrackPoints: 0, scoringReduction: "mean",
    trackingTargetInstanceCount: null, trackingPreCullToTarget: false, trackingPreCullIouThreshold: 0,
    trackingCleanInstanceCount: null, trackingCleanIouThreshold: 0, flowImgScale: 1,
    flowWindowSize: 21, flowMaxLevels: 3, kfTrackFeatures: "centroid", kfInitFrameCount: 10,
    kfNodeIndices: [], kfResetGapSize: 5, ensureChannels: "auto", filterOverlapping: false,
    filterMethod: "iou", filterThreshold: 0.5, filterMinVisibleNodes: null,
    filterMinVisibleNodeFraction: null, filterMinMeanNodeScore: null, filterMinInstanceScore: null,
    filterMinCentroidDistance: null,
    ...overrides,
  } as InferenceConfig;
}

/** The `--data_path` of the last sleap-nn command. */
function dataPath(): string {
  const argv = commands[commands.length - 1];
  return argv[argv.indexOf("--data_path") + 1];
}

const COPY = /^\/cache\/job-copies\/sleap-job-inference-main-\d+-\d+\.slp$/;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useEnvironmentStore.setState({ tools: [], pythonCheck: null });
  files.clear();
  removed.length = 0;
  commands.length = 0;
  streamed.length = 0;
  saveSlpToBytesCalls.length = 0;
  sourceSize = 1000;
});

describe("runInference on a project whose file is in format 3.0", () => {
  it("reads its own 2.x copy and deletes it when sleap-nn exits", async () => {
    useAppStore.getState().setLabels(project(), "flies.slp", "/data/flies.slp");
    const res = await runInference(config(), "/data/flies.slp", () => {});
    expect(res.success).toBe(true);
    expect(dataPath()).toMatch(COPY);
    expect(removed).toEqual([dataPath()]);
    expect(files.size).toBe(0);
    // Predictions still go next to the project file.
    expect(res.outputPath).toMatch(/^\/data\/predictions\//);
  });

  it("a video-scoped run that reads the video file writes no copy", async () => {
    useAppStore.getState().setLabels(project(), "flies.slp", "/data/flies.slp");
    await runInference(config({ videoIndex: 0, frameRange: "video" }), "/data/flies.slp", () => {});
    expect(dataPath()).toBe("/data/movie.mp4");
    expect(files.size).toBe(0);
    expect(removed).toEqual([]);
  });

  it("runs of one job share the job's copy, kept until the job releases it", async () => {
    useAppStore.getState().setLabels(project(), "flies.slp", "/data/flies.slp");
    const copy = createJobLabelsCopy("inference");
    await runInference(config(), "/data/flies.slp", () => {}, copy);
    const first = dataPath();
    await runInference(config(), "/data/flies.slp", () => {}, copy);
    expect(dataPath()).toBe(first);
    expect(files.has(first)).toBe(true);
    await copy.release();
    expect(files.has(first)).toBe(false);
  });

  it("a project file in the 2.x layout is read as it is", async () => {
    const labels = project();
    (labels as unknown as { sourceFormat: unknown }).sourceFormat = null;
    useAppStore.getState().setLabels(labels, "flies.slp", "/data/flies.slp");
    await runInference(config(), "/data/flies.slp", () => {});
    expect(dataPath()).toBe("/data/flies.slp");
    expect(files.size).toBe(0);
  });

  it("bypasses the 2.x downgrade copy when local sleap-nn >= 0.4.0a0 is installed", async () => {
    useEnvironmentStore.setState({
      tools: [
        {
          name: "sleap-nn",
          version: "0.4.0a0",
          commands: ["sleap-nn"],
          updateAvailable: false,
          latestVersion: "0.4.0a0",
        },
      ],
    });
    useAppStore.getState().setLabels(project(), "flies.slp", "/data/flies.slp");
    const copy = createJobLabelsCopy("training");
    expect(await jobLabelsPath("/data/flies.slp", copy)).toBe("/data/flies.slp");
    const res = await runInference(config(), "/data/flies.slp", () => {});
    expect(res.success).toBe(true);
    expect(dataPath()).toBe("/data/flies.slp");
    expect(files.size).toBe(0);
    expect(removed).toEqual([]);
  });

  it("gates per-skeleton inputLabels legacy layout on sleap-nn >= 0.4.0a0", async () => {
    const labels = project();
    useAppStore.getState().setLabels(labels, "flies.slp", "/data/flies.slp");

    // Pre-0.4 (or unknown) sleap-nn downgrades per-skeleton inputLabels via legacyV2WriteOptions().
    const legacyRes = await runInference(config(), "/data/flies.slp", () => {}, {
      inputLabels: labels,
      outputTag: "sk0",
    });
    expect(legacyRes.success).toBe(true);
    expect(saveSlpToBytesCalls).toHaveLength(1);
    expect(saveSlpToBytesCalls[0][0]).toBe(labels);
    expect(saveSlpToBytesCalls[0][1]).toEqual({ slpVersion: "v2", unlabeledAs: "absent" });

    // sleap-nn >= 0.4.0a0 reads SLP 3.0 natively, so no legacy layout option is passed.
    saveSlpToBytesCalls.length = 0;
    useEnvironmentStore.setState({
      tools: [
        {
          name: "sleap-nn",
          version: "0.4.0a0",
          commands: ["sleap-nn"],
          updateAvailable: false,
          latestVersion: "0.4.0a0",
        },
      ],
    });
    const nativeRes = await runInference(config(), "/data/flies.slp", () => {}, {
      inputLabels: labels,
      outputTag: "sk0",
    });
    expect(nativeRes.success).toBe(true);
    expect(saveSlpToBytesCalls).toHaveLength(1);
    expect(saveSlpToBytesCalls[0][0]).toBe(labels);
    expect(saveSlpToBytesCalls[0][1]).toBeUndefined();
  });
});

describe("the copy of an embedded package", () => {
  it("above the streaming size goes through the streaming writer, frames from the file on disk", async () => {
    sourceSize = 4 * 1024 ** 3;
    const labels = project(true);
    useAppStore.getState().setLabels(labels, "flies.pkg.slp", "/data/flies.pkg.slp");
    const path = await createJobLabelsCopy("training").path();
    expect(streamed).toEqual([[labels, path, "/data/flies.pkg.slp"]]);
  });

  it("below it is written in memory", async () => {
    const labels = project(true);
    useAppStore.getState().setLabels(labels, "flies.pkg.slp", "/data/flies.pkg.slp");
    const path = await createJobLabelsCopy("training").path();
    expect(streamed).toEqual([]);
    expect(files.has(path)).toBe(true);
  });
});
