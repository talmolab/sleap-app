/**
 * The Training Configuration dialog's PyQt-parity controls: Use Negative
 * Frames + Negative Loss Weight (only on heads that use them), the
 * "Analyze Sizes..." button and crop-clipping warning on cropping heads, and
 * the "Selected clip" post-training inference target.
 */

import { describe, it, expect, beforeAll, afterEach } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { defaultHyperparams, getConfigSlots, type ConfigFile, type ConfigHyperparams, type ModelType } from "@/stores/trainingStore";
import { useAppStore } from "@/stores/appStore";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";

import { vi } from "../bun-test";
vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/dialogs/ModelStatsPreview", () => ({ ModelStatsPreview: () => null }));

function makeProjectLabels(): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "v.mp4",
    backendMetadata: { shape: [10, 1000, 1000, 3] },
    openBackend: false,
  });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  inst.points[0].xy = [0, 0];
  inst.points[0].visible = true;
  inst.points[1].xy = [150, 75];
  inst.points[1].visible = true;
  lf.instances.push(inst);
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
}

type DialogModule = typeof import("@/components/dialogs/TrainingConfigDialog");
let mod: DialogModule;
async function load(): Promise<DialogModule> {
  mod ??= await import("@/components/dialogs/TrainingConfigDialog");
  return mod;
}

function makeConfigs(modelType: ModelType, cropSize: number | null): ConfigFile[] {
  return getConfigSlots(modelType).map((slot) => ({
    filename: `${slot}.yaml`,
    content: "",
    modelType: slot,
    slot,
    hyperparams: { ...defaultHyperparams, cropSize },
    originalHyperparams: { ...defaultHyperparams, cropSize },
    hasTrainedModel: false,
    checkpointPath: null,
  }));
}

function noop() {}

/** Radix Tabs need a pointer-down sequence; a plain click is a no-op in happy-dom. */
function switchToTab(index: number) {
  const tab = screen.getAllByRole("tab")[index];
  fireEvent.pointerDown(tab, { button: 0 });
  fireEvent.mouseDown(tab, { button: 0 });
}

function renderDialog(onUpdateSlot: (slot: string, updates: Partial<ConfigHyperparams>) => void, cropSize: number | null, inferenceTarget = "nothing") {
  const { TrainingConfigDialog } = mod;
  return render(
    <TrainingConfigDialog
      open
      onClose={noop}
      modelType="top_down"
      configs={makeConfigs("top_down", cropSize)}
      onUpdateSlot={onUpdateSlot}
      inferenceTarget={inferenceTarget}
      onInferenceTargetChange={noop}
      remoteEnabled={false}
      onRemoteEnabledChange={noop}
      skeletonNodes={["head", "thorax", "abdomen"]}
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
    />
  );
}

beforeAll(async () => {
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
  await load();
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ labels: null, frameRange: null, sizeDistributionDialogOpen: false });
});

describe("TrainingConfigDialog PyQt-parity controls", () => {
  // Centroid uses negative frames, so its tab must offer both fields.
  it("shows the negative-frame fields on the centroid tab", async () => {
    const updates: Array<Partial<ConfigHyperparams>> = [];
    renderDialog((_slot, u) => updates.push(u), null);
    switchToTab(1); // centroid
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const toggleRow = document.getElementById("field-usenegativeframes")!;
    expect(toggleRow).toBeTruthy();
    const weight = document.getElementById("field-negativelossweight")!.querySelector("input") as HTMLInputElement;
    expect(weight.disabled).toBe(true); // greyed out until the option is on

    fireEvent.click(toggleRow.querySelector("button")!);
    expect(updates).toContainEqual({ useNegativeFrames: true });
  });

  // The option does nothing without negative frames; the tab must say so right under the toggle.
  it("warns under the toggle when no frame is marked negative", async () => {
    useAppStore.setState({ labels: makeProjectLabels() });
    const configs = makeConfigs("top_down", null).map((c) => ({
      ...c,
      hyperparams: { ...c.hyperparams, useNegativeFrames: true },
    }));
    render(
      <mod.TrainingConfigDialog
        open
        onClose={noop}
        modelType="top_down"
        configs={configs}
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
      />
    );
    switchToTab(1); // centroid
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("no frames are marked as negative");
  });

  // Centered-instance ignores negative frames; PyQt hides the fields there.
  it("hides the negative-frame fields on the centered-instance tab", async () => {
    renderDialog(noop, null);
    switchToTab(2); // centered_instance
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());
    expect(document.getElementById("field-usenegativeframes")).toBeNull();
    expect(document.getElementById("field-negativelossweight")).toBeNull();
  });

  // The size tool used to live only in the Analyze menu; PyQt has it next to the crop size.
  it("opens Size Distribution from the centered-instance tab", async () => {
    useAppStore.setState({ labels: makeProjectLabels() });
    renderDialog(noop, null);
    switchToTab(2);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Analyze Sizes..." }));
    expect(useAppStore.getState().sizeDistributionDialogOpen).toBe(true);
  });

  // No button on heads that don't crop, matching PyQt.
  it("has no Analyze Sizes button on the centroid tab", async () => {
    useAppStore.setState({ labels: makeProjectLabels() });
    renderDialog(noop, null);
    switchToTab(1);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Analyze Sizes..." })).toBeNull();
  });

  // A crop smaller than the largest animal (150px here) must be called out before training.
  it("warns when the crop size would clip animals", async () => {
    useAppStore.setState({ labels: makeProjectLabels() });
    renderDialog(noop, 128);
    switchToTab(2);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("instances will be clipped");
  });

  // With a clip selected the user should see which frames "Selected clip" means.
  it("describes the selected clip under the inference target", async () => {
    useAppStore.setState({ frameRange: [20, 29] });
    renderDialog(noop, null, "clip");
    expect(document.body.textContent).toContain("Selected on the timeline: frames 20–29 (10 frames)");
  });

  // Without a selection the clip target can't run; say so instead of failing silently.
  it("warns when Selected clip is chosen with nothing selected", async () => {
    renderDialog(noop, null, "clip");
    expect(document.body.textContent).toContain("No clip selected");
  });
});
