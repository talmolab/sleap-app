/**
 * PR3b §3b.4 — RemoteRunCard: the compact "not-live" card shown instead of
 * the full inline monitor while a remote training run is going and the user
 * hasn't clicked Watch Live. Rendering/interaction only here — TrainingPanel
 * owns deciding WHEN to show it (see trainingPanelRemoteRunCard.test.tsx).
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RemoteRunCard } from "@/components/connect/RemoteRunCard";
import type { ModelProgress, PostTrainingInference } from "@/stores/trainingStore";

function model(overrides: Partial<ModelProgress> = {}): ModelProgress {
  return {
    label: "Centroid",
    epoch: 3,
    maxEpochs: 10,
    loss: 0.1234,
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

afterEach(cleanup);

describe("RemoteRunCard", () => {
  it("shows the worker label and connected status", () => {
    render(
      <RemoteRunCard
        workerLabel="GPU Box"
        connectionStatus="connected"
        activeTransport="ws"
        startedAt={Date.now()}
        models={[model()]}
        currentModelIndex={0}
        postTrainingInference={null}
        onWatchLive={() => {}}
      />,
    );
    expect(screen.getByText("GPU Box")).toBeInTheDocument();
    expect(screen.getByText(/via WebSocket/i)).toBeInTheDocument();
  });

  it("shows Reconnecting… when the connection drops mid-run", () => {
    render(
      <RemoteRunCard
        workerLabel="GPU Box"
        connectionStatus="reconnecting"
        activeTransport="ws"
        startedAt={Date.now()}
        models={[model()]}
        currentModelIndex={0}
        postTrainingInference={null}
        onWatchLive={() => {}}
      />,
    );
    expect(screen.getByText(/Reconnecting…/)).toBeInTheDocument();
  });

  it("renders a row per model with epoch/maxEpochs and loss", () => {
    render(
      <RemoteRunCard
        workerLabel="GPU Box"
        connectionStatus="connected"
        activeTransport="ws"
        startedAt={Date.now()}
        models={[
          model({ label: "Centroid", status: "completed", epoch: 10, maxEpochs: 10, loss: 0.05 }),
          model({ label: "Centered Instance", status: "running", epoch: 2, maxEpochs: 10, loss: 0.2 }),
        ]}
        currentModelIndex={1}
        postTrainingInference={null}
        onWatchLive={() => {}}
      />,
    );
    expect(screen.getByText("Centroid")).toBeInTheDocument();
    expect(screen.getByText(/10\/10/)).toBeInTheDocument();
    expect(screen.getByText("Centered Instance")).toBeInTheDocument();
    expect(screen.getByText(/2\/10/)).toBeInTheDocument();
    expect(screen.getByText(/loss 0\.2000/)).toBeInTheDocument();
  });

  it("shows a running inference row", () => {
    const pti: PostTrainingInference = {
      status: "running",
      message: null,
      pendingMerge: null,
      merged: false,
    };
    render(
      <RemoteRunCard
        workerLabel="GPU Box"
        connectionStatus="connected"
        activeTransport="ws"
        startedAt={Date.now()}
        models={[model({ status: "completed" })]}
        currentModelIndex={1}
        postTrainingInference={pti}
        onWatchLive={() => {}}
      />,
    );
    expect(screen.getByText(/Running inference on the worker/)).toBeInTheDocument();
  });

  it("includes the worker label in the 'can close SLEAP' note", () => {
    render(
      <RemoteRunCard
        workerLabel="GPU Box"
        connectionStatus="connected"
        activeTransport="ws"
        startedAt={Date.now()}
        models={[model()]}
        currentModelIndex={0}
        postTrainingInference={null}
        onWatchLive={() => {}}
      />,
    );
    expect(screen.getByText(/Runs on GPU Box/)).toBeInTheDocument();
    expect(screen.getByText(/you'll be notified when it finishes/)).toBeInTheDocument();
  });

  it("Watch Live calls onWatchLive", () => {
    const onWatchLive = vi.fn();
    render(
      <RemoteRunCard
        workerLabel="GPU Box"
        connectionStatus="connected"
        activeTransport="ws"
        startedAt={Date.now()}
        models={[model()]}
        currentModelIndex={0}
        postTrainingInference={null}
        onWatchLive={onWatchLive}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Watch Live/ }));
    expect(onWatchLive).toHaveBeenCalledTimes(1);
  });
});
