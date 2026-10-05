/**
 * PR4b §4b.4 / PR5b §5b.3 — WorkerJobs: pinning/sorting (this project first,
 * then newest), run tags, queue text, status chips, and action visibility
 * per job state — now including PR5b's widened Fetch & Load (every
 * completed track job, not just this project's own) and "Run again" (seeds
 * the launcher wizard from a failed run's own config). Remote inference no
 * longer has a per-row action here (moved to `NewJobWizard`'s "+ New job" ->
 * Inference flow — see that file's own tests). `sonner` is mocked per this
 * repo's `vi.mock` convention — not hoisted, so the module under test is
 * imported dynamically AFTER the mocks are registered.
 *
 * `MergePredictionsDialog` and `NewJobWizard` are mocked out entirely: their
 * own compatibility-check / wizard-form logic gets its own dedicated test
 * files (mergePredictionsDialog.test.tsx, newJobWizard.test.tsx) — this file
 * only verifies WorkerJobs opens them with the right props.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import { projectTag } from "@/lib/projectTag";
import type { JobSummary, JobStatus, WorkerClient } from "@/lib/protocolV1/client";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/components/connect/MergePredictionsDialog", () => ({
  MergePredictionsDialog: (props: { workerId: string; jobId: string; mine: boolean }) => (
    <div data-testid="merge-predictions-dialog">
      {props.workerId}:{props.jobId}:{String(props.mine)}
    </div>
  ),
}));

const seedWizardFromRunMock = vi.fn(
  async (): Promise<{ labelsPath: string; modelType: string; configs: unknown[] } | null> => ({
    labelsPath: "/root/vast/exp1/flies.slp",
    modelType: "top_down",
    configs: [],
  }),
);
vi.mock("@/components/connect/NewJobWizard", () => ({
  NewJobWizard: (props: { workerId: string; seed: unknown }) => (
    <div data-testid="new-job-wizard">
      {props.workerId}:{JSON.stringify(props.seed)}
    </div>
  ),
  seedWizardFromRun: seedWizardFromRunMock,
}));

const {
  WorkerJobs,
  isMineJob,
  sortWorkerJobs,
  jobTitle,
  jobStatusChip,
  isManagedJob,
  siblingJobIds,
  groupJobs,
  jobMatches,
} = await import("@/components/connect/WorkerJobs");

const WORKER_ID = "node-a";
const MY_PROJECT_PATH = "/Users/x/labels.v003.slp";
const myProject = projectTag(MY_PROJECT_PATH);

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    jobId: "job_1",
    state: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    queuePosition: null,
    kind: "train",
    modelTypes: ["centroid"],
    labelsPath: "/root/vast/exp1/flies.slp",
    project: myProject,
    ...overrides,
  };
}

// No fake timers in this repo — a no-op interval so WorkerJobs' poll never
// actually fires during these tests.
const noopSetInterval = () => "noop-handle";
const noopClearInterval = () => {};

afterEach(() => {
  cleanup();
  seedWizardFromRunMock.mockClear();
});

beforeEach(() => {
  useAppStore.setState({ projectPath: MY_PROJECT_PATH });
  useConnectStore.setState({
    selectedWorkerId: WORKER_ID,
    trackedJobs: [],
    listJobs: async () => [],
    jobDetail: async () => {
      throw new Error("jobDetail not stubbed for this test");
    },
    cancelJobOn: async () => {},
    connectToWorker: async () => {},
    clientFor: async () => ({}) as unknown as WorkerClient,
    submitJobsOn: async () => [],
  });
});

describe("isMineJob / sortWorkerJobs (pure logic)", () => {
  it("matches a job whose project id equals the open project's", () => {
    expect(isMineJob(job(), myProject.id)).toBe(true);
    expect(isMineJob(job({ project: { id: "other", name: "x" } }), myProject.id)).toBe(false);
  });

  it("pins this project's jobs first, newest first within each group", () => {
    const mineOld = job({ jobId: "mine-old", createdAt: "2026-10-01T00:00:00.000Z" });
    const mineNew = job({ jobId: "mine-new", createdAt: "2026-10-03T00:00:00.000Z" });
    const otherNew = job({
      jobId: "other-new",
      createdAt: "2026-10-04T00:00:00.000Z",
      project: { id: "other", name: "x" },
    });
    const sorted = sortWorkerJobs([mineOld, otherNew, mineNew], myProject.id);
    expect(sorted.map((j) => j.jobId)).toEqual(["mine-new", "mine-old", "other-new"]);
  });
});

describe("jobTitle / jobStatusChip (pure logic)", () => {
  it("titles a track job 'Inference' and a train job by its model type", () => {
    expect(jobTitle(job({ kind: "track" }))).toBe("Inference");
    expect(jobTitle(job({ kind: "train", modelTypes: ["centered_instance"] }))).toBe(
      "Train centered_instance",
    );
  });

  it("shows 'Queued · #N' for a queued job with a known position", () => {
    expect(jobStatusChip(job({ state: "queued", queuePosition: 2 })).text).toBe("Queued · #2");
  });

  it("falls back to the capitalized state otherwise", () => {
    expect(jobStatusChip(job({ state: "completed" })).text).toBe("Completed");
  });
});

describe("groupJobs (pure logic)", () => {
  it("groups a split training run's siblings under one key, ordered by run.index", () => {
    const centeredInstance = job({
      jobId: "b",
      modelTypes: ["centered_instance"],
      run: { id: "r1", index: 1, count: 2 },
    });
    const centroid = job({ jobId: "a", run: { id: "r1", index: 0, count: 2 } });
    const groups = groupJobs([centeredInstance, centroid], myProject.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("r1");
    expect(groups[0]!.jobs.map((j) => j.jobId)).toEqual(["a", "b"]);
    expect(groups[0]!.title).toBe("Top-down training run");
  });

  it("groups a chained inference job (same run.id, run.stage: 'inference') after its training job", () => {
    const train = job({ jobId: "train1", run: { id: "r1", index: 0, count: 1 } });
    const infer = job({
      jobId: "infer1",
      kind: "track",
      run: { id: "r1", index: 0, count: 1, stage: "inference" },
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const groups = groupJobs([infer, train], myProject.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.jobs.map((j) => j.jobId)).toEqual(["train1", "infer1"]);
    expect(groups[0]!.title).toBe("Training run (centroid)");
  });

  it("groups a job with no run at all alone, keyed by its own jobId", () => {
    const a = job({ jobId: "a" });
    const b = job({ jobId: "b", createdAt: "2026-10-02T00:00:00.000Z" });
    const groups = groupJobs([a, b], myProject.id);
    expect(groups.map((g) => g.key)).toEqual(["b", "a"]);
  });

  it("an inference-only group (no train job) titles 'Inference'", () => {
    const groups = groupJobs([job({ kind: "track" })], myProject.id);
    expect(groups[0]!.title).toBe("Inference");
  });

  it("rolls up status: running beats failed beats queued beats completed", () => {
    const run = (id: string, index: number, count: number, state: string) =>
      job({ jobId: `${id}-${index}`, run: { id, index, count }, state });

    expect(groupJobs([run("r1", 0, 2, "running"), run("r1", 1, 2, "failed")], myProject.id)[0]!.status).toBe(
      "running",
    );
    expect(groupJobs([run("r2", 0, 2, "queued"), run("r2", 1, 2, "failed")], myProject.id)[0]!.status).toBe(
      "failed",
    );
    expect(groupJobs([run("r3", 0, 2, "completed"), run("r3", 1, 2, "queued")], myProject.id)[0]!.status).toBe(
      "queued",
    );
    expect(groupJobs([run("r4", 0, 1, "completed")], myProject.id)[0]!.status).toBe("completed");
  });

  it("sorts groups this project first, then newest first — same rule as sortWorkerJobs", () => {
    const mineOld = job({ jobId: "mine-old", createdAt: "2026-10-01T00:00:00.000Z" });
    const otherNew = job({
      jobId: "other-new",
      createdAt: "2026-10-03T00:00:00.000Z",
      project: { id: "other", name: "x" },
    });
    const mineNew = job({ jobId: "mine-new", createdAt: "2026-10-02T00:00:00.000Z" });
    const groups = groupJobs([mineOld, otherNew, mineNew], myProject.id);
    expect(groups.map((g) => g.key)).toEqual(["mine-new", "mine-old", "other-new"]);
  });

  it("titles a split run '<types joined> · <timestamp>' once a model_name is known (sleap-connect #98)", () => {
    const centroid = job({
      jobId: "a",
      run: { id: "r1", index: 0, count: 2 },
      modelName: "260922_015758.centroid.n=1",
    });
    const centeredInstance = job({
      jobId: "b",
      modelTypes: ["centered_instance"],
      run: { id: "r1", index: 1, count: 2 },
      modelName: "260922_015758.centered_instance.n=1",
    });
    const groups = groupJobs([centroid, centeredInstance], myProject.id);
    expect(groups[0]!.title).toBe("centroid + centered_instance · 260922_015758");
  });

  it("falls back to the pre-#98 title when no job in the group has a model name yet", () => {
    const centroid = job({ jobId: "a", run: { id: "r1", index: 0, count: 2 } });
    const centeredInstance = job({
      jobId: "b",
      modelTypes: ["centered_instance"],
      run: { id: "r1", index: 1, count: 2 },
    });
    const groups = groupJobs([centroid, centeredInstance], myProject.id);
    expect(groups[0]!.title).toBe("Top-down training run");
  });
});

describe("jobMatches (pure logic)", () => {
  it("matches the labels path, its basename, job id, run id, model type, and project name — case-insensitively", () => {
    const j = job({
      jobId: "job_abc123",
      labelsPath: "/root/vast/exp1/flies.v002.slp",
      run: { id: "run-xyz", index: 0, count: 1 },
      modelTypes: ["centered_instance"],
      project: { id: "p1", name: "FliesProject" },
    });
    expect(jobMatches(j, "FLIES.V002")).toBe(true);
    expect(jobMatches(j, "/root/vast")).toBe(true);
    expect(jobMatches(j, "job_abc")).toBe(true);
    expect(jobMatches(j, "run-xyz")).toBe(true);
    expect(jobMatches(j, "centered_instance")).toBe(true);
    expect(jobMatches(j, "fliesproject")).toBe(true);
    expect(jobMatches(j, "nope")).toBe(false);
  });

  it("an empty or blank query matches everything", () => {
    expect(jobMatches(job(), "")).toBe(true);
    expect(jobMatches(job(), "   ")).toBe(true);
  });

  it("matches a job's model name (sleap-connect #98) — case-insensitively", () => {
    const j = job({ modelName: "260922_015758.centroid.n=1" });
    expect(jobMatches(j, "260922_015758")).toBe(true);
    expect(jobMatches(j, "CENTROID.N=1")).toBe(true);
  });
});

describe("WorkerJobs rendering", () => {
  it("fetches jobs for the given worker on mount and renders them, newest/mine first", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "other", createdAt: "2026-10-01T00:00:00.000Z", project: { id: "other", name: "x" } }),
        job({ jobId: "mine", createdAt: "2026-10-02T00:00:00.000Z" }),
      ],
    });
    render(
      <WorkerJobs
        workerId={WORKER_ID}
        setIntervalImpl={noopSetInterval}
        clearIntervalImpl={noopClearInterval}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("Train centroid").length).toBe(2));
    const stars = screen.getAllByText("★");
    expect(stars).toHaveLength(1); // only the pinned ("mine") job gets a star
  });

  it("shows a run tag when run.count > 1", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ run: { id: "r1", index: 1, count: 2 } })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText(/run 2\/2/)).toBeInTheDocument());
  });

  it("shows the failure's first log line for a failed job", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ state: "failed", error: "CUDA out of memory\nexit code 1" })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("CUDA out of memory")).toBeInTheDocument());
    expect(screen.queryByText(/exit code 1/)).not.toBeInTheDocument();
  });

  it("a running job owned by this project shows Watch live, Logs, and Stop — not Fetch & Load", async () => {
    useConnectStore.setState({ listJobs: async () => [job({ state: "running" })] });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Watch live" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Logs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fetch & Load/ })).not.toBeInTheDocument();
  });

  it("a queued job owned by this project shows Cancel, not Stop/Watch live", async () => {
    useConnectStore.setState({ listJobs: async () => [job({ state: "queued", queuePosition: 1 })] });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Watch live" })).not.toBeInTheDocument();
  });

  it("a completed track job owned by this project shows View and Fetch & Load", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ state: "completed", kind: "track" })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Fetch & Load" })).toBeInTheDocument();
  });

  it("a completed train job owned by this project shows View, not Fetch & Load", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ state: "completed", kind: "train" })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Fetch & Load/ })).not.toBeInTheDocument();
  });

  it("shows a finished training job's model name (sleap-connect #98), mono and muted", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ state: "completed", kind: "train", modelName: "260922_015758.centroid.n=1" }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    const name = await screen.findByText("260922_015758.centroid.n=1");
    expect(name.className).toContain("font-mono");
    expect(name.className).toContain("text-muted-foreground");
  });

  it("omits the model name row for a job with none (unfinished, track, or an older worker)", async () => {
    useConnectStore.setState({ listJobs: async () => [job({ state: "running" })] });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("Train centroid")).toBeInTheDocument());
    expect(screen.queryByText(/n=1/)).not.toBeInTheDocument();
  });

  it("Logs opens the JobViewerDialog on its log view for that job", async () => {
    useConnectStore.setState({ listJobs: async () => [job({ state: "running" })] });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Logs" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    // The viewer dialog renders its own "Monitor"/"Logs" toggle and the
    // job's label as its title — both only appear once the dialog is open.
    expect(screen.getByRole("button", { name: "Monitor" })).toBeInTheDocument();
    expect(screen.getAllByText("Train centroid").length).toBeGreaterThan(0);
  });

  it("a job from another project is view-only: watch/logs, but no stop or run-again", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ state: "running", project: { id: "other", name: "mice.slp" } }),
        job({
          jobId: "other-track",
          kind: "track",
          state: "completed",
          project: { id: "other", name: "mice.slp" },
        }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("Train centroid")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Watch live" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Logs" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again" })).not.toBeInTheDocument();
    // Fetch & Load (PR5b) is offered on ANY completed track job, mine or
    // not — the compatibility dialog (mocked above) decides what's safe to
    // merge, not project ownership.
    expect(screen.getByRole("button", { name: "Fetch & Load" })).toBeInTheDocument();
  });

  it("Cancel confirms, then calls cancelJobOn and refreshes the list", async () => {
    const cancelCalls: Array<[string, string, string]> = [];
    useConnectStore.setState({
      listJobs: async () => [job({ state: "queued", queuePosition: 1 })],
      cancelJobOn: async (workerId: string, jobId: string, mode: string) => {
        cancelCalls.push([workerId, jobId, mode]);
      },
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // confirmDialog renders via ConfirmDialog elsewhere — answer it directly
    // through the store, the same way ConfirmDialog's own buttons would.
    await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    useConfirmStore.getState().respond(true);

    await waitFor(() => expect(cancelCalls).toEqual([[WORKER_ID, "job_1", "cancel"]]));
  });

  it("Fetch & Load connects to the worker first if it isn't the selected backend, then opens the merge dialog", async () => {
    useAppStore.setState({ projectPath: MY_PROJECT_PATH });
    const connectCalls: string[] = [];
    useConnectStore.setState({
      selectedWorkerId: "some-other-worker",
      listJobs: async () => [job({ state: "completed", kind: "track" })],
      connectToWorker: async (id: string) => {
        connectCalls.push(id);
      },
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch & Load" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Fetch & Load" }));

    await waitFor(() => expect(screen.getByTestId("merge-predictions-dialog")).toBeInTheDocument());
    expect(connectCalls).toEqual([WORKER_ID]);
    // "mine" (myProject) because the job's project id matches the open
    // project's — the mocked dialog receives it as a prop, same as a real
    // one would for deciding its own fast path.
    expect(screen.getByTestId("merge-predictions-dialog")).toHaveTextContent(`${WORKER_ID}:job_1:true`);
  });

  it("Fetch & Load on another project's completed track job opens the dialog with mine=false", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ state: "completed", kind: "track", project: { id: "other", name: "mice.slp" } })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch & Load" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Fetch & Load" }));
    await waitFor(() => expect(screen.getByTestId("merge-predictions-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("merge-predictions-dialog")).toHaveTextContent(`${WORKER_ID}:job_1:false`);
  });
});

describe("isManagedJob / siblingJobIds (pure logic)", () => {
  it("is managed when the project id matches, even with no tracked jobs", () => {
    expect(isManagedJob(job(), myProject.id, new Set())).toBe(true);
  });

  it("is managed when the job id is tracked, even from a different project", () => {
    const other = job({ project: { id: "other", name: "x" } });
    expect(isManagedJob(other, myProject.id, new Set())).toBe(false);
    expect(isManagedJob(other, myProject.id, new Set(["job_1"]))).toBe(true);
  });

  it("returns just the job itself when it has no run", () => {
    expect(siblingJobIds([job()], job())).toEqual(["job_1"]);
  });

  it("returns every sibling sharing run.id, ordered by run.index", () => {
    const a = job({ jobId: "a", run: { id: "r1", index: 1, count: 2 } });
    const b = job({ jobId: "b", run: { id: "r1", index: 0, count: 2 } });
    const c = job({ jobId: "c", run: { id: "r2", index: 0, count: 1 } });
    expect(siblingJobIds([a, b, c], a)).toEqual(["b", "a"]);
  });
});

describe("WorkerJobs — PR5b row actions", () => {
  it("+ New job opens the wizard with no seed", async () => {
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "+ New job" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ New job" }));
    await waitFor(() => expect(screen.getByTestId("new-job-wizard")).toBeInTheDocument());
    expect(screen.getByTestId("new-job-wizard")).toHaveTextContent(`${WORKER_ID}:null`);
  });

  it("Run again is offered only on a failed train job that's mine", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "mine-failed", state: "failed", kind: "train" }),
        job({ jobId: "other-failed", state: "failed", kind: "train", project: { id: "other", name: "x" } }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Run again" })).toHaveLength(1));
  });

  it("Run again seeds the wizard from the failed run's own config", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ jobId: "mine-failed", state: "failed", kind: "train" })],
      jobDetail: async (): Promise<JobStatus> => ({
        jobId: "mine-failed",
        state: "failed",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:05:00.000Z",
        result: null,
        error: "boom",
        queuePosition: null,
        kind: "train",
        modelTypes: ["centroid"],
        project: myProject,
        labelsPath: "/root/vast/exp1/flies.slp",
        spec: { config_contents: ["a: 1"], model_types: ["centroid"] },
      }),
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Run again" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(seedWizardFromRunMock).toHaveBeenCalledTimes(1));
    expect(seedWizardFromRunMock).toHaveBeenCalledWith(expect.any(Function), WORKER_ID, ["mine-failed"]);
    await waitFor(() => expect(screen.getByTestId("new-job-wizard")).toBeInTheDocument());
    expect(screen.getByTestId("new-job-wizard")).toHaveTextContent("/root/vast/exp1/flies.slp");
  });

  it("a completed train job shows no per-row inference action — that's a 'Run again' at most", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ jobId: "mine-done", state: "completed", kind: "train" })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Run inference" })).not.toBeInTheDocument();
  });

  it("shows a '→ inference' tag on a train job whose spec chains post-train inference", async () => {
    useConnectStore.setState({
      listJobs: async () => [job({ postInference: true })],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText(/→ inference/)).toBeInTheDocument());
  });
});

describe("WorkerJobs — grouping + search", () => {
  it("renders a split training run as one group (one star) with both model rows", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "centroid-job", run: { id: "run1", index: 0, count: 2 } }),
        job({
          jobId: "ci-job",
          modelTypes: ["centered_instance"],
          run: { id: "run1", index: 1, count: 2 },
        }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("Top-down training run")).toBeInTheDocument());
    expect(screen.getByText("Train centroid")).toBeInTheDocument();
    expect(screen.getByText("Train centered_instance")).toBeInTheDocument();
    expect(screen.getAllByText("★")).toHaveLength(1);
  });

  it("groups a chained post-training inference job under its training run's card", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "train1", run: { id: "run1", index: 0, count: 1 } }),
        job({
          jobId: "infer1",
          kind: "track",
          run: { id: "run1", index: 0, count: 1, stage: "inference" },
        }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("Training run (centroid)")).toBeInTheDocument());
    expect(screen.getByText("Train centroid")).toBeInTheDocument();
    expect(screen.getByText("Inference")).toBeInTheDocument();
    // One run card, not two unrelated ones.
    expect(screen.getAllByText("★")).toHaveLength(1);
  });

  it("search filters to groups with a matching job; an unmatched group disappears entirely", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "flies-job", labelsPath: "/root/flies.slp" }),
        job({
          jobId: "mice-job",
          labelsPath: "/root/mice.slp",
          project: { id: "other", name: "mice project" },
        }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText(/flies\.slp/)).toBeInTheDocument());
    expect(screen.getByText(/mice\.slp/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search labels file/), { target: { value: "mice" } });
    await waitFor(() => expect(screen.queryByText(/flies\.slp/)).not.toBeInTheDocument());
    expect(screen.getByText(/mice\.slp/)).toBeInTheDocument();
  });

  it("a query matching only the chained inference job still surfaces its whole training run", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "train1", run: { id: "run1", index: 0, count: 1 }, labelsPath: "/root/a.slp" }),
        job({
          jobId: "infer1",
          kind: "track",
          run: { id: "run1", index: 0, count: 1, stage: "inference" },
          labelsPath: "/root/a.slp",
        }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("Train centroid")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Search labels file/), { target: { value: "infer1" } });
    await waitFor(() => expect(screen.getByText("Inference")).toBeInTheDocument());
    // The training row stays visible too — the whole group surfaces.
    expect(screen.getByText("Train centroid")).toBeInTheDocument();
  });

  it("shows 'No jobs match.' when the search query matches nothing", async () => {
    useConnectStore.setState({ listJobs: async () => [job()] });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText(/flies\.slp/)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search labels file/), { target: { value: "nonexistent" } });
    await waitFor(() => expect(screen.getByText("No jobs match.")).toBeInTheDocument());
  });

  it("shows each job's short id in its row (distinct from the group's own short run id)", async () => {
    useConnectStore.setState({
      listJobs: async () => [
        job({ jobId: "job_abcdefgh12345", run: { id: "run_zzzzzzzz9999", index: 0, count: 1 } }),
      ],
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByText("job_abcd")).toBeInTheDocument());
    expect(screen.getByText("run_zzzz")).toBeInTheDocument();
  });
});
