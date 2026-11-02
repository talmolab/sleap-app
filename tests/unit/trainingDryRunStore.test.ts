/**
 * The Training panel's dry run (`startDryRun`): each config the model type
 * trains goes through `sleap-nn train --dry-run`, with the config a real run
 * would use, and its result lands in `dryRun` without touching the training
 * `status`. `runTraining` is faked with sleap-nn's real output lines.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessEvent } from "@/platform/backend";

type RunTrainingArgs = [string, string, string, (e: ProcessEvent) => void, string?, boolean?];
type FakeRun = { lines: string[]; stderr?: string[]; success: boolean };

let script: FakeRun[] = [];
const runTrainingMock = vi.fn(async (...args: RunTrainingArgs) => {
  const run = script.shift() ?? { lines: [], success: false };
  for (const line of run.lines) args[3]({ event: "stdout", data: { line } });
  for (const line of run.stderr ?? []) args[3]({ event: "stderr", data: { line } });
  return { success: run.success, command: "", modelPath: "" };
});
const cancelCommandMock = vi.fn(async () => {});

vi.mock("@/platform", () => ({ isTauri: true, getPlatform: async () => ({}) }));
vi.mock("@/platform/backend", () => ({
  runTraining: runTrainingMock,
  cancelCommand: cancelCommandMock,
}));

const PASSED = (modelType: string) => [
  "2026-11-02 11:53:53 | Dry run passed: setup, one training batch and one validation batch all ran. Nothing was written to disk.",
  `  Model type:          ${modelType}`,
  "  Steps per epoch:     200 train, 1 val",
];
const UNSUPPORTED = ["│ No such option '--dry-run'.                                                  │"];

let useTrainingStore: typeof import("@/stores/trainingStore").useTrainingStore;
let useAppStore: typeof import("@/stores/appStore").useAppStore;

const profile = (name: string) =>
  readFileSync(join(import.meta.dir, `../../src/assets/training_profiles/${name}`), "utf8");

function loadTopDown() {
  const s = useTrainingStore.getState();
  s.setConfig("modelType", "top_down");
  s.addConfigFile(s.parseYamlConfig(profile("baseline_medium_rf.centroid.yaml"), "c.yaml", "centroid")!);
  s.addConfigFile(
    s.parseYamlConfig(profile("baseline_medium_rf.topdown.yaml"), "ci.yaml", "centered_instance")!,
  );
}

const call = (i: number) => runTrainingMock.mock.calls[i] as unknown as RunTrainingArgs;

beforeAll(async () => {
  ({ useTrainingStore } = await import("@/stores/trainingStore"));
  ({ useAppStore } = await import("@/stores/appStore"));
});

beforeEach(() => {
  useTrainingStore.setState(useTrainingStore.getInitialState());
  useAppStore.setState({ projectPath: "/data/flies.slp" });
  runTrainingMock.mockClear();
  cancelCommandMock.mockClear();
  script = [];
  loadTopDown();
});

describe("startDryRun", () => {
  it("dry-runs every head with the labels and the --dry-run flag, and reports each summary", async () => {
    script = [
      { lines: PASSED("centroid"), success: true },
      { lines: PASSED("centered_instance"), success: true },
    ];
    await useTrainingStore.getState().startDryRun();

    expect(runTrainingMock).toHaveBeenCalledTimes(2);
    for (const i of [0, 1]) {
      expect(call(i)[1]).toBe("/data/flies.slp");
      // Next to the labels, like a real run: the summary names that folder.
      expect(call(i)[4]).toBe("/data/models");
      expect(call(i)[5]).toBe(true);
    }
    // The YAML is the one a real run writes (ZMQ block materialized, etc.).
    expect(call(0)[0]).toContain("controller_port: 9000");

    const { dryRun, status } = useTrainingStore.getState();
    expect(dryRun!.status).toBe("passed");
    expect(dryRun!.models.map((m) => [m.label, m.status])).toEqual([
      ["Centroid", "passed"],
      ["Centered Instance", "passed"],
    ]);
    expect(dryRun!.models[1].summary![0]).toEqual({ label: "Model type", value: "centered_instance" });
    expect(dryRun!.log.some((l) => l.includes("Dry run passed"))).toBe(true);
    // A dry run is not a training run.
    expect(status).toBe("idle");
  });

  it("keeps checking the other head after one fails, and shows the cause", async () => {
    script = [
      { lines: [], stderr: ["Traceback (most recent call last):", "ValueError: crop_size must be positive"], success: false },
      { lines: PASSED("centered_instance"), success: true },
    ];
    await useTrainingStore.getState().startDryRun();

    const { dryRun } = useTrainingStore.getState();
    expect(dryRun!.status).toBe("failed");
    expect(dryRun!.models[0]).toMatchObject({ status: "failed", error: "ValueError: crop_size must be positive" });
    expect(dryRun!.models[1].status).toBe("passed");
  });

  it("fails a run that exits cleanly without the passed summary", async () => {
    script = [
      { lines: ["2026-11-02 | Training canceled"], success: true },
      { lines: PASSED("centered_instance"), success: true },
    ];
    await useTrainingStore.getState().startDryRun();
    expect(useTrainingStore.getState().dryRun!.models[0].status).toBe("failed");
  });

  it("stops and says so when the installed sleap-nn has no --dry-run", async () => {
    script = [{ lines: UNSUPPORTED, success: false }];
    await useTrainingStore.getState().startDryRun();

    const { dryRun } = useTrainingStore.getState();
    expect(dryRun!.status).toBe("unsupported");
    expect(runTrainingMock).toHaveBeenCalledTimes(1);
    expect(dryRun!.models[1].status).toBe("pending");
  });

  it("fails without running sleap-nn when there's no labels file", async () => {
    useAppStore.setState({ projectPath: null });
    await useTrainingStore.getState().startDryRun();

    expect(runTrainingMock).not.toHaveBeenCalled();
    expect(useTrainingStore.getState().dryRun!.models[0].error).toBe("No training labels file selected");
  });

  it("records the config it checked", async () => {
    script = [
      { lines: PASSED("centroid"), success: true },
      { lines: PASSED("centered_instance"), success: true },
    ];
    const before = useTrainingStore.getState().config;
    await useTrainingStore.getState().startDryRun();
    expect(useTrainingStore.getState().dryRun!.config).toBe(before);
  });

  it("does nothing while training runs", async () => {
    useTrainingStore.setState({ status: "running" });
    await useTrainingStore.getState().startDryRun();
    expect(runTrainingMock).not.toHaveBeenCalled();
    expect(useTrainingStore.getState().dryRun).toBeNull();
  });
});

describe("cancelDryRun", () => {
  it("kills the run and keeps its late results out", async () => {
    let finish!: () => void;
    runTrainingMock.mockImplementationOnce(async (...args: RunTrainingArgs) => {
      await new Promise<void>((r) => (finish = r));
      for (const line of PASSED("centroid")) args[3]({ event: "stdout", data: { line } });
      return { success: true, command: "", modelPath: "" };
    });
    const done = useTrainingStore.getState().startDryRun();
    for (let t = 0; t < 200 && runTrainingMock.mock.calls.length === 0; t++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runTrainingMock).toHaveBeenCalledTimes(1);

    await useTrainingStore.getState().cancelDryRun();
    expect(cancelCommandMock).toHaveBeenCalledTimes(1);
    finish();
    await done;

    const { dryRun } = useTrainingStore.getState();
    expect(dryRun!.status).toBe("cancelled");
    expect(dryRun!.models[0].status).not.toBe("passed");
    expect(runTrainingMock).toHaveBeenCalledTimes(1);
  });
});

describe("training and the dry run", () => {
  it("Start Training does nothing during a dry run", async () => {
    useTrainingStore.setState({
      dryRun: { id: -1, status: "running", models: [], log: [], config: useTrainingStore.getState().config },
    });
    await useTrainingStore.getState().startTraining();
    expect(useTrainingStore.getState().status).toBe("idle");
  });

  it("reset clears the last dry run", () => {
    useTrainingStore.setState({
      dryRun: { id: -1, status: "passed", models: [], log: [], config: useTrainingStore.getState().config },
    });
    useTrainingStore.getState().reset();
    expect(useTrainingStore.getState().dryRun).toBeNull();
  });
});
