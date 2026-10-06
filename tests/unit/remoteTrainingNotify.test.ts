/**
 * PR3b §3b.5 — remote training finish/failure notifications, via
 * `@/lib/notify` (not sonner directly) so they also land in the
 * notification bell. Needs its own file (rather than extending
 * remoteTrainingParity.test.ts): trainingStore dynamically imports
 * `@/lib/notify` inside `startTraining`'s remote branch specifically so it
 * CAN be mocked this way (see tests/bun-test.ts's `vi.mock` hoisting
 * caveat — a module mocked after another file already imported it statically
 * never takes effect for that import).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { Labels } from "@talmolab/sleap-io.js";
import { defaultHyperparams } from "@/stores/trainingStore";
import type { ConfigFile } from "@/stores/trainingStore";
import type { JobResult, JobSpec } from "@/lib/sleapConnect";
import type { SubmitJobOptions, JobLogHandler } from "@/stores/connectStore";

type SubmitCall = { spec: JobSpec; onLog: JobLogHandler; options?: SubmitJobOptions };
let submitCalls: SubmitCall[] = [];
let driveJob: (call: SubmitCall) => Promise<JobResult>;

const defaultDrive: typeof driveJob = async (call) => {
  if (call.spec.type === "train") {
    return { jobId: "j0", success: true, modelDir: "/w/models/m0", labelsPath: "/w/jobs/j0/labels.slp" };
  }
  return { jobId: "track", success: true, resultBlobs: { predictions: { sha256: "a", size: 1 } } };
};

vi.mock("@/stores/connectStore", () => ({
  useConnectStore: {
    getState: () => ({
      submitJob: async (spec: JobSpec, onLog: JobLogHandler, options?: SubmitJobOptions) => {
        const call = { spec, onLog, options };
        submitCalls.push(call);
        return driveJob(call);
      },
      workerMounts: [],
      statWorkerPath: async () => ({ exists: false }),
      pairedWorkers: [{ nodeId: "worker-1", label: "GPU Box", addrs: [], pairedAt: "2024-01-01" }],
    }),
  },
  pathRulesFor: () => [],
}));

let fakeLabels: Labels | null = null;
vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ labels: fakeLabels, projectPath: "/Users/me/project.slp", video: null, frameIdx: 0 }),
  },
}));
vi.mock("@/stores/confirmStore", () => ({ confirmDialog: async () => true }));

const toastMock = { success: vi.fn(), error: vi.fn() };
vi.mock("@/lib/notify", () => ({ toast: toastMock }));

/** `vi.fn()`'s `.mock.calls` entries type as `never[]` under this repo's
 * bun-test shim (not generic over the impl passed to `vi.fn`) — cast to what
 * `toast.success`/`toast.error` are actually called with. */
interface ToastCallArgs {
  description?: string;
  action?: { label: string; onClick: () => void };
}
function lastCall(fn: typeof toastMock.success): [string, ToastCallArgs] {
  return fn.mock.calls.at(-1) as unknown as [string, ToastCallArgs];
}

const { useTrainingStore } = await import("@/stores/trainingStore");

function makeConfigFile(overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    filename: "test.yaml",
    content: "data_config: {}\nmodel_config: {}\ntrainer_config: {}\n",
    modelType: "single_animal",
    slot: "config",
    hyperparams: { ...defaultHyperparams },
    originalHyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
    ...overrides,
  };
}

function setUp() {
  useTrainingStore.getState().reset();
  useTrainingStore.getState().setConfig("modelType", "single_animal");
  useTrainingStore.getState().addConfigFile(makeConfigFile());
}

describe("remote training finish/failure notifications", () => {
  beforeEach(() => {
    submitCalls = [];
    driveJob = defaultDrive;
    fakeLabels = new Labels({ videos: [], skeletons: [], labeledFrames: [] });
    toastMock.success.mockClear();
    toastMock.error.mockClear();
    setUp();
  });
  afterEach(() => {
    useTrainingStore.getState().reset();
  });

  it("toasts success naming the worker, with a Fetch & Load action when predictions are pending", async () => {
    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "worker-file",
      workerLabelsPath: "/l.slp",
      inferenceTarget: "suggestions",
    });
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [title, opts] = lastCall(toastMock.success);
    expect(title).toContain("GPU Box");
    expect(opts.action).toBeDefined();
    expect(opts.action?.label).toBe("Fetch & Load");
  });

  it("toasts success with no action when there's nothing pending to fetch", async () => {
    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "worker-file",
      workerLabelsPath: "/l.slp",
      inferenceTarget: "nothing",
    });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(lastCall(toastMock.success)[1].action).toBeUndefined();
  });

  it("toasts error, naming the worker, when the training job itself fails", async () => {
    driveJob = async () => ({ jobId: "j0", success: false, error: "CUDA OOM" });
    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "worker-file",
      workerLabelsPath: "/l.slp",
    });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const [title, opts] = lastCall(toastMock.error);
    expect(title).toContain("GPU Box");
    expect(opts.description).toContain("CUDA OOM");
  });

  it("toasts error on a transport/submit failure (thrown, not a job result)", async () => {
    driveJob = async () => {
      throw new Error("connection dropped");
    };
    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "worker-file",
      workerLabelsPath: "/l.slp",
    });
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(lastCall(toastMock.error)[1].description).toContain("connection dropped");
  });

  it("does not toast for a local (non-remote) run", async () => {
    await useTrainingStore.getState().startTraining({ inferenceTarget: "nothing" });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
