/**
 * PR3b §3b.1 — RemoteDataSummary: per-video visibility summary for a "this
 * window" remote training run. Rendering only here; the real
 * checkVideoVisibility/connectStore wiring is injected via `checkFn` so
 * these tests stay deterministic (no real network/worker calls).
 *
 * `checkFn`/`onResult` are plain functions with manual call-tracking arrays,
 * not `vi.fn()` — this repo's bun-test shim types `vi.fn()`'s return as
 * `Mock<(...args: never[]) => unknown>` (not generic over the real impl), so
 * it isn't assignable to a strictly-typed prop like `typeof checkVideoVisibility`.
 */
import { describe, it, expect, afterEach } from "../bun-test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Labels, Video } from "@talmolab/sleap-io.js";
import { useConnectStore } from "@/stores/connectStore";
import type { VideoVisibility } from "@/lib/remoteVisibility";
import { RemoteDataSummary } from "@/components/connect/RemoteDataSummary";

function labelsWithVideos(paths: string[]): Labels {
  return new Labels({
    videos: paths.map((p) => new Video({ filename: p, openBackend: false })),
    skeletons: [],
    labeledFrames: [],
  });
}

function seedWorker(nodeId: string) {
  useConnectStore.setState({
    pairedWorkers: [
      { nodeId, label: "GPU Box", addrs: [], pairedAt: "2024-01-01T00:00:00.000Z" },
    ],
    selectedWorkerId: nodeId,
    connectionStatus: "connected",
    workerMounts: [{ path: "/mnt/data" }],
  });
}

afterEach(() => {
  cleanup();
  useConnectStore.setState({
    pairedWorkers: [],
    selectedWorkerId: null,
    connectionStatus: "disconnected",
    workerMounts: [],
  });
});

/** Records every call's `videoPaths` arg and resolves with `result`. */
function fixedCheck(result: VideoVisibility[]) {
  const calls: string[][] = [];
  const fn = async (videoPaths: string[]): Promise<VideoVisibility[]> => {
    calls.push(videoPaths);
    return result;
  };
  return { fn, calls };
}

describe("RemoteDataSummary", () => {
  it("renders nothing without a worker or labels", () => {
    const { container } = render(
      <RemoteDataSummary workerId={null} labels={null} onResult={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("all visible: green count + 'Training + inference on worker'", async () => {
    seedWorker("w1");
    const labels = labelsWithVideos(["/local/a.mp4"]);
    const { fn: checkFn } = fixedCheck([
      { index: 0, local: "/local/a.mp4", worker: "/mnt/data/a.mp4", visible: true },
    ]);
    render(
      <RemoteDataSummary
        workerId="w1"
        labels={labels}
        onResult={() => {}}
        checkFn={checkFn}
        debounceMs={0}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Videos 1\/1 visible on GPU Box/)).toBeInTheDocument());
    expect(screen.getByText(/Training \+ inference on worker/)).toBeInTheDocument();
    expect(screen.queryByText(/Locate on worker/)).toBeNull();
  });

  it("some hidden: lists up to 3 basenames with Locate links, 'and K more' beyond that", async () => {
    seedWorker("w1");
    const paths = ["/a/v0.mp4", "/a/v1.mp4", "/a/v2.mp4", "/a/v3.mp4", "/a/v4.mp4"];
    const labels = labelsWithVideos(paths);
    const { fn: checkFn } = fixedCheck(
      paths.map((local, index) =>
        index === 0
          ? { index, local, worker: "/mnt/data/v0.mp4", visible: true }
          : { index, local, worker: null, visible: false, reason: "no-location" as const },
      ),
    );
    render(
      <RemoteDataSummary
        workerId="w1"
        labels={labels}
        onResult={() => {}}
        checkFn={checkFn}
        debounceMs={0}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Videos 1\/5 visible/)).toBeInTheDocument());
    expect(screen.getByText("v1.mp4")).toBeInTheDocument();
    expect(screen.getByText("v2.mp4")).toBeInTheDocument();
    expect(screen.getByText("v3.mp4")).toBeInTheDocument();
    expect(screen.queryByText("v4.mp4")).toBeNull();
    expect(screen.getByText(/and 1 more/)).toBeInTheDocument();
    expect(screen.getAllByText(/Locate on worker/).length).toBe(3);
    expect(screen.getByText(/Training on worker.*inference on 1 of 5 videos/)).toBeInTheDocument();
  });

  it("none visible: 'Training only — videos not visible'", async () => {
    seedWorker("w1");
    const labels = labelsWithVideos(["/a.mp4"]);
    const { fn: checkFn } = fixedCheck([
      { index: 0, local: "/a.mp4", worker: null, visible: false, reason: "no-location" },
    ]);
    render(
      <RemoteDataSummary
        workerId="w1"
        labels={labels}
        onResult={() => {}}
        checkFn={checkFn}
        debounceMs={0}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Videos 0\/1 visible/)).toBeInTheDocument());
    expect(screen.getByText(/Training only — videos not visible/)).toBeInTheDocument();
  });

  it("debounces rapid changes into a single check call", async () => {
    seedWorker("w1");
    const { fn: checkFn, calls } = fixedCheck([]);
    const { rerender } = render(
      <RemoteDataSummary
        workerId="w1"
        labels={labelsWithVideos(["/a.mp4"])}
        onResult={() => {}}
        checkFn={checkFn}
        debounceMs={40}
      />,
    );
    rerender(
      <RemoteDataSummary
        workerId="w1"
        labels={labelsWithVideos(["/a.mp4", "/b.mp4"])}
        onResult={() => {}}
        checkFn={checkFn}
        debounceMs={40}
      />,
    );
    await new Promise((r) => setTimeout(r, 90));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["/a.mp4", "/b.mp4"]);
  });

  it("ignores a stale check result that resolves after a newer one", async () => {
    seedWorker("w1");
    const resolvers: Array<(v: VideoVisibility[]) => void> = [];
    const calls: string[][] = [];
    const checkFn = async (videoPaths: string[]): Promise<VideoVisibility[]> => {
      calls.push(videoPaths);
      return new Promise((resolve) => resolvers.push(resolve));
    };
    const onResultCalls: Array<VideoVisibility[] | null> = [];
    const onResult = (v: VideoVisibility[] | null) => onResultCalls.push(v);
    const { rerender } = render(
      <RemoteDataSummary
        workerId="w1"
        labels={labelsWithVideos(["/a.mp4"])}
        onResult={onResult}
        checkFn={checkFn}
        debounceMs={0}
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(
      <RemoteDataSummary
        workerId="w1"
        labels={labelsWithVideos(["/b.mp4"])}
        onResult={onResult}
        checkFn={checkFn}
        debounceMs={0}
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(2));

    const freshResult: VideoVisibility[] = [
      { index: 0, local: "/b.mp4", worker: "/mnt/data/b.mp4", visible: true },
    ];
    const staleResult: VideoVisibility[] = [
      { index: 0, local: "/a.mp4", worker: null, visible: false, reason: "no-location" },
    ];
    // Resolve the NEWER call first, then the stale one — the stale one must
    // never overwrite the fresh result.
    resolvers[1](freshResult);
    await waitFor(() => expect(onResultCalls.at(-1)).toEqual(freshResult));
    resolvers[0](staleResult);
    await new Promise((r) => setTimeout(r, 10));
    expect(onResultCalls.at(-1)).toEqual(freshResult);
  });
});
