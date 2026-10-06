/**
 * PR3b §3b.4 — TrainingPanel decides WHEN to show RemoteRunCard: only for a
 * remote run that's currently running and not being watched live. Local
 * runs always get the full inline monitor, unchanged. See
 * remoteRunCard.test.tsx for the card's own rendering/interaction tests.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, Video } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { useTrainingStore, type ModelProgress } from "@/stores/trainingStore";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { TrainingPanel } = await import("@/components/panels/TrainingPanel");

const skeleton = new Skeleton({ nodes: ["a", "b"], edges: [["a", "b"]] });

function project(): Labels {
  const v = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
  return new Labels({
    videos: [v],
    skeletons: [skeleton],
    labeledFrames: [
      new LabeledFrame({
        video: v,
        frameIdx: 0,
        instances: [Instance.fromNumpy({ pointsData: [[1, 1], [2, 2]], skeleton })],
      }),
    ],
  });
}

function runningModel(overrides: Partial<ModelProgress> = {}): ModelProgress {
  return {
    label: "Centroid",
    epoch: 2,
    maxEpochs: 10,
    loss: 0.5,
    valLoss: null,
    bestValLoss: null,
    status: "running",
    epochSamples: [],
    batchSamples: [],
    epochSize: 1,
    lastBatchNumber: 0,
    metrics: { meanEpochTimeSec: null, etaNext10Min: null, epochsInPlateau: 0, inPlateau: false, bestValEpoch: null },
    epochStartedAt: null,
    plateauPatience: null,
    plateauMinDelta: null,
    runDir: null,
    ...overrides,
  };
}

function seedRunning(opts: { remote: boolean }) {
  useAppStore.setState({ labels: project() });
  useConnectStore.setState({
    connectionStatus: "connected",
    selectedWorkerId: opts.remote ? "w1" : null,
    pairedWorkers: [{ nodeId: "w1", label: "GPU Box", addrs: [], pairedAt: "2024-01-01T00:00:00.000Z" }],
    activeTransport: opts.remote ? "ws" : null,
  });
  useTrainingStore.setState({
    status: "running",
    _isRemote: opts.remote,
    startedAt: Date.now(),
    models: [runningModel()],
    currentModelIndex: 0,
    postTrainingInference: null,
    log: [],
  });
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ labels: null });
  useConnectStore.setState({
    connectionStatus: "disconnected",
    selectedWorkerId: null,
    pairedWorkers: [],
    activeTransport: null,
  });
  useTrainingStore.getState().reset();
});

describe("TrainingPanel — RemoteRunCard not-live default", () => {
  it("shows the compact card for a running remote run, not the inline monitor", () => {
    seedRunning({ remote: true });
    render(<TrainingPanel />);
    expect(screen.getByRole("button", { name: /Watch Live/ })).toBeInTheDocument();
    expect(screen.getByText(/Runs on GPU Box/)).toBeInTheDocument();
    // Inline monitor's per-model clickable row text isn't rendered underneath.
    expect(screen.queryByText(/Training: Centroid/)).toBeNull();
  });

  it("Watch Live switches to the full inline monitor (card goes away)", () => {
    seedRunning({ remote: true });
    render(<TrainingPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Watch Live/ }));
    expect(screen.queryByRole("button", { name: /Watch Live/ })).toBeNull();
    expect(screen.getByText(/Training: Centroid/)).toBeInTheDocument();
  });

  it("a local run always shows the inline monitor (no card, no Watch Live)", () => {
    seedRunning({ remote: false });
    render(<TrainingPanel />);
    expect(screen.queryByRole("button", { name: /Watch Live/ })).toBeNull();
    expect(screen.getByText(/Training: Centroid/)).toBeInTheDocument();
  });
});
