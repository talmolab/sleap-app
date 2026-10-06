/**
 * PR5a.6 — launcherSpec.ts's pure spec builders: buildLauncherTrainSpec
 * (the launcher wizard's "+ New job" train spec, always path-mode),
 * seedFromJobSpec ("Run again"), and buildRunInferenceSpecs ("Run
 * inference" on a finished run).
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import yaml from "js-yaml";
import { Skeleton, Video, Labels } from "@talmolab/sleap-io.js";
import {
  useTrainingStore,
  defaultHyperparams,
  buildPostTrainingInferenceConfig,
  type ConfigFile,
} from "@/stores/trainingStore";
import type { JobProject } from "@/lib/protocolV1/client";
import { projectTag } from "@/lib/projectTag";
import { buildLauncherTrainSpec, buildRunInferenceSpecs, seedFromJobSpec } from "@/lib/launcherSpec";

interface ParsedYamlDoc {
  model_config: { head_configs: Record<string, unknown> };
  trainer_config: { run_name: string };
}

function makeYaml(headType: string): string {
  return `
model_config:
  backbone_config:
    unet:
      filters: 32
  head_configs:
    ${headType}:
      sigma: 1.5
trainer_config:
  max_epochs: 50
  train_data_loader:
    batch_size: 4
  optimizer:
    lr: 0.001
data_config: {}
`;
}

function makeConfigFile(overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    filename: "test.yaml",
    content: makeYaml("centroid"),
    modelType: "centroid",
    slot: "centroid",
    hyperparams: { ...defaultHyperparams },
    originalHyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
    ...overrides,
  };
}

function makeWorkerLabels(): Labels {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "s" });
  const video = new Video({
    filename: "/mnt/data/a.mp4",
    backendMetadata: { shape: [20, 480, 640, 3] },
    openBackend: false,
  });
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [] });
}

const PROJECT: JobProject = projectTag("/mnt/data/labels.slp");

describe("buildLauncherTrainSpec", () => {
  beforeEach(() => {
    useTrainingStore.getState().reset();
  });

  it("is always path-mode: labels_path set, labels_content never present", () => {
    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      modelType: "single_animal",
      configs: [makeConfigFile({ slot: "config", modelType: "single_instance", content: makeYaml("single_instance") })],
      postInference: null,
      project: PROJECT,
    });

    expect(spec.labels_path).toBe("/mnt/data/labels.slp");
    expect("labels_content" in spec).toBe(false);
    expect(spec.val_labels_path).toBeUndefined();
    expect(spec.type).toBe("train");
    expect(spec.project).toBe(PROJECT);
  });

  it("orders a multi-model pipeline's config_contents by slot, regardless of input order", () => {
    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      modelType: "top_down",
      configs: [
        makeConfigFile({ slot: "centered_instance", modelType: "centered_instance", content: makeYaml("centered_instance") }),
        makeConfigFile({ slot: "centroid", modelType: "centroid", content: makeYaml("centroid") }),
      ],
      postInference: null,
      project: PROJECT,
    });

    expect(spec.model_types).toEqual(["centroid", "centered_instance"]);
    expect(spec.config_contents).toHaveLength(2);
    const docs = spec.config_contents.map((c) => yaml.load(c) as ParsedYamlDoc);
    expect(Object.keys(docs[0].model_config.head_configs)).toEqual(["centroid"]);
    expect(Object.keys(docs[1].model_config.head_configs)).toEqual(["centered_instance"]);
  });

  it("gives every model in one submission the exact same run_name timestamp", () => {
    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      modelType: "top_down",
      configs: [
        makeConfigFile({ slot: "centroid", modelType: "centroid", content: makeYaml("centroid") }),
        makeConfigFile({ slot: "centered_instance", modelType: "centered_instance", content: makeYaml("centered_instance") }),
      ],
      postInference: null,
      project: PROJECT,
    });

    const docs = spec.config_contents.map((c) => (yaml.load(c) as ParsedYamlDoc).trainer_config.run_name);
    const [timestampA] = docs[0].split(".");
    const [timestampB] = docs[1].split(".");
    expect(timestampA).toBe(timestampB);
    expect(docs[0]).toContain(".centroid");
    expect(docs[1]).toContain(".centered_instance");
  });

  it("sets labels_content alongside labels_path when a labelsContent payload is given", () => {
    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      labelsContent: "QkFTRTY0", // arbitrary base64 stand-in -- buildLauncherTrainSpec never decodes it
      modelType: "single_animal",
      configs: [makeConfigFile({ slot: "config", modelType: "single_instance", content: makeYaml("single_instance") })],
      postInference: null,
      project: PROJECT,
    });

    expect(spec.labels_path).toBe("/mnt/data/labels.slp");
    expect(spec.labels_content).toBe("QkFTRTY0");
  });

  it("omits labels_content when given null (no re-pointing was needed)", () => {
    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      labelsContent: null,
      modelType: "single_animal",
      configs: [makeConfigFile({ slot: "config", modelType: "single_instance", content: makeYaml("single_instance") })],
      postInference: null,
      project: PROJECT,
    });

    expect("labels_content" in spec).toBe(false);
  });

  it("omits post_inference when none is requested", () => {
    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      modelType: "single_animal",
      configs: [makeConfigFile({ slot: "config", content: makeYaml("single_instance") })],
      postInference: null,
      project: PROJECT,
    });

    expect(spec.post_inference).toBeUndefined();
  });

  it("includes post_inference, stripped of type/data_path/model_paths (the worker fills those in)", () => {
    const postInference = buildPostTrainingInferenceConfig({
      modelType: "single_animal",
      modelPaths: [], // not yet known at submit time -- the worker fills this in once it trains
      inferenceTarget: "suggestions",
      videoIndex: "all",
    });

    const spec = buildLauncherTrainSpec({
      labels: makeWorkerLabels(),
      labelsPath: "/mnt/data/labels.slp",
      modelType: "single_animal",
      configs: [makeConfigFile({ slot: "config", content: makeYaml("single_instance") })],
      postInference,
      project: PROJECT,
    });

    expect(spec.post_inference).toHaveLength(1);
    const entry = spec.post_inference![0] as Record<string, unknown>;
    expect(entry.type).toBeUndefined();
    expect(entry.data_path).toBeUndefined();
    expect(entry.model_paths).toBeUndefined();
    expect(entry.frame_filter).toBe("suggested");
  });
});

describe("buildRunInferenceSpecs", () => {
  it("builds a standalone track spec with the given model dirs and the worker labels' frame counts", () => {
    const config = buildPostTrainingInferenceConfig({
      modelType: "single_animal",
      modelPaths: [],
      inferenceTarget: "all_videos",
      videoIndex: "all",
    });

    const specs = buildRunInferenceSpecs("/mnt/data/labels.slp", ["/mnt/models/run1"], config, makeWorkerLabels());

    expect(specs).toHaveLength(1);
    expect(specs[0].data_path).toBe("/mnt/data/labels.slp");
    expect(specs[0].model_paths).toEqual(["/mnt/models/run1"]);
    expect(specs[0].type).toBe("track");
  });

  it("samples per-video for a 'random' target using each worker video's own frame count", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const labels = new Labels({
      videos: [
        new Video({ filename: "a.mp4", backendMetadata: { shape: [10, 8, 8, 1] }, openBackend: false }),
        new Video({ filename: "b.mp4", backendMetadata: { shape: [4, 8, 8, 1] }, openBackend: false }),
      ],
      skeletons: [skeleton],
      labeledFrames: [],
    });
    const config = buildPostTrainingInferenceConfig({
      modelType: "single_animal",
      modelPaths: [],
      inferenceTarget: "random",
      videoIndex: "all",
      sampleCount: 3,
    });

    const specs = buildRunInferenceSpecs("/mnt/data/labels.slp", ["/mnt/models/run1"], config, labels);

    expect(specs.map((s) => s.video_index)).toEqual([0, 1]);
    expect(specs[0].frames!.split(",")).toHaveLength(3);
    expect(specs[1].frames!.split(",")).toHaveLength(3); // capped to that video's own 4 frames? no -- 3 <= 4, so still 3
  });
});

describe("seedFromJobSpec", () => {
  it("reconstructs a two-job top-down run's modelType and per-slot configs", () => {
    const result = seedFromJobSpec({
      config_contents: [makeYaml("centroid"), makeYaml("centered_instance")],
      model_types: ["centroid", "centered_instance"],
    });

    expect(result).not.toBeNull();
    expect(result!.modelType).toBe("top_down");
    expect(result!.configs).toHaveLength(2);
    expect(result!.configs[0].slot).toBe("centroid");
    expect(result!.configs[1].slot).toBe("centered_instance");
  });

  it("reconstructs a single-job single_animal run", () => {
    const result = seedFromJobSpec({
      config_contents: [makeYaml("single_instance")],
      model_types: ["single_instance"],
    });

    expect(result).not.toBeNull();
    expect(result!.modelType).toBe("single_animal");
    expect(result!.configs).toHaveLength(1);
    expect(result!.configs[0].slot).toBe("config");
  });

  it("returns null for a head-type set that doesn't match any known pipeline", () => {
    const result = seedFromJobSpec({
      config_contents: [makeYaml("some_future_head_type")],
      model_types: ["some_future_head_type"],
    });

    expect(result).toBeNull();
  });
});
