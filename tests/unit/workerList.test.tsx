/**
 * PR4b §4b.3 — WorkerList: card fields (status dot/label, specs, route),
 * filter chips, identity-mismatch → Re-pair, "+ Pair worker", empty state.
 * Selecting a card must only drive the window-local `onSelect` callback,
 * never connectStore's own `selectedWorkerId`/`connectToWorker`.
 */
import { describe, it, expect, afterEach, beforeEach } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore, type ConnectOptions, type PairedWorker } from "@/stores/connectStore";
import {
  WorkerList,
  classifyWorkerStatus,
  workerSpecsLine,
} from "@/components/connect/WorkerList";
import type { WorkerInfo } from "@/lib/protocolV1/client";

const GPU_INFO: WorkerInfo = {
  gpuModel: "RTX 4090",
  gpuMemoryMb: 24576,
  gpuCount: 1,
  cudaVersion: "12.4",
  sleapNnVersion: "0.3.1",
  busy: false,
};

const WORKER_A: PairedWorker = {
  nodeId: "node-a",
  label: "gpu-box",
  addrs: ["ws://a:1"],
  pairedAt: "2026-09-27T00:00:00Z",
};
const WORKER_B: PairedWorker = {
  nodeId: "node-b",
  label: "laptop",
  addrs: ["ws://b:1"],
  pairedAt: "2026-09-27T00:00:00Z",
};

function resetConnectStore() {
  useConnectStore.setState({
    pairedWorkers: [],
    connections: {},
    workerErrors: {},
    workerInfo: {},
    selectedWorkerId: null,
    forgetWorker: () => {},
  });
}

beforeEach(resetConnectStore);
afterEach(cleanup);

describe("classifyWorkerStatus (pure logic)", () => {
  it("connected + not busy -> idle", () => {
    expect(classifyWorkerStatus({ status: "connected", route: "ws" }, null, false).bucket).toBe(
      "idle",
    );
  });

  it("connected + busy -> busy", () => {
    expect(classifyWorkerStatus({ status: "connected", route: "ws" }, null, true).bucket).toBe(
      "busy",
    );
  });

  it("no connection entry -> offline", () => {
    expect(classifyWorkerStatus(undefined, null, undefined).bucket).toBe("offline");
  });

  it("reconnecting -> offline bucket with a 'Reconnecting…' label", () => {
    const s = classifyWorkerStatus({ status: "reconnecting", route: "ws" }, null, undefined);
    expect(s.bucket).toBe("offline");
    expect(s.label).toBe("Reconnecting…");
  });

  it("an identity-mismatch error flags identityMismatch regardless of connection state", () => {
    const s = classifyWorkerStatus(
      { status: "connected", route: "ws" },
      "Worker at ws://x identified itself as a different node than expected",
      false,
    );
    expect(s.identityMismatch).toBe(true);
    expect(s.bucket).toBe("offline");
  });

  it("a non-identity error still classifies as offline, not a mismatch", () => {
    const s = classifyWorkerStatus(undefined, "Not connected", undefined);
    expect(s.identityMismatch).toBe(false);
    expect(s.bucket).toBe("offline");
  });
});

describe("workerSpecsLine (pure logic)", () => {
  it("formats GPU model, memory, count, CUDA, and sleap-nn version", () => {
    expect(workerSpecsLine(GPU_INFO)).toBe("RTX 4090 · 24 GB ×1 · CUDA 12.4 · sleap-nn 0.3.1");
  });

  it("returns null when info is unknown", () => {
    expect(workerSpecsLine(undefined)).toBeNull();
  });
});

describe("WorkerList rendering", () => {
  it("shows the empty state with the pairing commands when no workers are paired", () => {
    render(<WorkerList selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/No workers paired yet/)).toBeInTheDocument();
    expect(screen.getByText("sleap-rtc serve --daemonize")).toBeInTheDocument();
    expect(screen.getByText("sleap-rtc pair")).toBeInTheDocument();
  });

  it("shows a card's label, status, specs line, and route", () => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      connections: { "node-a": { status: "connected", route: "ws" } },
      workerInfo: { "node-a": GPU_INFO },
    });
    render(<WorkerList selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("gpu-box")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("RTX 4090 · 24 GB ×1 · CUDA 12.4 · sleap-nn 0.3.1")).toBeInTheDocument();
    expect(screen.getByText(/via WebSocket/)).toBeInTheDocument();
  });

  it("selecting a card calls onSelect only — never touches connectStore.selectedWorkerId", () => {
    useConnectStore.setState({ pairedWorkers: [WORKER_A] });
    // `vi.fn()` can't satisfy a strictly-typed `(id: string) => void` prop
    // (same limitation noted in hiddenVideosDialog.test.tsx) — track manually.
    const calls: string[] = [];
    render(<WorkerList selectedId={null} onSelect={(id) => calls.push(id)} />);
    fireEvent.click(screen.getByText("gpu-box"));
    expect(calls).toEqual(["node-a"]);
    expect(useConnectStore.getState().selectedWorkerId).toBeNull();
  });

  it("filter chips narrow the list and show correct counts", () => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A, WORKER_B],
      connections: {
        "node-a": { status: "connected", route: "ws" },
        "node-b": { status: "connected", route: "ws" },
      },
      workerInfo: {
        "node-a": { ...GPU_INFO, busy: true },
        "node-b": { ...GPU_INFO, busy: false },
      },
    });
    render(<WorkerList selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Busy (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Idle (1)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Busy (1)" }));
    expect(screen.getByText("gpu-box")).toBeInTheDocument();
    expect(screen.queryByText("laptop")).not.toBeInTheDocument();
  });

  it("an identity mismatch shows 'has a new identity' and a Re-pair button that opens PairWorkerForm", () => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      workerErrors: {
        "node-a": "Worker at ws://a:1 identified itself as a different node than expected",
      },
    });
    render(<WorkerList selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("gpu-box has a new identity.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Re-pair" }));
    expect(screen.getByText("Pair with a worker")).toBeInTheDocument();
  });

  it("re-pairing forgets the old worker entry once the new ticket is claimed", async () => {
    const forgotten: string[] = [];
    const calls: Array<[string, string | undefined, ConnectOptions | undefined]> = [];
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      workerErrors: {
        "node-a": "Worker at ws://a:1 identified itself as a different node than expected",
      },
      forgetWorker: (id: string) => forgotten.push(id),
      pairWithTicket: async (ticketJson: string, addrOverride?: string, options?: ConnectOptions) => {
        calls.push([ticketJson, addrOverride, options]);
      },
    });
    render(<WorkerList selectedId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-pair" }));

    fireEvent.change(screen.getByPlaceholderText(/node_id/), {
      target: { value: '{"node_id":"n2","secret":"s"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(forgotten).toEqual(["node-a"]));
  });

  it("'+ Pair worker' opens an inline pairing form", () => {
    useConnectStore.setState({ pairedWorkers: [WORKER_A] });
    render(<WorkerList selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText("Pair with a worker")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Pair worker" }));
    expect(screen.getByText("Pair with a worker")).toBeInTheDocument();
  });
});
