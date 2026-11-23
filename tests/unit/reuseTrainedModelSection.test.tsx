/**
 * The "Use a trained model (don't retrain)" box in a Training Configuration
 * head tab (PyQt's per-tab "Reuse model"): checking it lists this project's
 * trained models of the same head, a different-skeleton model can't be
 * picked, picking one stores it on the stage, and the tab's training-mode
 * choices and settings step aside while it's checked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { useTrainingStore, defaultHyperparams, type ConfigFile, type ConfigHyperparams } from "@/stores/trainingStore";
import { useAppStore } from "@/stores/appStore";

vi.mock("@/lib/platform", () => ({ isTauri: true, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/dialogs/ModelStatsPreview", () => ({ ModelStatsPreview: () => null }));

const cfgYaml = (head: string, run: string, nodes: string[], anchor = "thorax") => `
data_config:
  skeletons:
    - nodes: [${nodes.map((n) => `{name: ${n}}`).join(", ")}]
model_config:
  head_configs:
    ${head}:
      confmaps: {anchor_part: ${anchor}}
trainer_config:
  run_name: "${run}"
`;

/** Fake project folder: /proj/models with two centroid runs and one centered-instance run. */
const RUNS: Record<string, string> = {
  "/proj/models/250101_120000.centroid.n=40": cfgYaml("centroid", "250101_120000.centroid.n=40", ["head", "thorax"]),
  "/proj/models/250102_120000.centroid.n=9": cfgYaml("centroid", "250102_120000.centroid.n=9", ["nose", "tail"]),
  "/proj/models/250103_120000.centered_instance.n=40": cfgYaml("centered_instance", "250103_120000.centered_instance.n=40", ["head", "thorax"]),
};
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (p: string) => p === "/proj/models" || p in RUNS || p.endsWith("training_config.yaml"),
  readDir: async (p: string) =>
    p === "/proj/models"
      ? Object.keys(RUNS).map((r) => ({ name: r.split("/").pop()!, isDirectory: true }))
      : [{ name: "training_config.yaml", isDirectory: false }, { name: "best.ckpt", isDirectory: false }],
  readTextFile: async (p: string) => RUNS[p.replace(/\/training_config\.yaml$/, "")] ?? "",
  stat: async (p: string) => ({ mtime: new Date(p.includes("250101") ? 1000 : 2000) }),
}));

const { ReuseTrainedModelSection } = await import("@/components/dialogs/ReuseTrainedModelSection");
const { TrainingConfigDialog } = await import("@/components/dialogs/TrainingConfigDialog");

const PROFILE_CENTROID = "model_config:\n  head_configs:\n    centroid:\n      confmaps: {}\n";

function makeConfig(slot: string, reuse?: ConfigFile["reuse"]): ConfigFile {
  return {
    filename: `${slot}.yaml`,
    content: PROFILE_CENTROID,
    modelType: slot,
    slot,
    hyperparams: { ...defaultHyperparams },
    originalHyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
    ...(reuse !== undefined ? { reuse } : {}),
  };
}

/** Renders the centroid tab's section wired to the real store, like the dialog does. */
function Harness({ onUpdate }: { onUpdate: (u: Partial<ConfigHyperparams>) => void }) {
  const cf = useTrainingStore((s) => s.config.configs.find((c) => c.slot === "centroid"))!;
  return (
    <ReuseTrainedModelSection
      slot="centroid"
      modelType="top_down"
      configFile={cf}
      skeletonNodes={["head", "thorax"]}
      onUpdate={onUpdate}
    />
  );
}

beforeEach(() => {
  useTrainingStore.setState(useTrainingStore.getInitialState());
  useTrainingStore.getState().setConfig("modelType", "top_down");
  useTrainingStore.getState().addConfigFile(makeConfig("centroid"));
  useAppStore.setState({ projectPath: "/proj/flies.slp" });
});
afterEach(cleanup);

describe("Use a trained model — head tab section", () => {
  // Checking the box marks the stage as reused, with nothing picked yet.
  it("checking the box sets the stage to reuse", () => {
    render(<Harness onUpdate={() => {}} />);
    fireEvent.click(screen.getByLabelText("Use a trained model"));
    expect(useTrainingStore.getState().config.configs[0].reuse).toEqual({ model: null });
    expect(screen.getByText(/Pick a trained model, or uncheck/)).toBeInTheDocument();
  });

  // Only centroid runs are offered; the one trained on other nodes is shown but can't be picked.
  it("lists same-head models and disables a different skeleton", async () => {
    render(<Harness onUpdate={() => {}} />);
    fireEvent.click(screen.getByLabelText("Use a trained model"));
    const trigger = await screen.findByRole("combobox");
    await waitFor(() => expect(trigger.textContent).toContain("Select a trained Centroid model"));
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("250102_120000.centroid.n=9"),
      expect.stringContaining("250101_120000.centroid.n=40"),
      "Browse for a model folder...",
    ]);
    expect(options[0].textContent).toContain("different skeleton");
    expect(options[0].getAttribute("aria-disabled")).toBe("true");
    expect(options.some((o) => o.textContent?.includes("centered_instance"))).toBe(false);
  });

  // Picking stores the model and hands its anchor part to the stage that still trains.
  it("picking a model stores it and syncs the anchor part", async () => {
    const updates: Partial<ConfigHyperparams>[] = [];
    const onUpdate = (u: Partial<ConfigHyperparams>) => { updates.push(u); };
    render(<Harness onUpdate={onUpdate} />);
    fireEvent.click(screen.getByLabelText("Use a trained model"));
    const trigger = await screen.findByRole("combobox");
    await waitFor(() => expect(trigger.textContent).toContain("Select a trained Centroid model"));
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(screen.getAllByRole("option")[1]);
    const reuse = useTrainingStore.getState().config.configs[0].reuse;
    expect(reuse?.model?.path).toBe("/proj/models/250101_120000.centroid.n=40");
    expect(reuse?.model?.nodeNames).toEqual(["head", "thorax"]);
    expect(updates).toEqual([{ anchorPart: "thorax" }]);
    expect(screen.getByText(/This stage won't be trained/)).toBeInTheDocument();
  });

  // Unchecking puts the stage back to training.
  it("unchecking clears the reuse", () => {
    useTrainingStore.getState().setConfigReuse("centroid", { model: null });
    render(<Harness onUpdate={() => {}} />);
    fireEvent.click(screen.getByLabelText("Use a trained model"));
    expect(useTrainingStore.getState().config.configs[0].reuse).toBeNull();
  });
});

describe("Use a trained model — in the Training Configuration dialog", () => {
  const noop = () => {};
  function renderDialog(configs: ConfigFile[], mode: "project" | "worker-file" = "project") {
    return render(
      <TrainingConfigDialog
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
        mode={mode}
      />,
    );
  }
  function openCentroidTab() {
    const tab = screen.getAllByRole("tab")[1];
    fireEvent.pointerDown(tab, { button: 0 });
    fireEvent.mouseDown(tab, { button: 0 });
  }

  // A reused stage isn't trained, so the Train from scratch / Fine-tune / Resume choice goes away.
  it("hides the training-mode choice on a reused tab", () => {
    renderDialog([makeConfig("centroid", { model: null }), makeConfig("centered_instance")]);
    openCentroidTab();
    expect(screen.getByLabelText("Use a trained model")).toBeChecked();
    expect(screen.queryByText("Train from scratch")).not.toBeInTheDocument();
  });

  // Unchecked, the tab looks as before.
  it("keeps the training-mode choice on a normal tab", () => {
    renderDialog([makeConfig("centroid"), makeConfig("centered_instance")]);
    openCentroidTab();
    expect(screen.getByLabelText("Use a trained model")).not.toBeChecked();
    expect(screen.getByText("Train from scratch")).toBeInTheDocument();
  });

  // A worker-file job can't use local model folders, so the option isn't offered there.
  it("isn't offered for worker-file jobs", () => {
    renderDialog([makeConfig("centroid"), makeConfig("centered_instance")], "worker-file");
    openCentroidTab();
    expect(screen.queryByLabelText("Use a trained model")).not.toBeInTheDocument();
  });
});
