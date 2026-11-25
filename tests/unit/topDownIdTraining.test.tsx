/**
 * Top-Down + ID must train a centroid model and a multi-class top-down model
 * (poses + an identity head learned from the project's tracks). Its second
 * stage used to resolve to the plain centered-instance preset, so it trained a
 * pose-only model and post-training inference ran a top-down-ID pipeline with
 * no identity model.
 */

import type { ComponentProps } from "react";
import { describe, it, expect, beforeAll, afterEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import yaml from "js-yaml";
import {
  useTrainingStore,
  getConfigSlots,
  getSlotLabel,
  prepareLocalRun,
  buildPostTrainingInferenceConfig,
  type ConfigFile,
} from "@/stores/trainingStore";
import { slotToHeadType, getRecommendedProfileForHead } from "@/lib/trainingProfiles";
import { pipelineModelsProblem } from "@/lib/modelDiscovery";
import { Skeleton, Video, Labels, LabeledFrame, Instance, Track } from "@talmolab/sleap-io.js";

vi.mock("@/lib/platform", () => ({ isTauri: true, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/dialogs/ModelStatsPreview", () => ({ ModelStatsPreview: () => null }));

const { TrainingConfigDialog } = await import("@/components/dialogs/TrainingConfigDialog");

/** The configs the Training panel loads for a Top-Down + ID run. */
function topDownIdConfigs(): ConfigFile[] {
  const { parseYamlConfig } = useTrainingStore.getState();
  return getConfigSlots("top_down_id").map((slot) => {
    const profile = getRecommendedProfileForHead(slotToHeadType("top_down_id", slot), null)!;
    return parseYamlConfig(profile.content, profile.filename, slot)!;
  });
}

function trackedLabels(): Labels {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "s" });
  const video = new Video({ filename: "/v.mp4", backendMetadata: { shape: [10, 480, 640, 1] }, openBackend: false });
  const tracks = [new Track("fly0"), new Track("fly1")];
  const instances = tracks.map((track, i) => {
    const inst = Instance.fromArray([[10 + i * 50, 10], [20 + i * 50, 20]], skeleton);
    inst.track = track;
    return inst;
  });
  return new Labels({
    videos: [video],
    skeletons: [skeleton],
    tracks,
    labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances })],
  });
}

type HeadConfigs = Record<string, { confmaps?: Record<string, unknown>; class_vectors?: Record<string, unknown> } | null>;
const activeHeads = (configYaml: string) => {
  const heads = (yaml.load(configYaml) as { model_config: { head_configs: HeadConfigs } }).model_config.head_configs;
  return Object.fromEntries(Object.entries(heads).filter(([, v]) => v != null));
};

describe("Top-Down + ID training configs", () => {
  it("trains a centroid model, then a multi-class top-down model with an identity head", () => {
    const labels = trackedLabels();
    const [centroid, identity] = topDownIdConfigs();

    expect(Object.keys(activeHeads(prepareLocalRun(centroid, labels, null).configYaml))).toEqual(["centroid"]);

    const { configYaml, runName } = prepareLocalRun(identity, labels, null);
    const heads = activeHeads(configYaml);
    expect(Object.keys(heads)).toEqual(["multi_class_topdown"]);
    // Classes stay null: sleap-nn fills them from the training labels' tracks.
    expect(heads.multi_class_topdown!.class_vectors).toMatchObject({ classes: null, loss_weight: identity.hyperparams.classLossWeight });
    expect(heads.multi_class_topdown!.confmaps).toMatchObject({ sigma: identity.hyperparams.sigma });
    // The run folder names the head, which is how inference finds the model.
    expect(runName).toMatch(/\.multi_class_topdown\.n=1$/);
  });

  it("its two models are exactly what top-down-ID inference needs", () => {
    const heads = topDownIdConfigs().map((c) => c.modelType);
    const inference = buildPostTrainingInferenceConfig({
      modelType: "top_down_id",
      modelPaths: ["/m/centroid", "/m/id"],
      inferenceTarget: "user_labeled",
      videoIndex: "all",
    });
    expect(inference.pipeline).toBe("top-down-id");
    expect(pipelineModelsProblem(inference.pipeline, heads)).toBeNull();
  });

  it("labels the second model as the multi-class top-down model", () => {
    expect(getSlotLabel("centered_instance", "top_down_id")).toBe("Multi-Class Top-Down Config");
    expect(getSlotLabel("centered_instance", "top_down")).toBe("Centered Instance Config");
  });
});

describe("Top-Down + ID in the training config dialog", () => {
  beforeAll(() => {
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
    if (typeof g.CSS === "undefined") g.CSS = { escape: (s) => s };
    else if (!g.CSS.escape) g.CSS.escape = (s) => s;
  });
  afterEach(() => cleanup());

  const noop = () => {};
  const props = (): ComponentProps<typeof TrainingConfigDialog> => ({
    open: true,
    onClose: noop,
    modelType: "top_down_id",
    configs: topDownIdConfigs(),
    onUpdateSlot: noop,
    inferenceTarget: "nothing",
    onInferenceTargetChange: noop,
    remoteEnabled: false,
    onRemoteEnabledChange: noop,
    sampleCount: 20,
    onSampleCountChange: noop,
    skipUserLabeled: false,
    onSkipUserLabeledChange: noop,
    existingPredictions: "replace",
    onExistingPredictionsChange: noop,
    autoOpenWandb: false,
    onAutoOpenWandbChange: noop,
    exportFormat: "none",
    onExportFormatChange: noop,
    useExportedForInference: false,
    onUseExportedForInferenceChange: noop,
  });

  it("shows the identity head's settings on the second model's tab", () => {
    render(<TrainingConfigDialog {...props()} />);
    const tab = screen.getByRole("tab", { name: "Multi-Class Top-Down" });
    fireEvent.pointerDown(tab, { button: 0 });
    fireEvent.mouseDown(tab, { button: 0 });
    expect(screen.getByText("Class Vectors Loss Weight")).toBeInTheDocument();
  });
});
