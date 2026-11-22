/**
 * Local jobs never read a project file that is still in SLP format 3.0 on
 * disk: they read a 2.x copy of the open project in the temp directory (the
 * sleap-nn the app installs reads only the 2.x layout). Models still go next
 * to the project file.
 *
 * The labels carry a stand-in `sourceFormat`, shaped like sleap-io.js 0.6's,
 * so this runs against any sleap-io.js; the copy is read back with the
 * installed one.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sio from "@talmolab/sleap-io.js";
import type { ProcessEvent } from "@/platform/backend";

type RunTrainingArgs = [string, string, string, (e: ProcessEvent) => void, string?];

const written = new Map<string, Uint8Array>();
const writeFileMock = vi.fn(async (path: string, bytes: Uint8Array) => {
  written.set(path, bytes);
});
const runTrainingMock = vi.fn(async (..._args: RunTrainingArgs) => ({
  success: true,
  command: "",
  modelPath: "/data/models/run",
}));

vi.mock("@/platform", () => ({ isTauri: true, getPlatform: async () => ({}) }));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "/tmp",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: writeFileMock,
  exists: async () => false,
  remove: async () => {},
}));
vi.mock("@/platform/backend", () => ({
  runTraining: runTrainingMock,
  cancelCommand: async () => {},
  startZmqRelay: async () => {},
  stopZmqRelay: async () => {},
  startProgressRelay: async () => {},
  stopProgressRelay: async () => {},
  listenTrainingProgress: async () => () => {},
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

let useTrainingStore: typeof import("@/stores/trainingStore").useTrainingStore;
let useAppStore: typeof import("@/stores/appStore").useAppStore;
let jobLabelsPath: typeof import("@/lib/jobLabelsFile").jobLabelsPath;

const profile = (name: string) =>
  readFileSync(join(import.meta.dir, `../../src/assets/training_profiles/${name}`), "utf8");

/** A small project; with `format3`, opened for editing from a format 3.0 file. */
function project(format3: boolean): sio.Labels {
  const skeleton = new sio.Skeleton({ nodes: ["a", "b"] });
  const video = new sio.Video({ filename: "/data/movie.mp4" });
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
  if (format3) {
    (labels as unknown as { sourceFormat: unknown }).sourceFormat = {
      formatId: 3,
      access: "edit",
      summary: {
        formatId: 3, unlabeledPoints: 0, unlabeledUserPoints: 0, unlabeledPredictedPoints: 0,
        metadataKeys: { instances: [], frames: [], bboxes: [] }, unknownColumns: [], lossless: true,
      },
      labelsPath: "/data/flies.slp",
    };
  }
  return labels;
}

beforeAll(async () => {
  ({ useTrainingStore } = await import("@/stores/trainingStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
  ({ jobLabelsPath } = await import("@/lib/jobLabelsFile"));
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useTrainingStore.setState(useTrainingStore.getInitialState());
  written.clear();
  writeFileMock.mockClear();
  runTrainingMock.mockClear();
});

describe("jobLabelsPath", () => {
  it("writes a 2.x copy when the project file is in format 3.0", async () => {
    const labels = project(true);
    useAppStore.getState().setLabels(labels, "flies.slp", "/data/flies.slp");
    const path = await jobLabelsPath("/data/flies.slp", "inference");
    expect(path).toMatch(/^\/tmp\/sleap_inference_input_\d+\.slp$/);
    const bytes = written.get(path)!;
    expect(bytes).toBeDefined();
    // The copy is a file the installed sleap-io.js opens without a format 3.0 question.
    const back = await sio.loadSlp(bytes, { openVideos: false });
    expect((back as unknown as { sourceFormat?: unknown }).sourceFormat ?? null).toBeNull();
    expect(back.labeledFrames[0].instances[0].points[1].xy).toEqual([30, 40]);
  });

  it("uses the project file as it is otherwise", async () => {
    useAppStore.getState().setLabels(project(false), "flies.slp", "/data/flies.slp");
    expect(await jobLabelsPath("/data/flies.slp", "training")).toBe("/data/flies.slp");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("leaves another labels file alone", async () => {
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    expect(await jobLabelsPath("/data/other.slp", "training")).toBe("/data/other.slp");
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe("local training", () => {
  beforeEach(() => {
    const s = useTrainingStore.getState();
    s.setConfig("modelType", "top_down");
    s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
    s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!);
  });

  it("reads a 2.x copy of a format 3.0 project file; models go next to the project", async () => {
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    await useTrainingStore.getState().startTraining({});
    expect(runTrainingMock).toHaveBeenCalled();
    const [, labelsPath, , , ckptDir] = runTrainingMock.mock.calls[0] as unknown as RunTrainingArgs;
    expect(labelsPath).toMatch(/^\/tmp\/sleap_training_input_\d+\.slp$/);
    expect(written.has(labelsPath)).toBe(true);
    expect(ckptDir).toBe("/data/models");
  });

  it("reads the project file itself when it is not in format 3.0", async () => {
    useAppStore.getState().setLabels(project(false), "flies.slp", "/data/flies.slp");
    await useTrainingStore.getState().startTraining({});
    const [, labelsPath] = runTrainingMock.mock.calls[0] as unknown as RunTrainingArgs;
    expect(labelsPath).toBe("/data/flies.slp");
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
