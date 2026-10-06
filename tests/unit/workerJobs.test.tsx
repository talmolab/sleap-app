/**
 * PR4b §4b.4 — WorkerJobs: pinning/sorting (this project first, then newest),
 * run tags, queue text, status chips, and action visibility per job state.
 * `mergeRemoteResults` (Fetch & Load) and `sonner` are mocked per this repo's
 * `vi.mock` convention — not hoisted, so the module under test is imported
 * dynamically AFTER the mocks are registered.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import { projectTag } from "@/lib/projectTag";
import type { JobSummary, JobStatus } from "@/lib/protocolV1/client";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const mergeRemoteResultsMock = vi.fn(async () => {});
vi.mock("@/stores/inferenceStore", () => ({
  mergeRemoteResults: mergeRemoteResultsMock,
}));

const { WorkerJobs, isMineJob, sortWorkerJobs, jobTitle, jobStatusChip } = await import(
  "@/components/connect/WorkerJobs"
);

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
  mergeRemoteResultsMock.mockClear();
});

beforeEach(() => {
  useAppStore.setState({ projectPath: MY_PROJECT_PATH });
  useConnectStore.setState({
    selectedWorkerId: WORKER_ID,
    listJobs: async () => [],
    jobDetail: async () => {
      throw new Error("jobDetail not stubbed for this test");
    },
    cancelJobOn: async () => {},
    connectToWorker: async () => {},
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

  it("a job from another project is view-only: watch/logs, but no stop or fetch", async () => {
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
    expect(screen.queryByRole("button", { name: "Fetch & Load" })).not.toBeInTheDocument();
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

  it("Fetch & Load connects to the worker first if it isn't the selected backend, then merges", async () => {
    useAppStore.setState({ projectPath: MY_PROJECT_PATH });
    const connectCalls: string[] = [];
    useConnectStore.setState({
      selectedWorkerId: "some-other-worker",
      listJobs: async () => [job({ state: "completed", kind: "track" })],
      jobDetail: async (): Promise<JobStatus> => ({
        jobId: "job_1",
        state: "completed",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:05:00.000Z",
        result: { blobs: { predictions: { sha256: "abc123", size: 42 } } },
        error: null,
        queuePosition: null,
        kind: "track",
        modelTypes: [],
        project: myProject,
      }),
      connectToWorker: async (id: string) => {
        connectCalls.push(id);
      },
    });
    render(
      <WorkerJobs workerId={WORKER_ID} setIntervalImpl={noopSetInterval} clearIntervalImpl={noopClearInterval} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch & Load" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Fetch & Load" }));

    await waitFor(() => expect(mergeRemoteResultsMock).toHaveBeenCalledTimes(1));
    expect(connectCalls).toEqual([WORKER_ID]);
    expect(mergeRemoteResultsMock).toHaveBeenCalledWith({
      results: [{ jobId: "job_1", success: true, resultBlobs: { predictions: { sha256: "abc123", size: 42 } } }],
      mode: "replace",
      trackOnly: false,
    });
  });
});
