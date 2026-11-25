/**
 * Local training's live epoch losses and run folder, with `runTraining` faked
 * and sleap-nn's ZMQ progress messages replayed in the order sleap-nn 0.3.5
 * sends them (captured from a real 3-epoch run):
 *  - epoch_end goes out before the LightningModule logs the epoch's
 *    `train/loss`, so epoch_end N carries epoch N-1's `train/loss` (none in
 *    epoch 0) and `loss` is only the last batch's;
 *  - a run name whose folder already holds a best.ckpt makes sleap-nn train
 *    into `<name>-1` without reporting it.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessEvent } from "@/platform/backend";

type RunTrainingArgs = [string, string, string, (e: ProcessEvent) => void, string?];

let sendProgress: ((msg: string) => void) | null = null;
const send = (msg: object) => sendProgress!(JSON.stringify(msg));

/** One epoch as sleap-nn 0.3.5 publishes it. */
function replayEpoch(epoch: number, batchLosses: number[], valLoss: number, previousTrainLoss?: number) {
  send({ event: "epoch_begin", epoch });
  batchLosses.forEach((loss, batch) => {
    const logs: Record<string, number> = { loss };
    if (previousTrainLoss !== undefined) logs["train/loss"] = previousTrainLoss;
    send({ event: "batch_end", epoch, batch, logs });
  });
  const logs: Record<string, number> = { loss: batchLosses[batchLosses.length - 1], "val/loss": valLoss };
  if (previousTrainLoss !== undefined) logs["train/loss"] = previousTrainLoss;
  send({ event: "epoch_end", epoch, logs });
}

/** Fake disk: paths that exist. */
let existing: (path: string) => boolean = () => false;

const runTrainingMock = vi.fn(async (...args: RunTrainingArgs) => {
  // sleap-nn's own train/loss is the batch mean; it differs from ours only in
  // float rounding, so offset it slightly to tell the two apart.
  replayEpoch(0, [0.03, 0.01], 0.5);
  replayEpoch(1, [0.012, 0.008], 0.4, 0.0200001);
  replayEpoch(2, [0.006, 0.004], 0.3, 0.0100001);
  return { success: true, command: "", modelPath: `${args[4]}/${args[2]}` };
});

vi.mock("@/platform", () => ({ isTauri: true, getPlatform: async () => ({}) }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (p: string) => existing(p),
  remove: async () => {},
}));
vi.mock("@/platform/backend", () => ({
  runTraining: runTrainingMock,
  cancelCommand: async () => {},
  startZmqRelay: async () => {},
  stopZmqRelay: async () => {},
  startProgressRelay: async () => {},
  stopProgressRelay: async () => {},
  listenTrainingProgress: async (cb: (msg: string) => void) => {
    sendProgress = cb;
    return () => {};
  },
}));

let useTrainingStore: typeof import("@/stores/trainingStore").useTrainingStore;
let resolveLocalRunName: typeof import("@/stores/trainingStore").resolveLocalRunName;
let useAppStore: typeof import("@/stores/appStore").useAppStore;
let lossCsv: typeof import("@/lib/trainingMetrics").lossCsv;

const profile = (name: string) =>
  readFileSync(join(import.meta.dir, `../../src/assets/training_profiles/${name}`), "utf8");

beforeAll(async () => {
  ({ useTrainingStore, resolveLocalRunName } = await import("@/stores/trainingStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
  ({ lossCsv } = await import("@/lib/trainingMetrics"));
});

beforeEach(() => {
  useTrainingStore.setState(useTrainingStore.getInitialState());
  useAppStore.setState({ projectPath: "/data/flies.slp", hasChanges: false, labels: null });
  runTrainingMock.mockClear();
  existing = () => false;
  const s = useTrainingStore.getState();
  s.setConfig("modelType", "top_down");
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!);
});

describe("live per-epoch train loss", () => {
  it("puts each epoch's train loss on that epoch, not the one after", async () => {
    await useTrainingStore.getState().startTraining({});

    const s = useTrainingStore.getState();
    expect(s.status).toBe("completed");
    for (const model of s.models) {
      expect(model.epochSamples.map((e) => e.epoch)).toEqual([0, 1, 2]);
      const train = model.epochSamples.map((e) => e.trainLoss!);
      // Epochs 0 and 1: sleap-nn's own value, delivered one epoch late.
      expect(train[0]).toBe(0.0200001);
      expect(train[1]).toBe(0.0100001);
      // The last epoch never gets one: the mean of its batch losses.
      expect(train[2]).toBeCloseTo(0.005, 12);
      expect(model.epochSamples.map((e) => e.valLoss)).toEqual([0.5, 0.4, 0.3]);
      expect(model.loss).toBeCloseTo(0.005, 12);
      expect(lossCsv(model.epochSamples).split("\n")[1]).toBe("1,0.0200001,0.5");
    }
  });
});

describe("reusing a run name that already holds a trained model", () => {
  const finished = (p: string) =>
    /^\/data\/models\/[^/]+$/.test(p) || /^\/data\/models\/[^/]+\/best\.ckpt$/.test(p);

  it("trains into <name>-1 and points the run folder and model paths at it", async () => {
    existing = (p) => finished(p) && !/-\d+(\/best\.ckpt)?$/.test(p);
    await useTrainingStore.getState().startTraining({});

    const runNames = runTrainingMock.mock.calls.map((c) => (c as unknown as RunTrainingArgs)[2]);
    expect(runNames).toHaveLength(2);
    for (const name of runNames) expect(name).toMatch(/-1$/);
    const s = useTrainingStore.getState();
    expect(s.models.map((m) => m.runDir)).toEqual(runNames.map((n) => `/data/models/${n}`));
    expect(s.modelOutputDirs).toEqual(runNames.map((n) => `/data/models/${n}`));
    expect(s.log.some((l) => l.includes("already holds a trained model"))).toBe(true);
  });

  it("follows sleap-nn's rule: best.ckpt decides, then the first free suffix", async () => {
    const disk = new Set([
      "/m/done", "/m/done/best.ckpt", "/m/done-1", "/m/done-2",
      "/m/crashed",
    ]);
    const exists = async (p: string) => disk.has(p);
    expect(await resolveLocalRunName("/m", "fresh", exists)).toBe("fresh");
    expect(await resolveLocalRunName("/m", "crashed", exists)).toBe("crashed");
    expect(await resolveLocalRunName("/m", "done", exists)).toBe("done-3");
  });
});
