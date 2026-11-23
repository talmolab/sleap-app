/**
 * Local jobs never read a project file that is still in SLP format 3.0 on
 * disk: they read the job's 2.x copy of the open project in the temp
 * copies folder under the app's cache folder (the sleap-nn the app installs
 * reads only the 2.x layout). One copy per job, shared by its runs, deleted
 * when the job ends. The next job sweeps only copies old enough that no
 * window or app process can still be using them. Models still go next to the
 * project file. A copy that can't be written ends the job with an error.
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
import type { JobLabelsCopy } from "@/lib/jobLabelsFile";

type RunTrainingArgs = [string, string, string, (e: ProcessEvent) => void, string?];

/** The fake job-copies folder: path → bytes. */
const files = new Map<string, Uint8Array>();
const removed: string[] = [];
let writeError: Error | null = null;
let trainingOutcome: "succeed" | "fail" = "succeed";
const inferencePaths: string[] = [];

const runTrainingMock = vi.fn(async (..._args: RunTrainingArgs) =>
  trainingOutcome === "succeed"
    ? { success: true, command: "", modelPath: "/data/models/run" }
    : { success: false, command: "", modelPath: "" },
);

vi.mock("@/platform", () => ({
  isTauri: true,
  getPlatform: async () => ({}),
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "/tmp",
  appCacheDir: async () => "/cache",
  appLocalDataDir: async () => "/data-local",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: async (path: string, bytes: Uint8Array) => {
    if (writeError) throw writeError;
    files.set(path, bytes);
  },
  remove: async (path: string) => {
    removed.push(path);
    files.delete(path);
  },
  readDir: async (dir: string) =>
    [...files.keys()]
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => ({ name: p.split("/").pop(), isFile: true, isDirectory: false })),
  mkdir: async () => {},
  exists: async () => false,
}));
vi.mock("@/platform/backend", () => ({
  // Everything else the stores import from the backend, unused here.
  detectUv: vi.fn(async () => {}),
  listUvTools: vi.fn(async () => {}),
  listPythonInterpreters: vi.fn(async () => {}),
  listDownloadablePythons: vi.fn(async () => {}),
  checkPython: vi.fn(async () => {}),
  installPython: vi.fn(async () => {}),
  detectGpu: vi.fn(async () => {}),
  detectAccelerator: vi.fn(async () => {}),
  detectSleapNnExtras: vi.fn(async () => {}),
  gpuStats: vi.fn(async () => {}),
  checkWandbAuth: vi.fn(async () => {}),
  installUvTool: vi.fn(async () => {}),
  upgradeUvTool: vi.fn(async () => {}),
  uninstallUvTool: vi.fn(async () => {}),
  updateUv: vi.fn(async () => {}),
  installUv: vi.fn(async () => {}),
  runPythonCommand: vi.fn(async () => {}),
  exportNwb: vi.fn(async () => {}),
  sendTrainingStop: vi.fn(async () => {}),
  spawnOverlayServe: vi.fn(async () => {}),
  killOverlayServe: vi.fn(async () => {}),
  runExport: vi.fn(async () => {}),
  rtcJoinRoom: vi.fn(async () => {}),
  rtcConnectWorker: vi.fn(async () => {}),
  rtcSend: vi.fn(async () => {}),
  rtcDisconnectWorker: vi.fn(async () => {}),
  rtcLeaveRoom: vi.fn(async () => {}),
  runTraining: runTrainingMock,
  // Local inference: read the job's copy, as the real runInference does when
  // the project file is in format 3.0.
  runInference: async (_cfg: unknown, _projectPath: string | null, _on: unknown, copy?: JobLabelsCopy) => {
    if (copy) inferencePaths.push(await copy.path());
    return { success: true, outputPath: null, command: "sleap-nn predict" };
  },
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
let useInferenceStore: typeof import("@/stores/inferenceStore").useInferenceStore;
let useAppStore: typeof import("@/stores/appStore").useAppStore;
let jobFile: typeof import("@/lib/jobLabelsFile");

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

const COPY = /^\/cache\/job-copies\/sleap-job-(training|inference)-main-\d+-\d+\.slp$/;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  ({ useTrainingStore } = await import("@/stores/trainingStore"));
  ({ useInferenceStore } = await import("@/stores/inferenceStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
  jobFile = await import("@/lib/jobLabelsFile");
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useTrainingStore.setState(useTrainingStore.getInitialState());
  useInferenceStore.setState(useInferenceStore.getInitialState());
  files.clear();
  removed.length = 0;
  inferencePaths.length = 0;
  writeError = null;
  trainingOutcome = "succeed";
  runTrainingMock.mockClear();
});

describe("jobLabelsPath", () => {
  it("writes the job's 2.x copy once, when the project file is in format 3.0, and deletes it on release", async () => {
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    const copy = jobFile.createJobLabelsCopy("inference");
    const path = await jobFile.jobLabelsPath("/data/flies.slp", copy);
    expect(path).toMatch(COPY);
    expect(await jobFile.jobLabelsPath("/data/flies.slp", copy)).toBe(path); // reused
    expect(files.size).toBe(1);
    // The copy is a file the installed sleap-io.js opens without a format 3.0 question.
    const back = await sio.loadSlp(files.get(path)!, { openVideos: false });
    expect((back as unknown as { sourceFormat?: unknown }).sourceFormat ?? null).toBeNull();
    expect(back.labeledFrames[0].instances[0].points[1].xy).toEqual([30, 40]);
    await copy.release();
    expect(removed).toEqual([path]);
    await copy.release(); // twice is fine
    expect(removed).toEqual([path]);
  });

  it("uses the project file as it is otherwise, and another labels file untouched", async () => {
    useAppStore.getState().setLabels(project(false), "flies.slp", "/data/flies.slp");
    const copy = jobFile.createJobLabelsCopy("training");
    expect(await jobFile.jobLabelsPath("/data/flies.slp", copy)).toBe("/data/flies.slp");
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    expect(await jobFile.jobLabelsPath("/data/other.slp", jobFile.createJobLabelsCopy("training"))).toBe(
      "/data/other.slp",
    );
    expect(files.size).toBe(0);
  });

  it("the sweep deletes only old copies and partial copies, never another window's recent one", async () => {
    const old = Date.now() - 8 * DAY;
    const fresh = Date.now() - 60_000;
    const stale = `/cache/job-copies/sleap-job-training-other-${old}-1.slp`;
    const staleTmp = `/cache/job-copies/sleap-job-training-other-${old}-2.slp.sleap-tmp-abc-123`;
    const freshTmp = `/cache/job-copies/sleap-job-inference-other-${fresh}-3.slp.sleap-tmp-def`;
    const unrelated = "/cache/job-copies/notes.txt";
    for (const p of [stale, staleTmp, freshTmp, unrelated]) files.set(p, new Uint8Array([1]));
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");

    // Window A (this module instance) writes its copy; its sweep removes the old files.
    const copyA = await jobFile.createJobLabelsCopy("training").path();
    expect(removed.sort()).toEqual([stale, staleTmp].sort());
    expect(files.has(freshTmp)).toBe(true);
    expect(files.has(unrelated)).toBe(true);

    // Window B: another instance of the module, as another app window has.
    // (A query string makes the runtime load a separate instance; the path is
    // held in a variable so the type checker doesn't look it up.)
    const secondInstance = "../../src/lib/jobLabelsFile.ts?window=B";
    const windowB = (await import(secondInstance)) as typeof jobFile;
    expect(windowB).not.toBe(jobFile);
    expect(await windowB.sweepStaleJobCopies()).toBe(0);
    await windowB.createJobLabelsCopy("inference").path();
    expect(files.has(copyA)).toBe(true); // window A's job still runs

    // A week later, window A's own sweep still keeps the copy its job uses.
    expect(await jobFile.sweepStaleJobCopies(Date.now() + 8 * DAY)).toBe(2); // window B's, and the partial
    expect(files.has(copyA)).toBe(true);
    expect(files.has(freshTmp)).toBe(false);
  });
});

describe("local training", () => {
  beforeEach(() => {
    const s = useTrainingStore.getState();
    s.setConfig("modelType", "top_down");
    s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
    s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!);
  });

  it("both models read one 2.x copy, deleted when the job ends; models go next to the project", async () => {
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    await useTrainingStore.getState().startTraining({});
    expect(runTrainingMock).toHaveBeenCalledTimes(2);
    const calls = runTrainingMock.mock.calls as unknown as RunTrainingArgs[];
    const [, labelsPath, , , ckptDir] = calls[0];
    expect(labelsPath).toMatch(COPY);
    expect(calls[1][1]).toBe(labelsPath);
    expect(ckptDir).toBe("/data/models");
    expect(removed).toEqual([labelsPath]);
    // The training log says when the copy starts and when it is written.
    const log = useTrainingStore.getState().log.join("\n");
    expect(log).toContain("Writing a 2.x copy of the project for sleap-nn");
    expect(log).toContain("2.x copy written");
    expect(files.size).toBe(0);
  });

  it("a failed job deletes its copy too", async () => {
    trainingOutcome = "fail";
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    await useTrainingStore.getState().startTraining({});
    expect(useTrainingStore.getState().status).toBe("error");
    expect(files.size).toBe(0);
  });

  it("a copy that can't be written ends the job with an error, not a run that never ends", async () => {
    writeError = new Error("No space left on device");
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    await useTrainingStore.getState().startTraining({});
    const s = useTrainingStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("Couldn't write a 2.x copy of the project for training");
    expect(s.error).toContain("No space left on device");
    expect(runTrainingMock).not.toHaveBeenCalled();
  });

  it("reads the project file itself when it is not in format 3.0", async () => {
    useAppStore.getState().setLabels(project(false), "flies.slp", "/data/flies.slp");
    await useTrainingStore.getState().startTraining({});
    const [, labelsPath] = runTrainingMock.mock.calls[0] as unknown as RunTrainingArgs;
    expect(labelsPath).toBe("/data/flies.slp");
    expect(files.size).toBe(0);
  });
});

describe("local inference", () => {
  it("reads the job's copy and deletes it when the job ends", async () => {
    useAppStore.getState().setLabels(project(true), "flies.slp", "/data/flies.slp");
    await useInferenceStore.getState().startInference({ existingPredictions: "replace", trackOnly: false } as never);
    expect(inferencePaths).toHaveLength(1);
    expect(inferencePaths[0]).toMatch(COPY);
    expect(removed).toEqual([inferencePaths[0]]);
    expect(files.size).toBe(0);
  });
});
