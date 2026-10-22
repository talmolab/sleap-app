/**
 * The Connect window's queue: ordering and rows (`queueRunEntries`,
 * `queueRows`), the card list's click / right-click (`QueueRunList`), and the
 * sidebar's polling and failed-run clearing (`SidebarQueue`).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { projectTag } from "@/lib/projectTag";
import type { JobSummary } from "@/lib/protocolV1/client";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { groupJobs } = await import("@/components/connect/WorkerJobs");
const { queueRunEntries, queueRows, QueueRunList } = await import("@/components/connect/WorkerQueue");
const { SidebarQueue, DISMISSED_FAILED_RUNS_KEY } = await import("@/components/connect/SidebarQueue");

/** A spy typed as any callback prop (the vi shim's Mock type is untyped). */
const spy = () => vi.fn() as unknown as (...args: unknown[]) => void;

const PROJECT_PATH = "/data/mine.slp";
const mine = projectTag(PROJECT_PATH);
const other = { id: "other", name: "lab.slp" };
const recent = new Date().toISOString();

function job(jobId: string, state: string, o: Partial<JobSummary> = {}): JobSummary {
  return {
    jobId,
    state,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: recent,
    queuePosition: null,
    kind: "train",
    modelTypes: ["centroid"],
    labelsPath: "/data/mine.slp",
    project: mine,
    ...o,
  };
}

const run = (id: string, index = 0, count = 1) => ({ id, index, count });

// A worker with: my top-down run training its 2nd model (inference chained),
// a collaborator's run queued behind it, my run queued after that, and a
// failed run of mine.
const JOBS: JobSummary[] = [
  job("a1", "completed", { run: run("A", 0, 2) }),
  job("a2", "running", { run: run("A", 1, 2), modelTypes: ["centered_instance"], postInference: true }),
  job("b1", "queued", { run: run("B"), project: other, queuePosition: 1 }),
  job("c1", "queued", { run: run("C"), modelTypes: ["bottomup"], queuePosition: 2 }),
  job("f1", "failed", { run: run("F", 0, 2), error: "CUDA out of memory\nTraceback" }),
  job("f2", "canceled", { run: run("F", 1, 2), modelTypes: ["centered_instance"] }),
  job("old", "completed", { run: run("OLD") }),
];

const groups = () => groupJobs(JOBS, mine.id);

describe("queueRunEntries / queueRows", () => {
  it("orders failed (kept), then running, then queued by position; finished runs are left out", () => {
    const entries = queueRunEntries(groups(), { showFailed: () => true, dismissed: new Set() });
    expect(entries.map((e) => [e.group.key, e.status, e.place])).toEqual([
      ["F", "failed", null],
      ["A", "running", null],
      ["B", "queued", 1],
      ["C", "queued", 2],
    ]);
  });

  it("leaves out a failed run once dismissed, or when showFailed says no", () => {
    const keys = (dismissed: Set<string>, show: boolean) =>
      queueRunEntries(groups(), { showFailed: () => show, dismissed }).map((e) => e.group.key);
    expect(keys(new Set(["F"]), true)).not.toContain("F");
    expect(keys(new Set(), false)).not.toContain("F");
  });

  it("rows: a row per model with its badge, the running one active, plus inference still to come", () => {
    const a = groups().find((g) => g.key === "A")!;
    expect(queueRows(a).map((r) => [r.title, r.chip.text, r.active])).toEqual([
      ["centroid", "Completed", false],
      ["centered_instance", "Running", true],
      ["Inference", "After training", false],
    ]);
  });

  it("no inference row for a run that already ended in failure", () => {
    const f = groups().find((g) => g.key === "F")!;
    expect(queueRows(f).map((r) => r.title)).toEqual(["centroid", "centered_instance"]);
  });
});

describe("QueueRunList", () => {
  afterEach(cleanup);

  const entries = () => queueRunEntries(groups(), { showFailed: () => true, dismissed: new Set() });

  it("a card has no buttons; clicking it opens the run", () => {
    const onOpen = spy();
    render(
      <QueueRunList entries={entries()} canManage={() => true} onOpen={onOpen} onStopEarly={spy()} onCancelRun={spy()} />,
    );
    expect(screen.queryAllByRole("button", { name: /Cancel|Stop|Watch/ })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /bottomup.*open in Jobs/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ status: "queued", place: 2 }));
  });

  it("shows the failure's first line on a failed card", () => {
    render(
      <QueueRunList entries={entries()} canManage={() => true} onOpen={spy()} onStopEarly={spy()} onCancelRun={spy()} />,
    );
    expect(screen.getByText("CUDA out of memory")).toBeInTheDocument();
  });

  it("right-click offers Stop Early for the training model and Cancel run", async () => {
    const onStopEarly = spy();
    const onCancelRun = spy();
    render(
      <QueueRunList
        entries={entries()}
        canManage={() => true}
        onOpen={spy()}
        onStopEarly={onStopEarly}
        onCancelRun={onCancelRun}
      />,
    );
    // Cards in queue order: the failed run, then the running one.
    fireEvent.contextMenu(screen.getAllByRole("button", { name: /open in Jobs/ })[1]!);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Stop Early \(centered_instance\)/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("menuitem", { name: /Stop Early/ }));
    expect(onStopEarly).toHaveBeenCalledWith(expect.objectContaining({ jobId: "a2" }));
  });
});

describe("SidebarQueue", () => {
  const noopSet = () => "noop";
  const noopClear = () => {};

  beforeEach(() => {
    localStorage.removeItem(DISMISSED_FAILED_RUNS_KEY);
    useAppStore.setState({ projectPath: PROJECT_PATH });
    useConnectStore.setState({ trackedJobs: [], listJobs: async () => JOBS, cancelJobOn: async () => {} });
  });
  afterEach(cleanup);

  it("lists the worker's queue, and clicking a failed run clears it and opens it", async () => {
    const onOpenRun = spy();
    render(
      <SidebarQueue
        workerId="w1"
        workerLabel="GPU Box"
        refreshToken={0}
        onChanged={spy()}
        onOpenRun={onOpenRun}
        setIntervalImpl={noopSet}
        clearIntervalImpl={noopClear}
      />,
    );
    await waitFor(() => expect(screen.getByText("4 runs")).toBeInTheDocument());
    fireEvent.click(screen.getByText("CUDA out of memory"));
    expect(onOpenRun).toHaveBeenCalledWith("F");
    await waitFor(() => expect(screen.getByText("3 runs")).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(DISMISSED_FAILED_RUNS_KEY) ?? "[]")).toEqual(["F"]);
  });

  it("doesn't keep another project's failed run, or one older than a day", async () => {
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    useConnectStore.setState({
      listJobs: async () => [
        job("x1", "failed", { run: run("X"), project: other }),
        job("y1", "failed", { run: run("Y"), updatedAt: dayAgo }),
      ],
    });
    render(
      <SidebarQueue
        workerId="w1"
        workerLabel="GPU Box"
        refreshToken={0}
        onChanged={spy()}
        onOpenRun={spy()}
        setIntervalImpl={noopSet}
        clearIntervalImpl={noopClear}
      />,
    );
    await waitFor(() => expect(screen.getByText("Nothing running or queued.")).toBeInTheDocument());
  });
});
