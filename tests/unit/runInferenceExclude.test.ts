/**
 * runInference with "Exclude user-labeled frames" on a run whose --data_path is
 * the raw video: sleap-nn ignores --exclude_user_labeled there (a video has no
 * annotations), so the app must list the frames to predict itself.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";

const invokeCalls: Array<{ program: string; args: string[] }> = [];
vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (_cmd: string, payload: { program: string; args: string[] }) => {
    invokeCalls.push({ program: payload.program, args: payload.args });
    return true;
  },
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "/tmp",
  join: async (...parts: string[]) => parts.join("/"),
  dirname: async (p: string) => p.slice(0, p.lastIndexOf("/")),
  basename: async (p: string) => p.slice(p.lastIndexOf("/") + 1),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: async () => {},
  writeFile: async () => {},
}));

import { Instance, LabeledFrame, Labels, PredictedInstance, Skeleton, Video } from "@talmolab/sleap-io.js";
import { runInference } from "@/platform/backend";
import { useAppStore } from "@/stores/appStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { buildPostTrainingInferenceConfig } from "@/stores/trainingStore";
import type { InferenceConfig } from "@/stores/inferenceStore";

const PROJECT = "/proj/project.slp";
const VIDEO = "/data/day2/cam.mp4";

function setProject(nFrames: number, userLabeled: number[], predictedOnly: number[] = []) {
  const skeleton = new Skeleton({ nodes: ["a", "b"] });
  const other = new Video({ filename: "/data/day1/cam.mp4", backendMetadata: { shape: [nFrames, 8, 8, 1] }, openBackend: false });
  const video = new Video({ filename: VIDEO, backendMetadata: { shape: [nFrames, 8, 8, 1] }, openBackend: false });
  const pts = [
    [1, 1],
    [2, 2],
  ];
  const frames = [
    ...userLabeled.map((f) => new LabeledFrame({ video, frameIdx: f, instances: [Instance.fromArray(pts, skeleton)] })),
    ...predictedOnly.map(
      (f) => new LabeledFrame({ video, frameIdx: f, instances: [PredictedInstance.fromArray(pts, skeleton, 0.9)] }),
    ),
    // A user label on the OTHER video must not exclude this video's frame 1.
    new LabeledFrame({ video: other, frameIdx: 1, instances: [Instance.fromArray(pts, skeleton)] }),
  ];
  useAppStore
    .getState()
    .setLabels(new Labels({ labeledFrames: frames, skeletons: [skeleton], videos: [other, video] }), "project.slp");
}

function setSleapNnVersion(version: string) {
  useEnvironmentStore.setState({
    pythonCheck: { ...useEnvironmentStore.getState().pythonCheck, sleapNnVersion: version } as never,
  });
}

function config(frameRange: InferenceConfig["frameRange"]): InferenceConfig {
  return buildPostTrainingInferenceConfig({
    modelType: "top_down",
    modelPaths: ["/models/centroid", "/models/centered_instance"],
    inferenceTarget: frameRange as string,
    videoIndex: 1,
    skipUserLabeled: true,
  });
}

const valAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("runInference — Exclude user-labeled frames on a raw-video run", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    useAppStore.setState(useAppStore.getInitialState());
    setSleapNnVersion("0.3.5");
  });

  it("entire video: lists every frame but the user-labeled ones, without --exclude_user_labeled", async () => {
    setProject(10, [0, 3], [5]);
    const result = await runInference(config("video"), PROJECT, () => {});

    expect(result.success).toBe(true);
    const { args } = invokeCalls[0];
    expect(valAfter(args, "--data_path")).toBe(VIDEO);
    expect(valAfter(args, "--frames")).toBe("1,2,4,5,6,7,8,9");
    expect(args).not.toContain("--exclude_user_labeled");
    expect(args).not.toContain("--video_index");
  });

  it("custom range: one remaining run of frames goes as a single range", async () => {
    setProject(300, [0, 64, 128, 192]);
    await runInference(config({ start: 65, end: 127 }), PROJECT, () => {});
    expect(valAfter(invokeCalls[0].args, "--frames")).toBe("65-127");
  });

  it("does not launch sleap-nn when every target frame is user-labeled", async () => {
    setProject(10, [4]);
    useAppStore.setState({ frameIdx: 4 });
    const result = await runInference(config("frame"), PROJECT, () => {});

    expect(result.nothingToPredict).toBe(true);
    expect(result.outputPath).toBeNull();
    expect(invokeCalls).toHaveLength(0);
  });

  it("a frame list too long for a command line runs on the project .slp, where sleap-nn 0.3.5 filters itself", async () => {
    setProject(40_000, [0, 3]);
    await runInference(config("video"), PROJECT, () => {});

    const { args } = invokeCalls[0];
    expect(valAfter(args, "--data_path")).toBe(PROJECT);
    expect(valAfter(args, "--video_index")).toBe("1");
    expect(args).toContain("--exclude_user_labeled");
    expect(args).not.toContain("--frames");
  });

  it("a frame list too long for an older sleap-nn is refused, not silently ignored", async () => {
    setSleapNnVersion("0.3.4");
    setProject(40_000, [0, 3]);
    await expect(runInference(config("video"), PROJECT, () => {})).rejects.toThrow(/0\.3\.5/);
    expect(invokeCalls).toHaveLength(0);
  });

  it("without Exclude, an entire-video run still predicts the whole video", async () => {
    setProject(10, [0, 3]);
    await runInference({ ...config("video"), excludeUserLabeled: false }, PROJECT, () => {});
    expect(invokeCalls[0].args).not.toContain("--frames");
    expect(invokeCalls[0].args).not.toContain("--exclude_user_labeled");
  });
});
