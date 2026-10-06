/**
 * Tests for the shared "Backend: Local | Worker" picker (stage 1.9).
 *
 * The actual decision logic (`resolveBackendChange`/`backendSelectValue`) is
 * plain and pure, so it's tested directly rather than by driving Radix
 * Select's open/select interaction — this repo has one verified pattern for
 * that (tests/unit/skeletonEdgeAutofill.test.tsx) but it's fragile enough
 * that it's not worth repeating just to re-prove a two-line mapping. The
 * render tests below only exercise things that don't need it: text content
 * driven by connectStore state, and a plain button click.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useConnectStore, type PairedWorker } from "@/stores/connectStore";
import { backendSelectValue, resolveBackendChange, LOCAL_VALUE } from "@/components/common/BackendPicker";

// Radix Select needs a ResizeObserver in happy-dom.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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
    currentJob: null,
    connectionStatus: "disconnected",
    connectionError: null,
    workerMounts: [],
    reattachableJob: null,
    _client: null,
  });
}

describe("backendSelectValue / resolveBackendChange (pure logic)", () => {
  it("resolves to LOCAL_VALUE when remote is off", () => {
    expect(backendSelectValue(false, "node-a")).toBe(LOCAL_VALUE);
  });

  it("resolves to LOCAL_VALUE when remote is on but nothing is selected", () => {
    expect(backendSelectValue(true, null)).toBe(LOCAL_VALUE);
  });

  it("resolves to the selected worker's node_id when remote and selected", () => {
    expect(backendSelectValue(true, "node-a")).toBe("node-a");
  });

  it("picking LOCAL_VALUE turns remote off with nothing to connect to", () => {
    expect(resolveBackendChange(LOCAL_VALUE)).toEqual({
      remoteEnabled: false,
      workerIdToConnect: null,
    });
  });

  it("picking a worker id turns remote on and names that worker to connect to", () => {
    expect(resolveBackendChange("node-a")).toEqual({
      remoteEnabled: true,
      workerIdToConnect: "node-a",
    });
  });
});

describe("BackendPicker rendering", () => {
  beforeEach(() => {
    resetConnectStore();
  });

  async function renderPicker(props?: {
    remoteEnabled?: boolean;
    onRemoteEnabledChange?: (v: boolean) => void;
  }) {
    const { BackendPicker } = await import("@/components/common/BackendPicker");
    return render(
      <BackendPicker
        jobLabel="training job"
        remoteEnabled={props?.remoteEnabled ?? false}
        onRemoteEnabledChange={props?.onRemoteEnabledChange ?? (() => {})}
      />,
    );
  }

  it("shows a pairing hint when there are no paired workers", async () => {
    await renderPicker();
    expect(
      screen.getByText(/Pair with a worker in the Connect tab to run a training job remotely/),
    ).toBeInTheDocument();
  });

  it("lists Local plus every paired worker as options", async () => {
    useConnectStore.setState({ pairedWorkers: [WORKER_A, WORKER_B] });
    await renderPicker();

    const combo = screen.getByRole("combobox");
    fireEvent.pointerDown(combo, { button: 0 });
    fireEvent.keyDown(combo, { key: "Enter" });

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Local (this machine)", "Lab GPU", "Desktop"]);
  });

  it("shows no connection status line when running locally", async () => {
    useConnectStore.setState({ pairedWorkers: [WORKER_A], connectionStatus: "connected" });
    await renderPicker({ remoteEnabled: false });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it.each([
    ["connected" as const, "Connected"],
    ["connecting" as const, "Connecting…"],
    ["disconnected" as const, "Not connected"],
  ])("shows '%s' as '%s' when remote and a worker is selected", async (status, expectedText) => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      selectedWorkerId: WORKER_A.nodeId,
      connectionStatus: status,
    });
    await renderPicker({ remoteEnabled: true });
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it("includes the connection error in the status line on failure", async () => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      selectedWorkerId: WORKER_A.nodeId,
      connectionStatus: "error",
      connectionError: "connection refused",
    });
    await renderPicker({ remoteEnabled: true });
    expect(screen.getByText(/Connection failed: connection refused/)).toBeInTheDocument();
  });

  it("shows a reattach banner and cancels via the store's cancelJob", async () => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      selectedWorkerId: WORKER_A.nodeId,
      connectionStatus: "connected",
      currentJob: { workerId: WORKER_A.nodeId, jobId: "job_abc" },
      reattachableJob: { jobId: "job_abc", state: "running" },
      cancelJob: vi.fn(),
    });
    await renderPicker({ remoteEnabled: true });

    expect(screen.getByText("job_abc")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel it"));
    expect(useConnectStore.getState().cancelJob).toHaveBeenCalledTimes(1);
  });

  it("hides the reattach banner when running locally, even if one exists", async () => {
    useConnectStore.setState({
      pairedWorkers: [WORKER_A],
      selectedWorkerId: WORKER_A.nodeId,
      reattachableJob: { jobId: "job_abc", state: "running" },
    });
    await renderPicker({ remoteEnabled: false });
    expect(screen.queryByText("job_abc")).not.toBeInTheDocument();
  });
});
