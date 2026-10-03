import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { Labels, Video } from "@talmolab/sleap-io.js";
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

vi.mock("@/stores/connectStore", () => ({
  useConnectStore: {
    getState: () => ({
      submitJob: async (spec: JobSpec, onLog: JobLogHandler, options?: SubmitJobOptions) => {
        const call = { spec, onLog, options };
        submitCalls.push(call);
        return driveJob(call, submitCalls.length - 1);
      },
      workerMounts: [],
    }),
  },
}));

let fakeLabels: Labels | null = null;
vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ labels: fakeLabels, projectPath: null, video: null, frameIdx: 0 }),
  },
}));
vi.mock("@/lib/labelsEmbed", () => ({
  serializeLabelsEmbedded: async () => new Uint8Array([1, 2, 3]),
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
    labelsPath: "/local/labels.slp",
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
    window.addEventListener(
      "sleap:path-resolution",
      (e: Event) => {
        const d = (e as CustomEvent).detail as {
          paths: Array<{ local: string }>;
          resolve: (p: Array<{ local: string; worker: string }>) => void;
        };
        d.resolve(d.paths.map((p) => ({ local: p.local, worker: `/w${p.local}` })));
      },
      { once: true },
    );
    await useTrainingStore.getState().startTraining({ ...setUpTopDown("random"), sampleCount: 5 });
    const tracks = submitCalls.slice(1).map((c) => c.spec as { video_index?: number; frames?: string; model_paths: string[] });
    expect(tracks.map((t) => t.video_index)).toEqual([0, 1]);
    expect(tracks.every((t) => t.frames!.split(",").length === 5)).toBe(true);
    expect(useTrainingStore.getState().postTrainingInference?.pendingMerge?.results).toHaveLength(2);
  });
});
