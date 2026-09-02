/**
 * Regression test for a bug in the Full Configuration tab's Crop Size field:
 * clearing the input (e.g. select-all + retype) fired `onUpdate({ cropSize:
 * null })` on the empty intermediate value, which flips the field's
 * `disabled={hp.cropSize === null}` to true and drops the rest of the user's
 * keystrokes — from the user's perspective, "editing crop size doesn't
 * update the diagram." Only the explicit "Auto" checkbox should ever set
 * cropSize to null.
 */

import { describe, it, expect, beforeAll, afterEach } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { defaultHyperparams, getConfigSlots, type ConfigFile, type ConfigHyperparams, type ModelType } from "@/stores/trainingStore";
import { useAppStore } from "@/stores/appStore";
import { resolveEffectiveCropSize } from "@/lib/modelStats";
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

function renderDialog(onUpdateSlot: (slot: string, updates: Partial<ConfigHyperparams>) => void, cropSize: number | null) {
  const { TrainingConfigDialog } = mod;
  return render(
    <TrainingConfigDialog
      open
      onClose={noop}
      modelType="top_down"
      configs={makeConfigs("top_down", cropSize)}
      onUpdateSlot={onUpdateSlot}
      inferenceTarget="nothing"
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
  useAppStore.setState({ labels: null });
});

describe("TrainingConfigDialog crop size field", () => {
  it("clearing then retyping the input never forces Auto mode mid-edit", async () => {
    const updates: Array<Partial<ConfigHyperparams>> = [];
    renderDialog((_slot, u) => updates.push(u), 256);
    switchToTab(2); // centered_instance
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const container = document.getElementById("field-cropsize")!;
    const input = container.querySelector("input[type='number']") as HTMLInputElement;
    expect(input).toBeTruthy();

    // Simulate select-all + delete, then typing a new value one keystroke at a time.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.change(input, { target: { value: "400" } });

    expect(updates.some((u) => u.cropSize === null)).toBe(false);
    expect(updates[updates.length - 1].cropSize).toBe(400);
  });

  it("unchecking Auto seeds the live-computed value, not an arbitrary fallback", async () => {
    const labels = makeProjectLabels();
    useAppStore.setState({ labels });

    const updates: Array<Partial<ConfigHyperparams>> = [];
    renderDialog((_slot, u) => updates.push(u), null); // start in Auto mode
    switchToTab(2); // centered_instance
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const container = document.getElementById("field-cropsize")!;
    const checkbox = container.parentElement!.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // Auto

    fireEvent.click(checkbox); // uncheck Auto

    const expected = resolveEffectiveCropSize(labels, { ...defaultHyperparams, cropSize: null }).cropSize;
    expect(expected).not.toBeNull();
    expect(expected).not.toBe(256); // sanity: this dataset's real value isn't the old hardcoded fallback
    const seededUpdate = updates.find((u) => u.cropSize != null);
    expect(seededUpdate?.cropSize).toBe(expected);
  });

  it("displays the live-computed value (greyed out, not blank) while Auto is on", async () => {
    const labels = makeProjectLabels();
    useAppStore.setState({ labels });

    renderDialog(noop, null); // start in Auto mode
    switchToTab(2); // centered_instance
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const container = document.getElementById("field-cropsize")!;
    const input = container.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.disabled).toBe(true);

    const expected = resolveEffectiveCropSize(labels, { ...defaultHyperparams, cropSize: null }).cropSize;
    expect(expected).not.toBeNull();
    expect(Number(input.value)).toBe(expected!);
  });

  it("the Auto checkbox still explicitly sets cropSize to null", async () => {
    const updates: Array<Partial<ConfigHyperparams>> = [];
    renderDialog((_slot, u) => updates.push(u), 256);
    switchToTab(2);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const container = document.getElementById("field-cropsize")!;
    const checkbox = container.parentElement!.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(checkbox).toBeTruthy();

    fireEvent.click(checkbox);
    expect(updates.some((u) => u.cropSize === null)).toBe(true);
  });
});
