/**
 * A training run refused before any model starts (e.g. the reused model's
 * folder is gone) used to show nothing — the error banner lived inside the
 * per-model progress block, which needs at least one model. The panel must
 * show the error on its own.
 */

import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { useTrainingStore, emptyModelProgress } from "@/stores/trainingStore";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { TrainingPanel } = await import("@/components/panels/TrainingPanel");

const GONE =
  'The trained model picked for Centroid is no longer there (/data/models/old). Pick it again, or uncheck "Use a trained model".';

afterEach(() => {
  cleanup();
  useTrainingStore.setState(useTrainingStore.getInitialState());
});

describe("Training panel — errors from before any model started", () => {
  // The hand-tested bug: a reuse check refused Start and the panel showed only Retry / New Training.
  it("shows the error when the run was refused with no models", () => {
    useConnectStore.setState({ connectionStatus: "connected" });
    render(<TrainingPanel />);
    act(() => useTrainingStore.setState({ status: "error", error: GONE, models: [] }));
    expect(screen.getByTestId("training-start-error").textContent).toBe(GONE);
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  // Once a model has started, the progress block shows the error — not twice.
  it("leaves errors with models to the progress block", () => {
    useConnectStore.setState({ connectionStatus: "connected" });
    useAppStore.setState({ labels: null });
    render(<TrainingPanel />);
    act(() =>
      useTrainingStore.setState({
        status: "error",
        error: "Training failed for centroid",
        models: [{ ...emptyModelProgress("Centroid"), status: "failed" }],
      }),
    );
    expect(screen.queryByTestId("training-start-error")).not.toBeInTheDocument();
  });
});
