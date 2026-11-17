/**
 * Cancelling a LOCAL training run. Cancel kills the sleap-nn subprocess, so the
 * run exits non-zero — the training loop used to read that as a failure:
 * "Centroid — failed at epoch 2", the stderr tail behind "Copy error output",
 * and the cancel message replaced by "Training failed for centroid". A Cancel
 * between the two models of a top-down run also went on to start the second.
 * `runTraining` is faked: a run streams some output, then blocks until the
 * fake `cancelCommand` kills it (or exits on its own, for the failure case).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessEvent } from "@/platform/backend";

type RunTrainingArgs = [string, string, string, (e: ProcessEvent) => void, string?];

/** What the next fake run does: wait to be killed, or exit by itself. */
let behavior: "untilKilled" | "fail" | "succeed" = "untilKilled";
let kill: (() => void) | null = null;
let started: (() => void) | null = null;

/** Fake disk: folders that exist, and what got deleted. */
const dirs = new Set<string>();
const removedDirs: string[] = [];
let lastRunDir = "";

const runTrainingMock = vi.fn(async (...args: RunTrainingArgs) => {
  // sleap-nn creates <ckpt_dir>/<run_name> when it starts.
  lastRunDir = `${args[4]}/${args[2]}`;
  dirs.add(lastRunDir);
  const onEvent = args[3];
  onEvent({ event: "stdout", data: { line: "Epoch 2/100" } });
  onEvent({ event: "stderr", data: { line: "UserWarning: something noisy" } });
  started?.();
  if (behavior === "succeed") return { success: true, command: "", modelPath: "/data/models/run" };
  if (behavior === "fail") {
    onEvent({ event: "stderr", data: { line: "RuntimeError: CUDA out of memory" } });
    return { success: false, command: "", modelPath: "" };
  }
  // A killed process: sleap-nn exits non-zero, after the kill lands.
  await new Promise<void>((resolve) => (kill = resolve));
  return { success: false, command: "", modelPath: "" };
});
const cancelCommandMock = vi.fn(async () => {
  kill?.();
  kill = null;
});

vi.mock("@/platform", () => ({ isTauri: true, getPlatform: async () => ({}) }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (p: string) => dirs.has(p),
  remove: async (p: string) => {
    removedDirs.push(p);
    dirs.delete(p);
  },
}));
vi.mock("@/platform/backend", () => ({
  runTraining: runTrainingMock,
  cancelCommand: cancelCommandMock,
  startZmqRelay: async () => {},
  stopZmqRelay: async () => {},
  startProgressRelay: async () => {},
  stopProgressRelay: async () => {},
  listenTrainingProgress: async () => () => {},
}));

let useTrainingStore: typeof import("@/stores/trainingStore").useTrainingStore;
let useAppStore: typeof import("@/stores/appStore").useAppStore;
let TRAINING_CANCELLED: string;

const profile = (name: string) =>
  readFileSync(join(import.meta.dir, `../../src/assets/training_profiles/${name}`), "utf8");

/** Resolves once the fake run for the current model has started. */
const runStarted = () => new Promise<void>((r) => (started = r));

beforeAll(async () => {
  ({ useTrainingStore, TRAINING_CANCELLED } = await import("@/stores/trainingStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
});

beforeEach(() => {
  useTrainingStore.setState(useTrainingStore.getInitialState());
  useAppStore.setState({ projectPath: "/data/flies.slp", hasChanges: false, labels: null });
  runTrainingMock.mockClear();
  cancelCommandMock.mockClear();
  behavior = "untilKilled";
  kill = null;
  dirs.clear();
  removedDirs.length = 0;
  lastRunDir = "";
  const s = useTrainingStore.getState();
  s.setConfig("modelType", "top_down");
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!);
});

describe("cancelling local top-down training", () => {
  it("reports the cancel, not a failure, and doesn't start the second model", async () => {
    const running = runStarted();
    const training = useTrainingStore.getState().startTraining({});
    await running;

    await useTrainingStore.getState().cancelTraining();
    await training;

    const s = useTrainingStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe(TRAINING_CANCELLED);
    expect(s.models.map((m) => m.status)).toEqual(["cancelled", "pending"]);
    // No stderr behind "Copy error output" for a cancel.
    expect(s.stderrTail).toEqual([]);
    // Only the centroid model ran.
    expect(runTrainingMock).toHaveBeenCalledTimes(1);
  });

  it("a Cancel between the two models stops before the second one starts", async () => {
    behavior = "succeed";
    const running = runStarted();
    const training = useTrainingStore.getState().startTraining({});
    await running;
    // Centroid has finished (nothing left to kill) when Cancel lands.
    await useTrainingStore.getState().cancelTraining();
    await training;

    const s = useTrainingStore.getState();
    expect(s.error).toBe(TRAINING_CANCELLED);
    expect(s.status).toBe("error");
    expect(runTrainingMock).toHaveBeenCalledTimes(1);
  });

  it("a real failure is still reported as one", async () => {
    behavior = "fail";
    await useTrainingStore.getState().startTraining({});

    const s = useTrainingStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toContain("Training failed for centroid");
    expect(s.error).toContain("CUDA out of memory");
    expect(s.models[0].status).toBe("failed");
    // A failed run keeps its folder (only Cancel deletes it, as PyQt).
    expect(removedDirs).toEqual([]);
  });
});

// PyQt SLEAP deletes the cancelled model's run folder ("Deleting canceled run
// data", runners.py run_gui_training); models that finished keep theirs.
describe("cancelled run folder", () => {
  it("deletes the cancelled model's run folder", async () => {
    const running = runStarted();
    const training = useTrainingStore.getState().startTraining({});
    await running;
    await useTrainingStore.getState().cancelTraining();
    await training;

    expect(lastRunDir).toMatch(/^\/data\/models\/.+centroid/);
    expect(removedDirs).toEqual([lastRunDir]);
    expect(useTrainingStore.getState().log.some((l) => l.includes("Deleted the cancelled run's folder"))).toBe(true);
  });

  it("never deletes a folder that existed before the run (a reused run name)", async () => {
    // The run name is resolved inside startTraining; make every name "exist" up front.
    const realHas = dirs.has.bind(dirs);
    dirs.has = (p: string) => p.startsWith("/data/models/") || realHas(p);
    try {
      const running = runStarted();
      const training = useTrainingStore.getState().startTraining({});
      await running;
      await useTrainingStore.getState().cancelTraining();
      await training;
    } finally {
      dirs.has = realHas;
    }
    expect(removedDirs).toEqual([]);
  });
});
