/**
 * PR4b §4b.6 — JobViewerDialog: Monitor/Logs toggle, the replay-caveat note,
 * Stop only while running, and closing. `useJobStream` is mocked (per this
 * repo's `vi.mock` convention — not hoisted, so the module under test is
 * imported dynamically AFTER the mock is registered) so each test drives a
 * specific `JobStreamState` without a real worker connection.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { initialJobStream, type JobStreamState } from "@/lib/jobStream";
import { useConnectStore } from "@/stores/connectStore";
import { useConfirmStore } from "@/stores/confirmStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Driven through a captured `let` (reset per test) rather than a per-call
// mock implementation — simplest way to vary the hook's return per test.
let mockStream: JobStreamState = initialJobStream("Train centroid");
vi.mock("@/hooks/useJobStream", () => ({
  useJobStream: () => mockStream,
}));

const { JobViewerDialog } = await import("@/components/connect/JobViewerDialog");

afterEach(() => {
  cleanup();
  mockStream = initialJobStream("Train centroid");
});

beforeEach(() => {
  useConnectStore.setState({ cancelJobOn: async () => {} });
});

describe("JobViewerDialog", () => {
  it("shows the label and the stream's status in the header", () => {
    mockStream = { ...initialJobStream("Train centroid"), status: "running" };
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Train centroid")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText(/Replayed from the worker's history/)).toBeInTheDocument();
  });

  it("opens on the Logs view when initialView is 'logs', showing log lines", () => {
    mockStream = { ...initialJobStream("Inference"), log: ["line one", "line two"] };
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Inference"
        initialView="logs"
        canStop
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("line one")).toBeInTheDocument();
    expect(screen.getByText("line two")).toBeInTheDocument();
  });

  it("toggles between Monitor and Logs", () => {
    mockStream = { ...initialJobStream("Train centroid"), log: ["hello"] };
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("shows Stop only while running, confirms, and calls cancelJobOn", async () => {
    mockStream = { ...initialJobStream("Train centroid"), status: "running" };
    const calls: Array<[string, string, string]> = [];
    useConnectStore.setState({
      cancelJobOn: async (workerId: string, jobId: string, mode: string) => {
        calls.push([workerId, jobId, mode]);
      },
    });
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    useConfirmStore.getState().respond(true);
    await waitFor(() => expect(calls).toEqual([["w1", "job_1", "stop"]]));
  });

  it("hides Stop once the job is no longer running", () => {
    mockStream = { ...initialJobStream("Train centroid"), status: "completed" };
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("never offers Stop for a view-only job (another project's), even while running", () => {
    mockStream = { ...initialJobStream("Train centroid"), status: "running" };
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop={false}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("shows the failure detail for a failed job", () => {
    mockStream = { ...initialJobStream("Train centroid"), status: "failed", detail: "CUDA out of memory" };
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("CUDA out of memory")).toBeInTheDocument();
  });

  it("closing the dialog calls onClose", () => {
    mockStream = initialJobStream("Train centroid");
    const calls: boolean[] = [];
    render(
      <JobViewerDialog
        workerId="w1"
        jobId="job_1"
        label="Train centroid"
        initialView="monitor"
        canStop
        onClose={() => calls.push(true)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(calls).toEqual([true]);
  });
});
