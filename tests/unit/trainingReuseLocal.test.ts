/**
 * "Use a trained model" on a LOCAL run (PyQt's per-tab "Reuse model (don't
 * retrain)"): a reused stage is never trained, and its model goes into
 * post-training inference with the newly trained one, in pipeline order.
 * `runTraining` / `runInference` are faked and record what they were given.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessEvent } from "@/platform/backend";
import type { InferenceConfig } from "@/stores/inferenceStore";

type RunTrainingArgs = [string, string, string, (e: ProcessEvent) => void, string?];

const runTrainingMock = vi.fn(async (...args: RunTrainingArgs) => ({
  success: true,
  command: "",
  modelPath: `${args[4]}/${args[2]}`,
}));
const inferenceCalls: InferenceConfig[] = [];
const runInferenceMock = vi.fn(async (cfg: InferenceConfig) => {
  inferenceCalls.push(cfg);
  // Not merged: this test only checks which models inference was given.
  return { success: false, command: "", outputPath: "" };
});

vi.mock("@/platform", () => ({ isTauri: true, getPlatform: async () => ({}) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async () => false, remove: async () => {} }));
vi.mock("@/platform/backend", () => ({
  runTraining: runTrainingMock,
  runInference: runInferenceMock,
  cancelCommand: async () => {},
  startZmqRelay: async () => {},
  stopZmqRelay: async () => {},
  startProgressRelay: async () => {},
  stopProgressRelay: async () => {},
  listenTrainingProgress: async () => () => {},
}));

// Post-training inference imports these for merging; with inference faked to
// fail they're never used, and the real ones pull in the whole backend.
vi.mock("@/lib/slpRead", () => ({ loadSlp: async () => ({}) }));
vi.mock("@/commands", () => ({ commandContext: { execute: async () => {} } }));
vi.mock("@/commands/editCommands", () => ({ MergePredictions: {} }));

let useTrainingStore: typeof import("@/stores/trainingStore").useTrainingStore;
let useAppStore: typeof import("@/stores/appStore").useAppStore;

const profile = (name: string) =>
  readFileSync(join(import.meta.dir, `../../src/assets/training_profiles/${name}`), "utf8");

const REUSED_CENTROID = "/data/models/250101_120000.centroid.n=40";

beforeAll(async () => {
  ({ useTrainingStore } = await import("@/stores/trainingStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
});

beforeEach(() => {
  useTrainingStore.setState(useTrainingStore.getInitialState());
  useAppStore.setState({ projectPath: "/data/flies.slp", hasChanges: false, labels: null });
  runTrainingMock.mockClear();
  runInferenceMock.mockClear();
  inferenceCalls.length = 0;
  const s = useTrainingStore.getState();
  s.setConfig("modelType", "top_down");
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!);
});

const reuseCentroid = () =>
  useTrainingStore.getState().setConfigReuse("centroid", {
    model: { path: REUSED_CENTROID, runName: "250101_120000.centroid.n=40", headKey: "centroid", nodeNames: null },
  });

describe("reusing a trained model for one stage (local)", () => {
  // The reused stage must not start a sleap-nn training run.
  it("trains only the stage that isn't reused", async () => {
    reuseCentroid();
    await useTrainingStore.getState().startTraining({});
    expect(runTrainingMock).toHaveBeenCalledTimes(1);
    expect(String(runTrainingMock.mock.calls[0][2])).toContain("centered_instance");
    const s = useTrainingStore.getState();
    expect(s.status).toBe("completed");
    expect(s.models.map((m) => m.label)).toEqual(["Centered Instance"]);
    // The log says which model stands in for the skipped stage.
    expect(s.log.some((l) => l.includes("Using trained model for Centroid") && l.includes(REUSED_CENTROID))).toBe(true);
  });

  // Post-training inference needs the whole pipeline: reused centroid first, then the new model.
  it("runs post-training inference with the reused model and the new one, in pipeline order", async () => {
    reuseCentroid();
    await useTrainingStore.getState().startTraining({ inferenceTarget: "suggestions" });
    expect(inferenceCalls).toHaveLength(1);
    const [centroid, centered] = inferenceCalls[0].modelPaths;
    expect(centroid).toBe(REUSED_CENTROID);
    expect(centered).toContain("centered_instance");
    expect(inferenceCalls[0].pipeline).toBe("top-down");
    // "Trained models" lists only what this run actually trained.
    expect(useTrainingStore.getState().modelOutputDirs).toEqual([centered]);
  });

  // Reusing the second stage keeps it second in the model list.
  it("keeps a reused second stage in its place", async () => {
    useTrainingStore.getState().setConfigReuse("centered_instance", {
      model: { path: "/data/models/old.ci", runName: null, headKey: "centered_instance", nodeNames: null },
    });
    await useTrainingStore.getState().startTraining({ inferenceTarget: "suggestions" });
    expect(runTrainingMock).toHaveBeenCalledTimes(1);
    expect(inferenceCalls[0].modelPaths[0]).toContain("centroid");
    expect(inferenceCalls[0].modelPaths[1]).toBe("/data/models/old.ci");
  });

  // Like PyQt, every stage may be reused locally: nothing trains, inference still runs.
  it("with every stage reused, trains nothing and still runs inference", async () => {
    reuseCentroid();
    useTrainingStore.getState().setConfigReuse("centered_instance", {
      model: { path: "/data/models/old.ci", runName: null, headKey: "centered_instance", nodeNames: null },
    });
    await useTrainingStore.getState().startTraining({ inferenceTarget: "suggestions" });
    expect(runTrainingMock).not.toHaveBeenCalled();
    expect(inferenceCalls[0].modelPaths).toEqual([REUSED_CENTROID, "/data/models/old.ci"]);
    expect(useTrainingStore.getState().status).toBe("completed");
  });

  // A checked box with no model picked is refused before anything runs.
  it("refuses a reused stage with no model picked", async () => {
    useTrainingStore.getState().setConfigReuse("centroid", { model: null });
    await useTrainingStore.getState().startTraining({});
    expect(runTrainingMock).not.toHaveBeenCalled();
    const s = useTrainingStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("Pick a trained model for Centroid");
  });

  // Unchecking puts the stage back into training.
  it("unchecking the box trains the stage again", async () => {
    reuseCentroid();
    useTrainingStore.getState().setConfigReuse("centroid", null);
    await useTrainingStore.getState().startTraining({});
    expect(runTrainingMock).toHaveBeenCalledTimes(2);
  });
});
