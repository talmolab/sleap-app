/**
 * PR5a.5 — `TrainingConfigDialog`'s controlled mode (`labelsOverride`,
 * `configActions`, `mode="worker-file"`): the launcher wizard (PR5b) opens
 * this same dialog to edit a worker-file job's hyperparameters, but it must
 * never read the open project or write the app's real `useTrainingStore` —
 * it edits a separate, wizard-local config copy instead (design §4.3).
 *
 * Absent props must behave exactly as before (the existing
 * trainingConfigDialogCropSize/trainingConfigSearch suites already cover
 * that in full); this file adds the "store writes still happen" check the
 * plan calls for, then exercises every override.
 */

import type { ComponentProps } from "react";
import { describe, it, expect, beforeAll, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { useTrainingStore, defaultHyperparams, type ConfigFile } from "@/stores/trainingStore";
import { useAppStore } from "@/stores/appStore";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";

vi.mock("@/lib/platform", () => ({ isTauri: true, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/** Captures every `labels` prop ModelStatsPreview is rendered with, without pulling in its real (frame-decoding) implementation. */
const modelStatsPreviewLabels: Array<Labels | null | undefined> = [];
vi.mock("@/components/dialogs/ModelStatsPreview", () => ({
  ModelStatsPreview: (props: { labels?: Labels | null }) => {
    modelStatsPreviewLabels.push(props.labels);
    return null;
  },
}));

const { TrainingConfigDialog } = await import("@/components/dialogs/TrainingConfigDialog");

function makeWorkerLabels(): Labels {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "worker-skeleton" });
  const video = new Video({
    filename: "/mnt/data/worker-video.mp4",
    backendMetadata: { shape: [5, 480, 640, 3] },
    openBackend: false,
  });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  lf.instances.push(inst);
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
}

/** A pre-populated single_animal ("config" slot) ConfigFile — bypasses the auto-load-baseline effect entirely so the head tab renders immediately, matching `trainingConfigDialogCropSize.test.tsx`'s `makeConfigs` pattern. */
function makeConfig(): ConfigFile {
  return {
    filename: "config.yaml",
    content: "",
    modelType: "config",
    slot: "config",
    hyperparams: { ...defaultHyperparams },
    originalHyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
  };
}

function noop() {}

function switchToTab(index: number) {
  const tab = screen.getAllByRole("tab")[index];
  fireEvent.pointerDown(tab, { button: 0 });
  fireEvent.mouseDown(tab, { button: 0 });
}

function renderDialog(overrides: Partial<ComponentProps<typeof TrainingConfigDialog>> = {}) {
  return render(
    <TrainingConfigDialog
      open
      onClose={noop}
      modelType="single_animal"
      configs={[makeConfig()]}
      onUpdateSlot={noop}
      inferenceTarget="nothing"
      onInferenceTargetChange={noop}
      remoteEnabled={false}
      onRemoteEnabledChange={noop}
      sampleCount={20}
      onSampleCountChange={noop}
      skipUserLabeled={false}
      onSkipUserLabeledChange={noop}
      existingPredictions="clear_all"
      onExistingPredictionsChange={noop}
      autoOpenWandb={false}
      onAutoOpenWandbChange={noop}
      exportFormat="none"
      onExportFormatChange={noop}
      useExportedForInference={false}
      onUseExportedForInferenceChange={noop}
      {...overrides}
    />,
  );
}

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS === "undefined") g.CSS = { escape: (s) => s };
  else if (!g.CSS.escape) g.CSS.escape = (s) => s;
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ labels: null, skeleton: null });
  useTrainingStore.setState((s) => ({ config: { ...s.config, configs: [] } }));
  modelStatsPreviewLabels.length = 0;
});

describe("TrainingConfigDialog — no override props (default / project mode)", () => {
  it("auto-loads a baseline into the real useTrainingStore on open, as before", async () => {
    renderDialog({ configs: [] });

    await waitFor(() =>
      expect(useTrainingStore.getState().config.configs.some((c) => c.slot === "config")).toBe(true),
    );
  });

  it("shows the Remote Training section", async () => {
    renderDialog();
    await waitFor(() => expect(document.getElementById("pipeline-remote")).toBeTruthy());
  });
});

describe("TrainingConfigDialog — labelsOverride", () => {
  it("passes the override (not the open project's labels) to ModelStatsPreview", async () => {
    useAppStore.setState({ labels: makeWorkerLabels() }); // a DIFFERENT Labels than the override below
    const override = makeWorkerLabels();

    renderDialog({ labelsOverride: override, configActions: undefined });
    switchToTab(1); // the single head tab ("config")
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    expect(modelStatsPreviewLabels.length).toBeGreaterThan(0);
    expect(modelStatsPreviewLabels[modelStatsPreviewLabels.length - 1]).toBe(override);
  });

  it("never reads the open project's labels when an override is given", async () => {
    const projectLabels = makeWorkerLabels();
    useAppStore.setState({ labels: projectLabels });
    const override = makeWorkerLabels();

    renderDialog({ labelsOverride: override });
    switchToTab(1);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    expect(modelStatsPreviewLabels.every((l) => l !== projectLabels)).toBe(true);
  });
});

/** Plain typed spies for `TrainingConfigActions` — `vi.fn()` with no args types its Mock as `(...args: never[]) => unknown`, which isn't assignable where `TrainingConfigActions`'s specific signatures are required. */
function spyConfigActions() {
  const addConfigFileCalls: ConfigFile[] = [];
  return {
    addConfigFile: (file: ConfigFile) => addConfigFileCalls.push(file),
    updateConfigCheckpointPath: (_slot: string, _path: string | null) => {},
    resetConfigHyperparams: (_slot: string) => {},
    addConfigFileCalls,
  };
}

describe("TrainingConfigDialog — configActions", () => {
  it("routes the auto-load-baseline write through configActions, never the real store", async () => {
    const { addConfigFile, updateConfigCheckpointPath, resetConfigHyperparams, addConfigFileCalls } =
      spyConfigActions();

    renderDialog({
      configs: [],
      labelsOverride: makeWorkerLabels(),
      configActions: { addConfigFile, updateConfigCheckpointPath, resetConfigHyperparams },
    });

    await waitFor(() => expect(addConfigFileCalls.length).toBeGreaterThan(0));
    expect(useTrainingStore.getState().config.configs.some((c) => c.slot === "config")).toBe(false);
  });
});

describe("TrainingConfigDialog — mode=\"worker-file\"", () => {
  it("hides the Remote Training section", async () => {
    renderDialog({ mode: "worker-file", labelsOverride: makeWorkerLabels() });
    await waitFor(() => expect(document.getElementById("pipeline-type")).toBeTruthy());

    expect(document.getElementById("pipeline-remote")).toBeNull();
    expect(screen.queryByText("Remote Training")).toBeNull();
  });

  it("hides the local checkpoint/config browse affordances on the head tab", async () => {
    renderDialog({ mode: "worker-file", labelsOverride: makeWorkerLabels() });
    switchToTab(1);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    expect(screen.queryByText("Browse for config file...")).toBeNull();
  });

  it("hides its own post-training-inference controls — the launcher wizard owns that toggle instead", async () => {
    renderDialog({ mode: "worker-file", labelsOverride: makeWorkerLabels() });
    await waitFor(() => expect(document.getElementById("pipeline-type")).toBeTruthy());

    expect(document.getElementById("pipeline-inference")).toBeNull();
    expect(screen.queryByText("Post-Training Inference Target")).toBeNull();
    expect(screen.queryByText("Existing predictions:")).toBeNull();
  });
});

describe("TrainingConfigDialog — mode=\"project\" keeps the post-training-inference controls", () => {
  it("shows the Inference Target section", async () => {
    renderDialog();
    await waitFor(() => expect(document.getElementById("pipeline-inference")).toBeTruthy());
    expect(screen.getByText("Post-Training Inference Target")).toBeInTheDocument();
    expect(screen.getByText("Existing predictions:")).toBeInTheDocument();
  });
});
