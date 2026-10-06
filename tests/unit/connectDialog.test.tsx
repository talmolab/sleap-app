/**
 * PR4b §4b.2 — ConnectDialog shell: opens from the `connectWindowOpen` flag,
 * refreshes every paired worker's info on open, and releases idle managed
 * connections on close. WorkerList/WorkerJobs/WorkerDataAccess (§4b.3-4b.5)
 * get their own dedicated tests once they exist; this only covers the shell.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore, type PairedWorker } from "@/stores/connectStore";
import { ConnectDialog } from "@/components/connect/ConnectDialog";

const WORKER_A: PairedWorker = {
  nodeId: "node-a",
  label: "Lab GPU",
  addrs: ["ws://a:1"],
  pairedAt: "2026-09-27T00:00:00Z",
};
const WORKER_B: PairedWorker = {
  nodeId: "node-b",
  label: "Desktop",
  addrs: ["ws://b:1"],
  pairedAt: "2026-09-27T00:00:00Z",
};

function resetConnectStore() {
  useConnectStore.setState({
    pairedWorkers: [],
    selectedWorkerId: null,
    connections: {},
    workerErrors: {},
    workerInfo: {},
    refreshWorkerInfo: async () => {},
    releaseIdleConnections: () => {},
    // The picked worker mounts WorkerJobs (§4b.4), which calls listJobs —
    // stub it so these shell-only tests never attempt a real dial.
    listJobs: async () => [],
  });
}

beforeEach(resetConnectStore);
afterEach(cleanup);

describe("ConnectDialog", () => {
  it("renders nothing of its content while closed", () => {
    render(<ConnectDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("opens from the store flag, showing the header and paired workers", () => {
    useConnectStore.setState({ pairedWorkers: [WORKER_A, WORKER_B] });
    render(<ConnectDialog open onOpenChange={() => {}} />);
    expect(screen.getByText("Connect")).toBeInTheDocument();
    expect(screen.getByText("Your workers and the jobs on them")).toBeInTheDocument();
    // "Lab GPU" appears twice once selected (left-column card + right-pane header).
    expect(screen.getAllByText("Lab GPU").length).toBeGreaterThan(0);
    expect(screen.getByText("Desktop")).toBeInTheDocument();
  });

  it("refreshes every paired worker's info in parallel on open", async () => {
    const refreshed: string[] = [];
    useConnectStore.setState({
      pairedWorkers: [WORKER_A, WORKER_B],
      refreshWorkerInfo: async (id: string) => {
        refreshed.push(id);
      },
    });
    render(<ConnectDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(refreshed.sort()).toEqual(["node-a", "node-b"]));
  });

  it("shows the picked worker's label as the right-pane header", () => {
    useConnectStore.setState({ pairedWorkers: [WORKER_A], selectedWorkerId: "node-a" });
    render(<ConnectDialog open onOpenChange={() => {}} />);
    expect(screen.getAllByText("Lab GPU").length).toBeGreaterThan(0);
  });

  it("closing (via the header close button) calls onOpenChange(false) and releases idle connections", () => {
    const releaseIdleConnections = vi.fn();
    useConnectStore.setState({ pairedWorkers: [WORKER_A], releaseIdleConnections });
    // `vi.fn()` can't satisfy a strictly-typed `(open: boolean) => void` prop
    // (same limitation noted in hiddenVideosDialog.test.tsx) — track manually.
    const calls: boolean[] = [];
    render(<ConnectDialog open onOpenChange={(next) => calls.push(next)} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(calls).toEqual([false]);
    expect(releaseIdleConnections).toHaveBeenCalledTimes(1);
  });
});
