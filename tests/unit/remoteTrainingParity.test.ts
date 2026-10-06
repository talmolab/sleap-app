import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { Labels, Video, loadSlp } from "@talmolab/sleap-io.js";
import {
  useTrainingStore,
  defaultHyperparams,
  mergeLogLines,
  normalizeLogLine,
  createLogFlusher,
} from "@/stores/trainingStore";
import type { ConfigFile } from "@/stores/trainingStore";
import type { JobResult, JobSpec } from "@/lib/sleapConnect";
import type { SubmitJobOptions, JobLogHandler } from "@/stores/connectStore";

// Remote training parity: worker job.log lines through the shared buffered
// log path, job.epoch/curve/metric routed per model into the training
// monitor, and post-training inference as a separate track job whose
// predictions wait for an explicit Fetch & Load.

function makeConfigFile(overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    filename: "test.yaml",
    content: "data_config: {}\nmodel_config: {}\ntrainer_config: {}\n",
    modelType: "centroid",
    slot: "centroid",
    hyperparams: { ...defaultHyperparams },
    originalHyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
    ...overrides,
  };
}

/** Puts the store into a running two-model (top-down) state without starting anything. */
function seedTwoModels() {
  useTrainingStore.getState().reset();
  const model = (label: string) => ({
    label,
    epoch: 0,
    maxEpochs: 10,
    loss: null,
    valLoss: null,
    bestValLoss: null,
    status: "pending" as const,
    epochSamples: [],
    batchSamples: [],
    epochSize: 1,
    lastBatchNumber: 0,
    metrics: { meanEpochTimeSec: null, etaNext10Min: null, epochsInPlateau: 0, inPlateau: false, bestValEpoch: null },
    epochStartedAt: null,
    plateauPatience: null,
    plateauMinDelta: null,
    runDir: null,
  });
  useTrainingStore.setState({
    status: "running",
    startedAt: Date.now(),
    models: [model("Centroid"), model("Centered Instance")],
    currentModelIndex: 0,
    log: [],
  });
}

// ── Log merge (pure) ────────────────────────────────────────────────────

describe("normalizeLogLine", () => {
  it("passes a plain line through with its progress flag", () => {
    expect(normalizeLogLine("hello")).toEqual({ line: "hello", progress: false });
    expect(normalizeLogLine("bar", true)).toEqual({ line: "bar", progress: true });
  });

  it("keeps the last non-empty \\r segment of an old worker's raw tqdm line, as progress", () => {
    expect(normalizeLogLine("Epoch 0: 10%\rEpoch 0: 50%\rEpoch 0: 90%\r")).toEqual({
      line: "Epoch 0: 90%",
      progress: true,
    });
  });
});

describe("mergeLogLines (remote progress semantics)", () => {
  it("a progress-flagged line replaces the previous progress line, even without a tqdm % bar", () => {
    const out = mergeLogLines(
      ["start"],
      [
        { line: "Training: step 1", progress: true },
        { line: "Training: step 2", progress: true },
        { line: "Training: step 3", progress: true },
      ],
    );
    expect(out.log).toEqual(["start", "Training: step 3"]);
    expect(out.progressTail).toBe("Training: step 3");
  });

  it("carries the progress tail across flushes", () => {
    const first = mergeLogLines([], [{ line: "step 1", progress: true }]);
    const second = mergeLogLines(first.log, [{ line: "step 2", progress: true }], first.progressTail);
    expect(second.log).toEqual(["step 2"]);
  });

  it("a normal line after a progress line appends, and ends the progress run", () => {
    const out = mergeLogLines(
      [],
      [
        { line: "step 1", progress: true },
        { line: "Validation done", progress: false },
        { line: "step 2", progress: true },
      ],
    );
    expect(out.log).toEqual(["step 1", "Validation done", "step 2"]);
  });

  it("does not replace a line appended by something else since the last progress line", () => {
    const first = mergeLogLines([], [{ line: "step 1", progress: true }]);
    const withMarker = [...first.log, "— Centroid completed"];
    const out = mergeLogLines(withMarker, [{ line: "step 1", progress: true }], first.progressTail);
    expect(out.log).toEqual(["step 1", "— Centroid completed", "step 1"]);
  });

  it("the worker's final (non-progress) tqdm bar still coalesces onto the throttled one", () => {
    const out = mergeLogLines(
      [],
      [
        { line: "Epoch 0:  40%|####      | 8/20", progress: true },
        { line: "Epoch 0: 100%|##########| 20/20", progress: false },
      ],
    );
    expect(out.log).toEqual(["Epoch 0: 100%|##########| 20/20"]);
  });
});

// ── Shared flusher ──────────────────────────────────────────────────────

describe("createLogFlusher", () => {
  beforeEach(() => seedTwoModels());

  it("buffers lines without touching the store, then applies them in ONE update per flush", () => {
    const { setState, getState } = useTrainingStore;
    const flusher = createLogFlusher(setState, getState, 60_000);
    let updates = 0;
    const unsub = useTrainingStore.subscribe(() => updates++);
    try {
      for (let i = 0; i < 50; i++) flusher.push(`Epoch 0: ${i}%|#| ${i}/50 [loss=0.5]`, true);
      flusher.push("plain line");
      flusher.push("\r\r"); // all-blank \r line: dropped
      expect(updates).toBe(0);
      expect(getState().log).toEqual([]);

      flusher.flush();
      expect(updates).toBe(1);
      expect(getState().log).toEqual(["Epoch 0: 49%|#| 49/50 [loss=0.5]", "plain line"]);
    } finally {
      unsub();
      flusher.stop();
    }
  });

  it("parses tqdm epoch/loss at flush time into the given model", () => {
    const { setState, getState } = useTrainingStore;
    const flusher = createLogFlusher(setState, getState, 60_000);
    flusher.push("Epoch 3:  50%|#####     | 10/20 [00:01<00:01, loss=0.123]", true);
    flusher.flush(1);
    flusher.stop();
    expect(getState().models[1].epoch).toBe(3);
    expect(getState().models[1].loss).toBe(0.123);
    expect(getState().models[0].epoch).toBe(0);
  });

  it("stop() drains the remaining buffer", () => {
    const { setState, getState } = useTrainingStore;
    const flusher = createLogFlusher(setState, getState, 60_000);
    flusher.push("last words");
    flusher.stop();
    expect(getState().log).toEqual(["last words"]);
  });
});

// ── Telemetry routing ───────────────────────────────────────────────────

describe("applyRemoteTelemetry", () => {
  beforeEach(() => seedTwoModels());

  it("job.epoch records an epoch on the given model only, like local epoch_end", () => {
    const s = useTrainingStore.getState();
    s.applyRemoteTelemetry(1, { kind: "epoch", epoch: 0, trainLoss: 0.9, valLoss: 0.8 });
    const [m0, m1] = useTrainingStore.getState().models;
    expect(m0.epochSamples).toEqual([]);
    expect(m1.epochSamples).toEqual([{ epoch: 0, trainLoss: 0.9, valLoss: 0.8 }]);
    expect(m1.epoch).toBe(1);
    expect(m1.bestValLoss).toBe(0.8);
  });

  it("job.curve REPLACES the model's batch samples (never appends)", () => {
    const s = useTrainingStore.getState();
    s.applyRemoteTelemetry(0, { kind: "curve", points: [{ x: 0, y: 1 }, { x: 1, y: 0.9 }] });
    s.applyRemoteTelemetry(0, { kind: "curve", points: [{ x: 0, y: 1 }, { x: 5, y: 0.5 }, { x: 9, y: 0.4 }] });
    const [m0, m1] = useTrainingStore.getState().models;
    expect(m0.batchSamples).toEqual([
      { globalBatch: 0, loss: 1 },
      { globalBatch: 5, loss: 0.5 },
      { globalBatch: 9, loss: 0.4 },
    ]);
    expect(m1.batchSamples).toEqual([]);
  });

  it("infers batches-per-epoch from the curve so epoch points land on the batch axis", () => {
    const s = useTrainingStore.getState();
    s.applyRemoteTelemetry(0, { kind: "curve", points: [{ x: 0, y: 1 }, { x: 19, y: 0.5 }] });
    s.applyRemoteTelemetry(0, { kind: "epoch", epoch: 0, trainLoss: 0.6, valLoss: 0.7 });
    expect(useTrainingStore.getState().models[0].epochSize).toBe(20);
  });

  it("curve/metric after an epoch stand in for epoch_begin (epochStartedAt)", () => {
    const s = useTrainingStore.getState();
    s.applyRemoteTelemetry(0, { kind: "epoch", epoch: 0, trainLoss: 0.6, valLoss: 0.7 });
    expect(useTrainingStore.getState().models[0].epochStartedAt).toBeNull();
    s.applyRemoteTelemetry(0, { kind: "curve", points: [{ x: 25, y: 0.5 }] });
    const m0 = useTrainingStore.getState().models[0];
    expect(m0.epochStartedAt).not.toBeNull();
    expect(m0.epoch).toBe(1);
  });

  it("job.metric sets the W&B link, total epochs and latest loss", () => {
    useTrainingStore.getState().applyRemoteTelemetry(1, {
      kind: "metric",
      epoch: 2,
      totalEpochs: 50,
      latestTrainLoss: 0.42,
      latestValLoss: 0.5,
      bestLoss: 0.4,
      wandbUrl: "https://wandb.ai/me/proj/runs/abc",
      etaSeconds: 120,
    });
    const st = useTrainingStore.getState();
    expect(st.wandbUrl).toBe("https://wandb.ai/me/proj/runs/abc");
    expect(st.models[1].maxEpochs).toBe(50);
    expect(st.models[1].loss).toBe(0.42);
    expect(st.models[0].maxEpochs).toBe(10);
  });
});

// ── startTraining (remote): end-to-end wiring with a fake connectStore ──

type SubmitCall = { spec: JobSpec; onLog: JobLogHandler; options?: SubmitJobOptions };
let submitCalls: SubmitCall[] = [];
/** Drives each submitted job; default plays a successful top-down run. */
let driveJob: (call: SubmitCall, n: number) => Promise<JobResult>;

/** Only consulted by "window"-mode tests; irrelevant (and left matching the
 * pre-PR3 empty default) for "worker-file", which never computes visibility. */
const MOUNT = "/worker-mounts";
const fakeWorkerMounts: Array<{ path: string }> = [{ path: MOUNT }];
/** What the next `statWorkerPath()` call resolves to; keyed by the exact path asked for. */
let fakeWorkerStats: Record<string, { exists: boolean; type?: "file" | "directory" }> = {};
vi.mock("@/stores/connectStore", () => ({
  useConnectStore: {
    getState: () => ({
      submitJob: async (spec: JobSpec, onLog: JobLogHandler, options?: SubmitJobOptions) => {
        const call = { spec, onLog, options };
        submitCalls.push(call);
        return driveJob(call, submitCalls.length - 1);
      },
      workerMounts: fakeWorkerMounts,
      statWorkerPath: async (path: string) => fakeWorkerStats[path] ?? { exists: false },
    }),
  },
  // Only exercised by "window"-mode tests — "worker-file" never calls it.
  pathRulesFor: () => [],
}));

let fakeLabels: Labels | null = null;
vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ labels: fakeLabels, projectPath: "/Users/me/project.slp", video: null, frameIdx: 0 }),
  },
}));
vi.mock("@/stores/confirmStore", () => ({ confirmDialog: async () => true }));

const mergeRemoteResultsMock = vi.fn(async (_pending: unknown) => {});
vi.mock("@/stores/inferenceStore", () => ({
  mergeRemoteResults: mergeRemoteResultsMock,
}));

const PREDICTIONS = { sha256: "deadbeef", size: 10 };

/** Plays a split top-down train spec (job 0 via onModelComplete, job 1 returned), then a track job. */
async function defaultDrive(call: SubmitCall, n: number): Promise<JobResult> {
  if (call.spec.type === "train") {
    const opts = call.options!;
    // job 0 (centroid)
    opts.onTelemetry?.({ kind: "epoch", epoch: 0, trainLoss: 1.0, valLoss: 0.9 }, 0);
    call.onLog("Epoch 0: 100%|##########| 20/20 [loss=0.5]", true);
    opts.onModelComplete?.({ jobId: "j0", success: true, modelDir: "/w/models/centroid", labelsPath: "/w/jobs/j0/labels.slp" });
    // job 1 (centered instance)
    opts.onTelemetry?.({ kind: "epoch", epoch: 0, trainLoss: 0.7, valLoss: 0.6 }, 1);
    opts.onTelemetry?.({ kind: "curve", points: [{ x: 0, y: 0.8 }, { x: 3, y: 0.7 }] }, 1);
    return { jobId: "j1", success: true, modelDir: "/w/models/centered_instance", labelsPath: "/w/jobs/j1/labels.slp" };
  }
  call.onLog("Predicting 5/5", false);
  return { jobId: `track${n}`, success: true, resultBlobs: { predictions: PREDICTIONS } };
}

function setUpTopDown(inferenceTarget = "suggestions") {
  useTrainingStore.getState().reset();
  useTrainingStore.getState().setConfig("modelType", "top_down");
  // Added in REVERSE pipeline order: the spec must still come out centroid-first.
  useTrainingStore.getState().addConfigFile(makeConfigFile({ slot: "centered_instance", modelType: "centered_instance" }));
  useTrainingStore.getState().addConfigFile(makeConfigFile({ slot: "centroid", modelType: "centroid" }));
  return {
    remote: true as const,
    workerId: "worker-1",
    labelsSource: "worker-file" as const,
    workerLabelsPath: "/local/labels.slp",
    inferenceTarget,
  };
}

describe("startTraining (remote) — telemetry + post-training inference", () => {
  beforeEach(() => {
    submitCalls = [];
    driveJob = defaultDrive;
    fakeLabels = new Labels({ videos: [], skeletons: [], labeledFrames: [] });
    mergeRemoteResultsMock.mockClear();
  });
  afterEach(() => {
    useTrainingStore.getState().reset();
  });

  it("never sends inference_target in the train spec, and orders configs by pipeline slot", async () => {
    await useTrainingStore.getState().startTraining(setUpTopDown());
    const train = submitCalls[0].spec as unknown as Record<string, unknown>;
    expect(train.type).toBe("train");
    expect("inference_target" in train).toBe(false);
    expect(train.model_types).toEqual(["centroid", "centered_instance"]);
  });

  it("routes job.epoch/job.curve to the model of the job that sent them", async () => {
    await useTrainingStore.getState().startTraining(setUpTopDown("nothing"));
    const [centroid, centered] = useTrainingStore.getState().models;
    expect(centroid.epochSamples).toEqual([{ epoch: 0, trainLoss: 1.0, valLoss: 0.9 }]);
    expect(centered.epochSamples).toEqual([{ epoch: 0, trainLoss: 0.7, valLoss: 0.6 }]);
    expect(centroid.batchSamples).toEqual([]);
    expect(centered.batchSamples).toEqual([
      { globalBatch: 0, loss: 0.8 },
      { globalBatch: 3, loss: 0.7 },
    ]);
    expect(useTrainingStore.getState().status).toBe("completed");
    // "nothing": no track job at all.
    expect(submitCalls).toHaveLength(1);
    expect(useTrainingStore.getState().postTrainingInference).toBeNull();
  });

  it("buffers worker log lines through the shared flush (progress line logged once)", async () => {
    await useTrainingStore.getState().startTraining(setUpTopDown("nothing"));
    const log = useTrainingStore.getState().log;
    expect(log.filter((l) => l.startsWith("Epoch 0: 100%"))).toHaveLength(1);
    expect(log.some((l) => l.startsWith("— Centroid completed"))).toBe(true);
  });

  it("submits ONE track job after all models train: model dirs in pipeline order, worker labels path, frame filter", async () => {
    await useTrainingStore.getState().startTraining(setUpTopDown("suggestions"));
    expect(submitCalls).toHaveLength(2);
    const track = submitCalls[1].spec;
    expect(track.type).toBe("track");
    if (track.type !== "track") throw new Error("unreachable");
    expect(track.model_paths).toEqual(["/w/models/centroid", "/w/models/centered_instance"]);
    expect(track.data_path).toBe("/w/jobs/j0/labels.slp");
    expect(track.frame_filter).toBe("suggested");
  });

  it("maps other inference targets to the track spec's frame filter", async () => {
    await useTrainingStore.getState().startTraining(setUpTopDown("user_labeled"));
    const track = submitCalls[1].spec as { frame_filter?: string };
    expect(track.frame_filter).toBe("user");
  });

  it("does NOT fetch/merge predictions automatically — waits for Fetch & Load", async () => {
    await useTrainingStore.getState().startTraining({ ...setUpTopDown("suggestions"), existingPredictions: "keep" });
    const st = useTrainingStore.getState();
    expect(st.status).toBe("completed");
    expect(st.postTrainingInference?.status).toBe("completed");
    expect(st.postTrainingInference?.pendingMerge).toEqual({
      results: [{ jobId: "track1", success: true, resultBlobs: { predictions: PREDICTIONS } }],
      mode: "keep",
      trackOnly: false,
    });
    expect(mergeRemoteResultsMock).not.toHaveBeenCalled();

    await st.fetchAndLoadPostTrainingPredictions();
    expect(mergeRemoteResultsMock).toHaveBeenCalledTimes(1);
    const after = useTrainingStore.getState().postTrainingInference;
    expect(after?.pendingMerge).toBeNull();
    expect(after?.merged).toBe(true);
  });

  it("keeps the pending merge for retry when Fetch & Load fails", async () => {
    await useTrainingStore.getState().startTraining(setUpTopDown("suggestions"));
    mergeRemoteResultsMock.mockImplementationOnce(async () => {
      throw new Error("connection dropped");
    });
    await useTrainingStore.getState().fetchAndLoadPostTrainingPredictions();
    const pti = useTrainingStore.getState().postTrainingInference;
    expect(pti?.pendingMerge).not.toBeNull();
    expect(pti?.message).toContain("connection dropped");
  });

  it("skips post-training inference (training still completes) when the worker reports no model_dir", async () => {
    driveJob = async (call) => {
      call.options?.onModelComplete?.({ jobId: "j0", success: true });
      return { jobId: "j1", success: true };
    };
    await useTrainingStore.getState().startTraining(setUpTopDown("suggestions"));
    expect(submitCalls).toHaveLength(1);
    const st = useTrainingStore.getState();
    expect(st.status).toBe("completed");
    expect(st.postTrainingInference?.status).toBe("skipped");
  });

  it("a failed track job is reported in the training UI state, not as a training failure", async () => {
    driveJob = async (call, n) =>
      call.spec.type === "track" ? { jobId: "t", success: false, error: "CUDA OOM" } : defaultDrive(call, n);
    await useTrainingStore.getState().startTraining(setUpTopDown("suggestions"));
    const st = useTrainingStore.getState();
    expect(st.status).toBe("completed");
    expect(st.postTrainingInference?.status).toBe("error");
    expect(st.postTrainingInference?.message).toContain("CUDA OOM");
  });

  it("'random' (all videos) samples one track job per non-empty video", async () => {
    fakeLabels = new Labels({
      videos: [
        new Video({ filename: "a.mp4", backendMetadata: { shape: [100, 8, 8, 1] }, openBackend: false }),
        new Video({ filename: "b.mp4", backendMetadata: { shape: [50, 8, 8, 1] }, openBackend: false }),
      ],
      skeletons: [],
      labeledFrames: [],
    });
    await useTrainingStore.getState().startTraining({ ...setUpTopDown("random"), sampleCount: 5 });
    const tracks = submitCalls.slice(1).map((c) => c.spec as { video_index?: number; frames?: string; model_paths: string[] });
    expect(tracks.map((t) => t.video_index)).toEqual([0, 1]);
    expect(tracks.every((t) => t.frames!.split(",").length === 5)).toBe(true);
    expect(useTrainingStore.getState().postTrainingInference?.pendingMerge?.results).toHaveLength(2);
  });
});

// ── startTraining (remote): labelsSource "window" vs "worker-file" ───────
//
// "window" exercises the REAL checkVideoVisibility/buildRemoteLabelsPayload
// pipeline (both pure, already unit-tested in remoteVisibility.test.ts /
// remoteLabelsPayload.test.ts) against real Labels/Video objects — only the
// transport boundary (connectStore's submitJob/statWorkerPath) is mocked,
// per this repo's "thin integration" test convention. A video "under the
// mount" with a configured `fakeWorkerStats` entry stands in for the
// worker's filesystem; `labeledFrames: []` throughout means an "embedded"
// hidden video never actually needs a working backend to encode (nothing to
// embed), so a bare placeholder object is enough to mark one "available".

function setUpSingleModel() {
  useTrainingStore.getState().reset();
  useTrainingStore.getState().setConfig("modelType", "single_animal");
  useTrainingStore.getState().addConfigFile(
    makeConfigFile({ slot: "config", modelType: "single_animal" }),
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Train job succeeds trivially; a track job returns one result blob. Single-model (no split), unlike defaultDrive. */
const singleModelDrive: typeof driveJob = async (call) => {
  if (call.spec.type === "train") {
    return { jobId: "j0", success: true, modelDir: "/w/models/m0", labelsPath: "/w/jobs/j0/labels.slp" };
  }
  call.onLog("Predicting", false);
  return { jobId: "track", success: true, resultBlobs: { predictions: PREDICTIONS } };
};

describe("startTraining (remote) — labelsSource window vs worker-file", () => {
  beforeEach(() => {
    submitCalls = [];
    driveJob = singleModelDrive;
    fakeWorkerStats = {};
    setUpSingleModel();
  });
  afterEach(() => {
    useTrainingStore.getState().reset();
  });

  it("window + all visible: labels_content set, no labels_path/path_mappings, project tag attached", async () => {
    fakeLabels = new Labels({
      videos: [new Video({ filename: `${MOUNT}/a.mp4`, openBackend: false })],
      skeletons: [],
      labeledFrames: [],
    });
    fakeWorkerStats[`${MOUNT}/a.mp4`] = { exists: true, type: "file" };

    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "window",
      inferenceTarget: "nothing",
    });

    expect(submitCalls).toHaveLength(1);
    const train = submitCalls[0].spec as unknown as Record<string, unknown>;
    expect(train.labels_content).toEqual(expect.any(String));
    expect(train.labels_path).toBeUndefined();
    expect(train.path_mappings).toBeUndefined();
    expect(train.project).toEqual({ name: "project.slp", id: expect.stringMatching(/^[0-9a-f]{8}$/) });

    // Prove it genuinely went through the "visible" re-pointing path (embed:
    // false) rather than merely happening to produce a truthy string some
    // other way — decode the payload and check the video was re-pointed.
    const reloaded = await loadSlp(base64ToBytes(train.labels_content as string), { openVideos: false });
    expect(reloaded.videos[0].filename).toBe(`${MOUNT}/a.mp4`);
  });

  it("some hidden: trains with embedded content, and restricts post-training inference to the visible video only", async () => {
    const visible = new Video({ filename: `${MOUNT}/visible.mp4`, openBackend: false });
    const hidden = new Video({ filename: `${MOUNT}/hidden.mp4`, openBackend: false });
    hidden.backend = {} as unknown as typeof hidden.backend; // has *a* backend — embeddable, not "unavailable"
    fakeLabels = new Labels({ videos: [visible, hidden], skeletons: [], labeledFrames: [] });
    fakeWorkerStats[`${MOUNT}/visible.mp4`] = { exists: true, type: "file" };
    fakeWorkerStats[`${MOUNT}/hidden.mp4`] = { exists: false };

    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "window",
      inferenceTarget: "suggestions",
    });

    expect(submitCalls).toHaveLength(2); // train + one restricted track job
    const train = submitCalls[0].spec as unknown as Record<string, unknown>;
    expect(train.labels_content).toEqual(expect.any(String));
    const track = submitCalls[1].spec;
    if (track.type !== "track") throw new Error("unreachable");
    expect(track.video_index).toBe(0); // the visible video only
    expect(track.project).toEqual(train.project as typeof track.project);
  });

  it("embedFramesToPredict + suggestions: covers every video, no restriction even with a hidden one", async () => {
    const visible = new Video({ filename: `${MOUNT}/visible.mp4`, openBackend: false });
    const hidden = new Video({ filename: `${MOUNT}/hidden.mp4`, openBackend: false });
    hidden.backend = {} as unknown as typeof hidden.backend;
    fakeLabels = new Labels({ videos: [visible, hidden], skeletons: [], labeledFrames: [] });
    fakeWorkerStats[`${MOUNT}/visible.mp4`] = { exists: true, type: "file" };
    fakeWorkerStats[`${MOUNT}/hidden.mp4`] = { exists: false };

    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "window",
      embedFramesToPredict: true,
      inferenceTarget: "suggestions",
    });

    expect(submitCalls).toHaveLength(2);
    const track = submitCalls[1].spec;
    if (track.type !== "track") throw new Error("unreachable");
    expect(track.video_index).toBeUndefined(); // unrestricted — covers every video server-side
  });

  it("none visible, no embed: post-training inference is skipped, no track job submitted", async () => {
    fakeLabels = new Labels({
      videos: [new Video({ filename: "/not-under-any-mount/a.mp4", openBackend: false })],
      skeletons: [],
      labeledFrames: [],
    });
    // No fakeWorkerStats entry needed — this path never even forms a worker candidate ("no-location").

    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "window",
      inferenceTarget: "suggestions",
    });

    expect(submitCalls).toHaveLength(1); // train only — no track job submitted at all
    const pti = useTrainingStore.getState().postTrainingInference;
    expect(pti?.status).toBe("skipped");
    expect(pti?.message).toBe("Videos aren't visible on the worker — inference skipped");
  });

  it("worker-file: labels_path only, no labels_content, project tag still attached", async () => {
    fakeLabels = new Labels({ videos: [], skeletons: [], labeledFrames: [] });

    await useTrainingStore.getState().startTraining({
      remote: true,
      workerId: "worker-1",
      labelsSource: "worker-file",
      workerLabelsPath: "/mnt/data/labels.slp",
      inferenceTarget: "nothing",
    });

    const train = submitCalls[0].spec as unknown as Record<string, unknown>;
    expect(train.labels_path).toBe("/mnt/data/labels.slp");
    expect(train.labels_content).toBeUndefined();
    expect(train.project).toEqual({ name: "project.slp", id: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it("never dispatches sleap:path-resolution (that dialog is gone from the training path)", async () => {
    fakeLabels = new Labels({
      videos: [new Video({ filename: `${MOUNT}/a.mp4`, openBackend: false })],
      skeletons: [],
      labeledFrames: [],
    });
    fakeWorkerStats[`${MOUNT}/a.mp4`] = { exists: true, type: "file" };
    const handler = vi.fn();
    const listener = () => handler();
    window.addEventListener("sleap:path-resolution", listener);
    try {
      await useTrainingStore.getState().startTraining({
        remote: true,
        workerId: "worker-1",
        labelsSource: "window",
        inferenceTarget: "nothing",
      });
      await useTrainingStore.getState().startTraining({
        remote: true,
        workerId: "worker-1",
        labelsSource: "worker-file",
        workerLabelsPath: "/mnt/data/labels.slp",
        inferenceTarget: "nothing",
      });
    } finally {
      window.removeEventListener("sleap:path-resolution", listener);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
