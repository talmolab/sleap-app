/**
 * PR4b §4b.5 — WorkerDataAccess: mounts via `clientFor(id).fsMounts()` and
 * this worker's remembered path rules, with Clear.
 */
import { describe, it, expect, afterEach, beforeEach } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore, type PairedWorker } from "@/stores/connectStore";
import { WorkerDataAccess } from "@/components/connect/WorkerDataAccess";

const WORKER_ID = "node-a";

function fakeClient(mounts: Array<{ path: string; label?: string }>) {
  return { fsMounts: async () => mounts } as unknown as Awaited<
    ReturnType<ReturnType<typeof useConnectStore.getState>["clientFor"]>
  >;
}

function pairedWorker(overrides: Partial<PairedWorker> = {}): PairedWorker {
  return {
    nodeId: WORKER_ID,
    label: "gpu-box",
    addrs: ["ws://a:1"],
    pairedAt: "2026-09-27T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  useConnectStore.setState({
    pairedWorkers: [pairedWorker()],
    clientFor: async () => fakeClient([{ path: "/root/vast", label: "lab-data" }]),
  });
});

afterEach(cleanup);

describe("WorkerDataAccess", () => {
  it("shows the worker's mounts, fetched via clientFor().fsMounts()", async () => {
    render(<WorkerDataAccess workerId={WORKER_ID} />);
    await waitFor(() => expect(screen.getByText("/root/vast")).toBeInTheDocument());
    expect(screen.getByText("lab-data")).toBeInTheDocument();
  });

  it("shows 'No mounts configured.' when the worker reports none", async () => {
    useConnectStore.setState({ clientFor: async () => fakeClient([]) });
    render(<WorkerDataAccess workerId={WORKER_ID} />);
    await waitFor(() => expect(screen.getByText("No mounts configured.")).toBeInTheDocument());
  });

  it("shows a fetch error instead of silently showing no mounts", async () => {
    useConnectStore.setState({
      clientFor: async () => {
        throw new Error("Worker is reconnecting — try again shortly.");
      },
    });
    render(<WorkerDataAccess workerId={WORKER_ID} />);
    await waitFor(() =>
      expect(screen.getByText("Worker is reconnecting — try again shortly.")).toBeInTheDocument(),
    );
  });

  it("shows 'None yet.' when there are no remembered path rules", async () => {
    render(<WorkerDataAccess workerId={WORKER_ID} />);
    expect(screen.getByText("None yet.")).toBeInTheDocument();
  });

  it("lists remembered path rules and clears one via clearPathRule", async () => {
    useConnectStore.setState({
      pairedWorkers: [
        pairedWorker({ pathRules: [{ local: "/Volumes/talmo", worker: "/root/vast" }] }),
      ],
    });
    const clearCalls: Array<[string, string]> = [];
    useConnectStore.setState({
      clearPathRule: (workerId: string, local: string) => clearCalls.push([workerId, local]),
    });
    render(<WorkerDataAccess workerId={WORKER_ID} />);

    expect(screen.getByText("/Volumes/talmo → /root/vast")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(clearCalls).toEqual([[WORKER_ID, "/Volumes/talmo"]]);
  });

  it("re-renders the rule list immediately after Clear removes it from the store", async () => {
    useConnectStore.setState({
      pairedWorkers: [
        pairedWorker({ pathRules: [{ local: "/Volumes/talmo", worker: "/root/vast" }] }),
      ],
      clearPathRule: (workerId: string, local: string) => {
        useConnectStore.setState((s) => ({
          pairedWorkers: s.pairedWorkers.map((w) =>
            w.nodeId === workerId
              ? { ...w, pathRules: (w.pathRules ?? []).filter((r) => r.local !== local) }
              : w,
          ),
        }));
      },
    });
    render(<WorkerDataAccess workerId={WORKER_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("None yet.")).toBeInTheDocument();
  });
});
