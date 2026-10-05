/**
 * PR5b §5b.2 — NewJobWizard: browse a worker-side `.slp` -> loadWorkerLabels
 * -> summary; a not-found video blocks Submit; each "start config from"
 * option seeds `configs`; the post-train-inference toggle adds
 * `post_inference` to the submitted spec; Submit calls `submitJobsOn`
 * exactly once with `source: "worker-file"` and no `labels_content`; and —
 * the separate-copy guarantee — `useTrainingStore`'s own config is
 * untouched by a full wizard flow, including editing hyperparameters via
 * the real `TrainingConfigDialog` in its controlled mode (PR5a.5).
 *
 * `RemoteFileBrowser`/`workerLabels` are mocked (per this repo's `vi.mock`
 * convention — not hoisted, so the module under test is imported
 * dynamically AFTER the mocks are registered); `TrainingConfigDialog` is
 * the REAL component (same `@/lib/platform`/`ModelStatsPreview`/DOM-polyfill
 * setup as trainingConfigDialogControlledMode.test.tsx) so the isolation
 * test actually exercises PR5a.5's controlled-mode wiring end to end.
 * `seedFromJobSpec`/`buildLauncherTrainSpec` (launcherSpec.ts) are REAL and
 * pure — already unit-tested in launcherSpec.test.ts — so "past job" seeding
 * and the submitted spec's shape are driven by real job-spec data here
 * rather than re-mocked. The `RemoteFileBrowser` mock renders its stand-in
 * button through the real shadcn `Dialog` (same as the production component,
 * post-fix) rather than as a plain, non-portaled sibling — a real nested
 * `Dialog.Root` registers itself in Radix's own hide-others exception list,
 * so NewJobWizard's own (real, open) Dialog never marks it `aria-hidden`,
 * unlike a bare mocked element would.
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useConnectStore } from "@/stores/connectStore";
import { useTrainingStore, type ConfigFile } from "@/stores/trainingStore";
import type { WorkerClient, JobStatus, JobSummary } from "@/lib/protocolV1/client";
import type { WorkerFileVideoCheck } from "@/lib/workerLabels";
import type { JobSpec, TrainJobSpec, TrackJobSpec } from "@/lib/sleapConnect";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("@/components/dialogs/ModelStatsPreview", () => ({
  ModelStatsPreview: () => null,
}));

const SLP_PATH = "/root/vast/exp1/flies.slp";
const YAML_PATH = "/root/vast/configs/centroid.yaml";
const MODEL_DIR_PATH = "/root/vast/models/manual";

vi.mock("@/components/dialogs/RemoteFileBrowser", () => ({
  // Minimal stand-in: picks a fixed path per fileFilter/mode rather than
  // driving the real worker-filesystem browser UI (that component's own
  // behavior — including its per-worker browsing added in PR5b.1, and
  // directory mode for the Inference flow's "Browse model folder" — is
  // covered by its own tests, remoteFileBrowser.test.tsx). Rendered through
  // the real shadcn `Dialog`, matching the production component (post-fix) —
  // a real nested `Dialog.Root` registers with Radix's own hide-others
  // exceptions, so NewJobWizard's own (real, open) Dialog never hides it,
  // unlike a bare mocked element would.
  RemoteFileBrowser: (props: {
    open: boolean;
    onClose: () => void;
    onSelect: (path: string) => void;
    mode?: "directory" | "file";
    fileFilter?: string | string[];
  }) => {
    if (!props.open) return null;
    const filter = Array.isArray(props.fileFilter) ? props.fileFilter[0] : props.fileFilter;
    const isModelDir = props.mode === "directory";
    const path = isModelDir ? MODEL_DIR_PATH : filter === ".yaml" ? YAML_PATH : SLP_PATH;
    const label = isModelDir ? "model folder" : filter;
    return (
      <Dialog open onOpenChange={(next) => { if (!next) props.onClose(); }}>
        <DialogContent>
          <DialogTitle className="sr-only">Browse Worker Filesystem</DialogTitle>
          {/* The real RemoteFileBrowser closes itself on selection (its own
              `handleSelect` calls `onSelect` then `onClose`) — mirror that so
              the mock doesn't leave a modal open over the rest of the wizard. */}
          <button
            onClick={() => {
              props.onSelect(path);
              props.onClose();
            }}
          >
            Pick {label}
          </button>
        </DialogContent>
      </Dialog>
    );
  },
}));

// --- mutable mock outputs (reset in beforeEach) -----------------------------
let loadWorkerLabelsResult: Labels | null = null;
let checkWorkerFileVideosResult: WorkerFileVideoCheck[] = [];

const loadWorkerLabelsMock = vi.fn(async () => loadWorkerLabelsResult as Labels);
const checkWorkerFileVideosMock = vi.fn(async () => checkWorkerFileVideosResult);
vi.mock("@/lib/workerLabels", () => ({
  loadWorkerLabels: loadWorkerLabelsMock,
  checkWorkerFileVideos: checkWorkerFileVideosMock,
}));

const { NewJobWizard } = await import("@/components/connect/NewJobWizard");

const WORKER_ID = "node-a";
const WORKER_LABEL = "gpu-box";

/** A worker-side `.slp`'s parsed structure — one video, one labeled frame, matching trainingConfigDialogControlledMode.test.tsx's own fixture shape. */
function makeWorkerLabels(videoPath = "/mnt/data/worker-video.mp4"): Labels {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "worker-skeleton" });
  const video = new Video({
    filename: videoPath,
    backendMetadata: { shape: [5, 480, 640, 3] },
    openBackend: false,
  });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  lf.instances.push(inst);
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
}

function foundCheck(path: string): WorkerFileVideoCheck[] {
  return [{ index: 0, path, embedded: false, found: true }];
}
function notFoundCheck(path: string): WorkerFileVideoCheck[] {
  return [{ index: 0, path, embedded: false, found: false }];
}

function jobSummary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    jobId: "past_job_1",
    state: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    queuePosition: null,
    kind: "train",
    modelTypes: ["single_instance"],
    labelsPath: "/w/past/flies.slp",
    ...overrides,
  };
}

function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    jobId: "past_job_1",
    state: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:05:00.000Z",
    result: { model_dir: "/w/models/single" },
    error: null,
    queuePosition: null,
    kind: "train",
    modelTypes: ["single_instance"],
    labelsPath: "/w/past/flies.slp",
    spec: { config_contents: ["max_epochs: 50\n"], model_types: ["single_instance"] },
    ...overrides,
  };
}

/** Every path `fakeClient().fsRead` was called for — lets the "YAML on worker" test confirm `readWholeWorkerFile` actually ran, without needing to drive the Model Type `<Select>` (a Radix combobox; this repo has no established pattern for picking a specific option in tests). */
let fsReadCalls: string[] = [];

/** A fake WorkerClient whose only real behavior is `fsRead` (for the "YAML on worker" start option) — `loadWorkerLabels`/`checkWorkerFileVideos` are mocked above and never touch it for real. */
function fakeClient(yamlText = "max_epochs: 50\n"): WorkerClient {
  const bytes = new TextEncoder().encode(yamlText);
  return {
    fsRead: async (path: string) => {
      fsReadCalls.push(path);
      return {
        path,
        content: bytes,
        offset: 0,
        size: bytes.length,
        totalSize: bytes.length,
        eof: true,
      };
    },
  } as unknown as WorkerClient;
}

interface SubmitCall {
  workerId: string;
  spec: JobSpec;
  opts: { source: "window" | "worker-file" };
}
let submitCalls: SubmitCall[] = [];
// A plain async function, not `vi.fn(...)` — the bun-test `vi.fn` shim widens
// the impl to `(...args: never[]) => unknown`, which doesn't satisfy
// connectStore's typed `submitJobsOn` signature on `setState` (see
// saveInPlaceRouting.test.ts's own doc on this). Calls are tracked via
// `submitCalls` directly instead of `.mock.calls`/`.toHaveBeenCalledTimes`.
async function submitJobsOnMock(workerId: string, spec: JobSpec, opts: { source: "window" | "worker-file" }) {
  submitCalls.push({ workerId, spec, opts });
  return ["new-job-1"];
}

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS === "undefined") g.CSS = { escape: (s) => s };
  else if (!g.CSS.escape) g.CSS.escape = (s) => s;
});

afterEach(() => {
  cleanup();
  loadWorkerLabelsMock.mockClear();
  checkWorkerFileVideosMock.mockClear();
});

beforeEach(() => {
  loadWorkerLabelsResult = makeWorkerLabels();
  checkWorkerFileVideosResult = foundCheck("/mnt/data/worker-video.mp4");
  submitCalls = [];
  fsReadCalls = [];
  useConnectStore.setState({
    clientFor: async () => fakeClient(),
    listJobs: async () => [],
    jobDetail: async () => {
      throw new Error("jobDetail not stubbed for this test");
    },
    mountsFor: async () => [],
    submitJobsOn: submitJobsOnMock,
  });
});

function renderWizard(seed: Parameters<typeof NewJobWizard>[0]["seed"] = null) {
  return render(
    <NewJobWizard workerId={WORKER_ID} workerLabel={WORKER_LABEL} seed={seed} onClose={() => {}} />,
  );
}

async function loadViaBrowse() {
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  const pickButton = await screen.findByRole("button", { name: /Pick \.slp/ });
  fireEvent.click(pickButton);
  await waitFor(() => expect(screen.getByText(SLP_PATH)).toBeInTheDocument());
}

/** The job-type toggle at the top of the wizard — "Labels (on <worker>)" stays the same section either way. */
function switchToInference() {
  fireEvent.click(screen.getByRole("button", { name: "Inference" }));
}

describe("NewJobWizard — browse -> loadWorkerLabels -> summary", () => {
  it("shows skeleton/video/frame counts after picking a worker-side .slp", async () => {
    renderWizard();
    await loadViaBrowse();

    expect(screen.getByText(/worker-skeleton · 1 video · 1 labeled frame/)).toBeInTheDocument();
    expect(loadWorkerLabelsMock).toHaveBeenCalledTimes(1);
    expect(checkWorkerFileVideosMock).toHaveBeenCalledTimes(1);
  });
});

describe("NewJobWizard — missing videos block Submit", () => {
  it("shows the not-found warning and disables Add to queue", async () => {
    checkWorkerFileVideosResult = notFoundCheck("/mnt/data/worker-video.mp4");
    renderWizard();
    await loadViaBrowse();

    await waitFor(() =>
      expect(screen.getByText(/1 of 1 video not found on gpu-box: worker-video\.mp4/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Add to queue" })).toBeDisabled();
  });

  it("enables Add to queue once every video is found", async () => {
    renderWizard();
    await loadViaBrowse();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled());
  });
});

describe("NewJobWizard — start config from", () => {
  it("'a past job on this worker' seeds model type + configs from the run's own spec", async () => {
    useConnectStore.setState({
      listJobs: async () => [jobSummary()],
      jobDetail: async (workerId: string, jobId: string) => {
        expect(workerId).toBe(WORKER_ID);
        expect(jobId).toBe("past_job_1");
        return jobStatus();
      },
    });
    renderWizard();

    const pastButton = await screen.findByRole("button", { name: "Past job: Train single_instance" });
    fireEvent.click(pastButton);

    // seedFromJobSpec resolves model_types:["single_instance"] -> "single_animal"
    // (1 slot) and parses the one config_contents entry -> 1 ConfigFile; the
    // seeded labelsPath auto-loads via the (mocked) loadWorkerLabels.
    await waitFor(() => expect(screen.getByText("/w/past/flies.slp")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText(/Single Animal · 1 config\b/)).toBeInTheDocument(),
    );
  });

  it("'YAML on the worker' reads it via fs.read + parseYamlConfig and fills the current model type's first slot", async () => {
    renderWizard();
    await loadViaBrowse();
    // Default model type (Top-Down) auto-seeds both slots with defaults on
    // mount — picking a YAML replaces only the first slot (centroid)'s
    // config; the second slot's default is untouched, so configsReady (and
    // the config count) are unaffected. Driving the Model Type `<Select>` to
    // a 1-slot pipeline isn't needed to prove the YAML path works: this repo
    // has no established pattern for selecting a specific Radix Select
    // option in tests, so this asserts the fs.read call happened instead of
    // the resulting config count, which wouldn't change either way.
    await waitFor(() => expect(screen.getByText(/Top-Down · 2 configs/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /YAML on gpu-box…/ }));
    const pickYamlButton = await screen.findByRole("button", { name: /Pick \.yaml/ });
    fireEvent.click(pickYamlButton);

    await waitFor(() => expect(fsReadCalls).toContain(YAML_PATH));
    expect(screen.getByText(/Top-Down · 2 configs/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled();
  });

  it("'defaults' auto-populates every slot's baseline config with no user action", async () => {
    renderWizard();
    await loadViaBrowse();
    // Default model type is Top-Down (2 slots: centroid + centered_instance) —
    // defaultConfigsFor seeds both on mount since startFrom starts as "defaults".
    await waitFor(() => expect(screen.getByText(/Top-Down · 2 configs/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled();
  });
});

describe("NewJobWizard — Edit hyperparameters needs a labels file first", () => {
  it("is disabled with a hint before any labels are loaded, even though defaults already filled every slot", async () => {
    renderWizard();
    // defaultConfigsFor runs on mount regardless of whether labels are
    // loaded, so configsReady is already true here — Edit hyperparameters
    // must stay disabled on labels alone, or it opens TrainingConfigDialog
    // in a state with no labels (the dialog only renders when `labels` is
    // set — see the wizard's own doc on configDialogOpen && labels).
    expect(screen.getByRole("button", { name: "Edit hyperparameters…" })).toBeDisabled();
    expect(screen.getByText("Pick a labels file first")).toBeInTheDocument();
  });

  it("enables once labels load, and opens the real TrainingConfigDialog on top", async () => {
    renderWizard();
    await loadViaBrowse();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit hyperparameters…" })).not.toBeDisabled());
    expect(screen.queryByText("Pick a labels file first")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit hyperparameters…" }));
    await waitFor(() => expect(document.getElementById("pipeline-type")).toBeTruthy());
  });
});

describe("NewJobWizard — post-train inference toggle", () => {
  it("adds post_inference to the submitted spec when enabled", async () => {
    renderWizard();
    await loadViaBrowse();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("checkbox", { name: /Run inference after training/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const spec = submitCalls[0]!.spec as TrainJobSpec;
    expect(spec.post_inference).toBeDefined();
    expect(spec.post_inference!.length).toBeGreaterThan(0);
  });

  it("omits post_inference when left off", async () => {
    renderWizard();
    await loadViaBrowse();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const spec = submitCalls[0]!.spec as TrainJobSpec;
    expect(spec.post_inference).toBeUndefined();
  });
});

describe("NewJobWizard — Submit", () => {
  it("calls submitJobsOn exactly once with source worker-file and no labels_content", async () => {
    renderWizard();
    await loadViaBrowse();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const call = submitCalls[0]!;
    expect(call.workerId).toBe(WORKER_ID);
    expect(call.opts).toEqual({ source: "worker-file" });
    const spec = call.spec as TrainJobSpec;
    expect(spec.labels_path).toBe(SLP_PATH);
    expect("labels_content" in spec).toBe(false);
  });
});

describe("NewJobWizard — separate-copy guarantee", () => {
  it("never touches useTrainingStore's config, even through Edit hyperparameters edits", async () => {
    const sentinelConfigs: ConfigFile[] = [
      {
        filename: "project-config.yaml",
        content: "",
        modelType: "single_instance",
        slot: "config",
        hyperparams: useTrainingStore.getState().config.configs[0]?.hyperparams ?? ({} as never),
        originalHyperparams: {} as never,
        hasTrainedModel: false,
        checkpointPath: null,
      },
    ];
    useTrainingStore.setState((s) => ({ config: { ...s.config, configs: sentinelConfigs } }));

    renderWizard();
    await loadViaBrowse();
    await waitFor(() => expect(screen.getByText(/Top-Down · 2 configs/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit hyperparameters…" }));
    await waitFor(() => expect(document.getElementById("pipeline-type")).toBeTruthy());

    // Switch to the first head tab and edit a hyperparameter through the
    // REAL TrainingConfigDialog, in its controlled mode (PR5a.5) — this is
    // the edit that must land in the wizard's own local configs, never in
    // useTrainingStore.
    const tabs = screen.getAllByRole("tab");
    fireEvent.pointerDown(tabs[1]!, { button: 0 });
    fireEvent.mouseDown(tabs[1]!, { button: 0 });
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const epochsContainer = document.getElementById("field-maxepochs")!;
    const epochsInput = epochsContainer.querySelector("input[type='number']") as HTMLInputElement;
    fireEvent.change(epochsInput, { target: { value: "77" } });

    expect(useTrainingStore.getState().config.configs).toBe(sentinelConfigs);

    useTrainingStore.setState((s) => ({ config: { ...s.config, configs: [] } }));
  });
});

describe("NewJobWizard — Inference: Models step", () => {
  it("lists a job without `run` as its own one-job run, and excludes a run with a still-running sibling", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        // No `run` at all -> its own run (jobId key) -> offered.
        jobSummary({ jobId: "a1", modelTypes: ["single_instance"] }),
        // A split top-down run where one sibling is still running -> excluded
        // entirely (buildRunInferenceSpecs needs every sibling's model dir).
        jobSummary({ jobId: "b1", run: { id: "runB", index: 0, count: 2 }, modelTypes: ["centroid"] }),
        jobSummary({
          jobId: "b2",
          run: { id: "runB", index: 1, count: 2 },
          state: "running",
          modelTypes: ["centered_instance"],
        }),
      ],
    });
    renderWizard();
    switchToInference();

    await waitFor(() => expect(screen.getByRole("button", { name: /^single_instance/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /centroid/ })).not.toBeInTheDocument();
  });

  it("fetches a chosen run's model dirs in run.index order and uses them to build the submitted track spec", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        // Listed out of run.index order on purpose — the Models button's
        // label and the submitted model_paths must still come out b1, b2.
        jobSummary({ jobId: "b2", run: { id: "runB", index: 1, count: 2 }, modelTypes: ["centered_instance"] }),
        jobSummary({ jobId: "b1", run: { id: "runB", index: 0, count: 2 }, modelTypes: ["centroid"] }),
      ],
      jobDetail: async (_workerId: string, jobId: string) =>
        jobStatus({
          jobId,
          modelTypes: [jobId === "b1" ? "centroid" : "centered_instance"],
          result: { model_dir: jobId === "b1" ? "/w/models/centroid" : "/w/models/centered_instance" },
        }),
    });
    renderWizard();
    switchToInference();
    await loadViaBrowse();

    const runButton = await screen.findByRole("button", { name: /^centroid \+ centered_instance/ });
    fireEvent.click(runButton);
    await waitFor(() => expect(screen.getByText("/w/models/centroid")).toBeInTheDocument());
    expect(screen.getByText("/w/models/centered_instance")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const spec = submitCalls[0]!.spec as TrackJobSpec;
    expect(spec.model_paths).toEqual(["/w/models/centroid", "/w/models/centered_instance"]);
  });

  it("'Browse model folder on <worker>…' adds a manually picked folder to the list", async () => {
    renderWizard();
    switchToInference();
    await loadViaBrowse();

    fireEvent.click(screen.getByRole("button", { name: /Browse model folder on gpu-box…/ }));
    const pickButton = await screen.findByRole("button", { name: /Pick model folder/ });
    fireEvent.click(pickButton);

    await waitFor(() => expect(screen.getByText(MODEL_DIR_PATH)).toBeInTheDocument());
  });
});

describe("NewJobWizard — Inference: Submit", () => {
  it("blocks submit when a video is missing, even with a model dir already chosen", async () => {
    checkWorkerFileVideosResult = notFoundCheck("/mnt/data/worker-video.mp4");
    renderWizard();
    switchToInference();
    await loadViaBrowse();

    fireEvent.click(screen.getByRole("button", { name: /Browse model folder on gpu-box…/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Pick model folder/ }));
    await waitFor(() => expect(screen.getByText(MODEL_DIR_PATH)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Add to queue" })).toBeDisabled();
  });

  it("submits a standalone track job from a manually browsed model dir, source worker-file", async () => {
    renderWizard();
    switchToInference();
    await loadViaBrowse();

    fireEvent.click(screen.getByRole("button", { name: /Browse model folder on gpu-box…/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Pick model folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to queue" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const call = submitCalls[0]!;
    expect(call.workerId).toBe(WORKER_ID);
    expect(call.opts).toEqual({ source: "worker-file" });
    const spec = call.spec as TrackJobSpec;
    expect(spec.type).toBe("track");
    expect(spec.data_path).toBe(SLP_PATH);
    expect(spec.model_paths).toEqual([MODEL_DIR_PATH]);
  });
});
