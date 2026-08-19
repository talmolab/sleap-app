import { describe, it, expect, beforeEach } from "../bun-test";
import yaml from "js-yaml";
import { Skeleton, Video, Labels, LabeledFrame, Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import { useTrainingStore } from "@/stores/trainingStore";
import { getConfigSlots, getSlotLabel, defaultHyperparams, applyHyperparamsToYaml, mergeStdoutIntoLog, countUserLabeledFrames } from "@/stores/trainingStore";
import type { ConfigFile } from "@/stores/trainingStore";

/** Helper to create a ConfigFile with default hyperparams */
function makeConfigFile(overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    filename: "test.yaml",
    content: "",
    modelType: "centroid",
    slot: "centroid",
    hyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    ...overrides,
  };
}

describe("trainingStore", () => {
  beforeEach(() => {
    useTrainingStore.getState().reset();
  });

  describe("initial state", () => {
    it("starts idle with default config", () => {
      const state = useTrainingStore.getState();
      expect(state.status).toBe("idle");
      expect(state.config.modelType).toBe("top_down");
      expect(state.config.configs).toEqual([]);
    });
  });

  describe("setConfig", () => {
    it("updates model type", () => {
      useTrainingStore.getState().setConfig("modelType", "bottom_up");
      expect(useTrainingStore.getState().config.modelType).toBe("bottom_up");
    });

    it("updates training labels path", () => {
      useTrainingStore.getState().setConfig("trainingLabelsPath", "/data/labels.slp");
      expect(useTrainingStore.getState().config.trainingLabelsPath).toBe("/data/labels.slp");
    });
  });

  describe("addConfigFile / removeConfigFile", () => {
    it("adds a config file to the correct slot", () => {
      const file = makeConfigFile();
      useTrainingStore.getState().addConfigFile(file);
      expect(useTrainingStore.getState().config.configs).toHaveLength(1);
      expect(useTrainingStore.getState().config.configs[0].slot).toBe("centroid");
    });

    it("replaces existing file in same slot", () => {
      const file1 = makeConfigFile({ filename: "old.yaml" });
      const file2 = makeConfigFile({ filename: "new.yaml" });
      useTrainingStore.getState().addConfigFile(file1);
      useTrainingStore.getState().addConfigFile(file2);
      expect(useTrainingStore.getState().config.configs).toHaveLength(1);
      expect(useTrainingStore.getState().config.configs[0].filename).toBe("new.yaml");
    });

    it("removes a config file by slot", () => {
      useTrainingStore.getState().addConfigFile(makeConfigFile());
      useTrainingStore.getState().removeConfigFile("centroid");
      expect(useTrainingStore.getState().config.configs).toHaveLength(0);
    });
  });

  describe("updateConfigHyperparams", () => {
    it("updates hyperparams for a specific slot", () => {
      useTrainingStore.getState().addConfigFile(makeConfigFile());
      useTrainingStore.getState().updateConfigHyperparams("centroid", { maxEpochs: 500, batchSize: 16 });
      const cf = useTrainingStore.getState().config.configs[0];
      expect(cf.hyperparams.maxEpochs).toBe(500);
      expect(cf.hyperparams.batchSize).toBe(16);
      // unchanged fields stay default
      expect(cf.hyperparams.learningRate).toBe(0.0001);
    });

    it("does not affect other slots", () => {
      useTrainingStore.getState().addConfigFile(makeConfigFile({ slot: "centroid" }));
      useTrainingStore.getState().addConfigFile(makeConfigFile({ slot: "centered_instance", modelType: "centered_instance" }));
      useTrainingStore.getState().updateConfigHyperparams("centroid", { maxEpochs: 300 });
      const configs = useTrainingStore.getState().config.configs;
      expect(configs.find((c) => c.slot === "centroid")!.hyperparams.maxEpochs).toBe(300);
      expect(configs.find((c) => c.slot === "centered_instance")!.hyperparams.maxEpochs).toBe(100);
    });
  });

  describe("parseYamlConfig", () => {
    it("parses valid YAML and extracts model type + hyperparams", () => {
      const yamlText = `
model_config:
  backbone_config:
    unet:
      filters: 32
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  max_epochs: 200
  train_data_loader:
    batch_size: 8
  optimizer:
    lr: 0.001
  run_name: my_run
  use_wandb: true
  wandb:
    entity: my-lab
    project: my-project
data_config:
  train_labels_path: /path/to/labels.slp
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "centroid.yaml", "centroid");
      expect(result).not.toBeNull();
      expect(result!.modelType).toBe("centroid");
      expect(result!.filename).toBe("centroid.yaml");
      // Per-config hyperparams
      expect(result!.hyperparams.maxEpochs).toBe(200);
      expect(result!.hyperparams.batchSize).toBe(8);
      expect(result!.hyperparams.learningRate).toBe(0.001);
      // run_name is always blanked on import (see "always resets machine/run
      // fields on import" below) even though this file has one — the file's
      // run_name still drives `hasTrainedModel` detection separately.
      expect(result!.hyperparams.runName).toBe("");
      expect(result!.hyperparams.backbone).toBe("unet");
      expect(result!.hyperparams.useWandb).toBe(true);
      expect(result!.hyperparams.wandbEntity).toBe("my-lab");
      expect(result!.hyperparams.wandbProject).toBe("my-project");
      // Data path is NOT auto-filled from the uploaded config — it's specific
      // to whatever machine/project the config came from and must always
      // come from the currently loaded project instead (same rationale as
      // the machine/run fields above).
      expect(useTrainingStore.getState().config.trainingLabelsPath).toBe("");
    });

    it("returns null for invalid YAML", () => {
      const result = useTrainingStore.getState().parseYamlConfig("not: [valid: yaml", "bad.yaml", "config");
      expect(result).toBeNull();
    });

    it("handles config without wandb section", () => {
      const yamlText = `
model_config:
  head_configs:
    centered_instance:
      confmaps:
        sigma: 2.5
trainer_config:
  max_epochs: 200
  use_wandb: false
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "ci.yaml", "centered_instance");
      expect(result).not.toBeNull();
      expect(result!.hyperparams.useWandb).toBe(false);
      expect(result!.hyperparams.wandbEntity).toBe("");
      expect(result!.hyperparams.wandbProject).toBe("");
    });

    it("parses overfitMode from use_same_data_for_val", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  use_same_data_for_val: true
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result).not.toBeNull();
      expect(result!.hyperparams.overfitMode).toBe(true);
    });

    it("detects hasTrainedModel from run_name", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  run_name: my_trained_model
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hasTrainedModel).toBe(true);
    });

    it("hasTrainedModel is false when no run_name", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hasTrainedModel).toBe(false);
    });

    it("does not auto-fill the global data path from an array-valued train_labels_path either", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  train_labels_path:
    - /path/first.slp
    - /path/second.slp
`;
      useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(useTrainingStore.getState().config.trainingLabelsPath).toBe("");
    });

    it("does not clobber an already-set data path when importing another config", () => {
      useTrainingStore.getState().setConfig("trainingLabelsPath", "/current/project.slp");
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  train_labels_path: /some/other/machines/labels.slp
  val_labels_path: /some/other/machines/val.slp
`;
      useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(useTrainingStore.getState().config.trainingLabelsPath).toBe("/current/project.slp");
      expect(useTrainingStore.getState().config.validationLabelsPath).toBe("");
    });
  });

  describe("reset", () => {
    it("resets to initial state", () => {
      useTrainingStore.getState().addConfigFile(
        makeConfigFile({ hyperparams: { ...defaultHyperparams, maxEpochs: 999 } }),
      );
      useTrainingStore.getState().reset();
      expect(useTrainingStore.getState().config.configs).toEqual([]);
      expect(useTrainingStore.getState().status).toBe("idle");
    });
  });

  describe("getConfigSlots", () => {
    it("returns two slots for top_down", () => {
      expect(getConfigSlots("top_down")).toEqual(["centroid", "centered_instance"]);
    });

    it("returns one slot for single_animal", () => {
      expect(getConfigSlots("single_animal")).toEqual(["config"]);
    });

    it("returns one slot for bottom_up", () => {
      expect(getConfigSlots("bottom_up")).toEqual(["config"]);
    });
  });

  describe("getSlotLabel", () => {
    it("returns correct labels", () => {
      expect(getSlotLabel("centroid")).toBe("Centroid Config");
      expect(getSlotLabel("centered_instance")).toBe("Centered Instance Config");
      expect(getSlotLabel("config")).toBe("Config");
    });
  });

  describe("applyHyperparamsToYaml", () => {
    it("writes overfitMode to use_same_data_for_val", () => {
      const input = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;
      const hp = { ...defaultHyperparams, overfitMode: true };
      const result = applyHyperparamsToYaml(input, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.data_config.use_same_data_for_val).toBe(true);
    });
  });

  describe("applyHyperparamsToYaml - augmentation", () => {
    const baseYaml = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;

    it("writes rotation ±180° correctly", () => {
      const hp = { ...defaultHyperparams, rotationPreset: "180" as const };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const aug = doc.data_config.augmentation_config;
      expect(aug.geometric.rotation_min).toBe(-180);
      expect(aug.geometric.rotation_max).toBe(180);
      expect(aug.geometric.affine_p).toBe(1.0);
    });

    it("writes rotation off correctly", () => {
      const hp = { ...defaultHyperparams, rotationPreset: "off" as const };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const aug = doc.data_config.augmentation_config;
      expect(aug.geometric.affine_p).toBe(0);
    });

    it("writes rotation ±15° correctly", () => {
      const hp = { ...defaultHyperparams, rotationPreset: "15" as const };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const geo = doc.data_config.augmentation_config.geometric;
      expect(geo.rotation_min).toBe(-15);
      expect(geo.rotation_max).toBe(15);
      expect(geo.affine_p).toBe(1.0);
    });

    it("writes custom rotation angle correctly", () => {
      const hp = { ...defaultHyperparams, rotationPreset: "custom" as const, rotationCustomAngle: 30 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const geo = doc.data_config.augmentation_config.geometric;
      expect(geo.rotation_min).toBe(-30);
      expect(geo.rotation_max).toBe(30);
      expect(geo.affine_p).toBe(1.0);
    });

    it("writes scale when enabled", () => {
      const hp = { ...defaultHyperparams, scaleEnabled: true, scaleMin: 0.8, scaleMax: 1.2 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const geo = doc.data_config.augmentation_config.geometric;
      expect(geo.scale_min).toBe(0.8);
      expect(geo.scale_max).toBe(1.2);
    });

    it("resets scale_min/max to 1.0 when scale disabled", () => {
      const hp = { ...defaultHyperparams, scaleEnabled: false };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const geo = doc.data_config.augmentation_config.geometric;
      expect(geo.scale_min).toBe(1.0);
      expect(geo.scale_max).toBe(1.0);
    });

    it("writes gaussian noise when enabled", () => {
      const hp = { ...defaultHyperparams, gaussianNoiseEnabled: true, gaussianNoiseMean: 0.0, gaussianNoiseStd: 0.04 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const int = doc.data_config.augmentation_config.intensity;
      expect(int.gaussian_noise_p).toBe(1.0);
      expect(int.gaussian_noise_mean).toBe(0.0);
      expect(int.gaussian_noise_std).toBe(0.04);
    });

    it("sets gaussian_noise_p to 0 when disabled", () => {
      const hp = { ...defaultHyperparams, gaussianNoiseEnabled: false };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const int = doc.data_config.augmentation_config.intensity;
      expect(int.gaussian_noise_p).toBe(0);
    });

    it("writes uniform noise when enabled", () => {
      const hp = { ...defaultHyperparams, uniformNoiseEnabled: true, uniformNoiseMin: 0.0, uniformNoiseMax: 0.1 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const int = doc.data_config.augmentation_config.intensity;
      expect(int.uniform_noise_p).toBe(1.0);
      expect(int.uniform_noise_min).toBe(0.0);
      expect(int.uniform_noise_max).toBe(0.1);
    });

    it("writes contrast when enabled", () => {
      const hp = { ...defaultHyperparams, contrastEnabled: true, contrastMin: 0.5, contrastMax: 2.0 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const int = doc.data_config.augmentation_config.intensity;
      expect(int.contrast_p).toBe(1.0);
      expect(int.contrast_min).toBe(0.5);
      expect(int.contrast_max).toBe(2.0);
    });

    it("writes brightness when enabled", () => {
      const hp = { ...defaultHyperparams, brightnessEnabled: true, brightnessMin: 0.0, brightnessMax: 0.2 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const int = doc.data_config.augmentation_config.intensity;
      expect(int.brightness_p).toBe(1.0);
      expect(int.brightness_min).toBe(0.0);
      expect(int.brightness_max).toBe(0.2);
    });
  });

  describe("applyHyperparamsToYaml - model params", () => {
    const baseYaml = `
data_config: {}
model_config:
  backbone_config:
    unet:
      filters: 16
      max_stride: 16
  head_configs:
    centroid:
      confmaps:
        sigma: 2.5
        output_stride: 2
trainer_config: {}
`;

    it("writes backbone model params to YAML", () => {
      const hp = { ...defaultHyperparams, maxStride: 32, filters: 24, filtersRate: 1.5, middleBlock: false, upInterpolate: false };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const unet = doc.model_config.backbone_config.unet;
      expect(unet.max_stride).toBe(32);
      expect(unet.filters).toBe(24);
      expect(unet.filters_rate).toBe(1.5);
      expect(unet.middle_block).toBe(false);
      expect(unet.up_interpolate).toBe(false);
    });

    it("writes output_stride to head config", () => {
      const hp = { ...defaultHyperparams, outputStride: 4 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.model_config.head_configs.centroid.confmaps.output_stride).toBe(4);
    });

    it("writes stem_stride to backbone config", () => {
      const hp = { ...defaultHyperparams, stemStride: 2 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.model_config.backbone_config.unet.stem_stride).toBe(2);
    });

    it("writes anchor_part to head config", () => {
      const hp = { ...defaultHyperparams, anchorPart: "thorax" };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.model_config.head_configs.centroid.confmaps.anchor_part).toBe("thorax");
    });
  });

  describe("parseYamlConfig - model params", () => {
    it("extracts backbone params from YAML", () => {
      const yamlText = `
model_config:
  backbone_config:
    unet:
      filters: 24
      filters_rate: 1.5
      max_stride: 32
      stem_stride: 2
      middle_block: false
      up_interpolate: false
  head_configs:
    centered_instance:
      confmaps:
        output_stride: 4
        anchor_part: thorax
        sigma: 2.5
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "ci.yaml", "centered_instance");
      expect(result!.hyperparams.filters).toBe(24);
      expect(result!.hyperparams.filtersRate).toBe(1.5);
      expect(result!.hyperparams.maxStride).toBe(32);
      expect(result!.hyperparams.stemStride).toBe(2);
      expect(result!.hyperparams.middleBlock).toBe(false);
      expect(result!.hyperparams.upInterpolate).toBe(false);
      expect(result!.hyperparams.outputStride).toBe(4);
      expect(result!.hyperparams.anchorPart).toBe("thorax");
    });
  });

  describe("applyHyperparamsToYaml - data and optimization", () => {
    const baseYaml = `
data_config:
  preprocessing: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  early_stopping: {}
  online_hard_keypoint_mining: {}
`;

    it("writes cropSize to preprocessing", () => {
      const hp = { ...defaultHyperparams, cropSize: 192 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.data_config.preprocessing.crop_size).toBe(192);
    });

    it("writes null cropSize as null", () => {
      const hp = { ...defaultHyperparams, cropSize: null };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.data_config.preprocessing.crop_size).toBeNull();
    });

    it("writes randomSeed to trainer_config.seed", () => {
      const hp = { ...defaultHyperparams, randomSeed: 42 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.trainer_config.seed).toBe(42);
    });

    it("writes stop_training_on_plateau", () => {
      const hp = { ...defaultHyperparams, stopOnPlateau: false };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.trainer_config.early_stopping.stop_training_on_plateau).toBe(false);
    });

    it("writes plateauMinDelta to early_stopping.min_delta", () => {
      const hp = { ...defaultHyperparams, plateauMinDelta: 0.001 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      expect(doc.trainer_config.early_stopping.min_delta).toBe(0.001);
    });

    it("writes online mining params", () => {
      const hp = { ...defaultHyperparams, onlineMining: true, minHardKeypoints: 3, maxHardKeypoints: 10 };
      const result = applyHyperparamsToYaml(baseYaml, hp);
      const doc = yaml.load(result) as Record<string, any>;
      const ohkm = doc.trainer_config.online_hard_keypoint_mining;
      expect(ohkm.online_mining).toBe(true);
      expect(ohkm.min_hard_keypoints).toBe(3);
      expect(ohkm.max_hard_keypoints).toBe(10);
    });
  });

  describe("applyHyperparamsToYaml - performance", () => {
    const baseYaml = `
data_config:
  preprocessing: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  train_data_loader: {}
  val_data_loader: {}
`;

    it("maps dataPipeline 'memory' → data_pipeline_fw torch_dataset_cache_img_memory", () => {
      const hp = { ...defaultHyperparams, dataPipeline: "memory" as const };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.data_config.data_pipeline_fw).toBe("torch_dataset_cache_img_memory");
    });

    it("maps dataPipeline 'disk' → data_pipeline_fw torch_dataset_cache_img_disk", () => {
      const hp = { ...defaultHyperparams, dataPipeline: "disk" as const };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.data_config.data_pipeline_fw).toBe("torch_dataset_cache_img_disk");
    });

    it("maps dataPipeline 'stream' → data_pipeline_fw torch_dataset", () => {
      const hp = { ...defaultHyperparams, dataPipeline: "stream" as const };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.data_config.data_pipeline_fw).toBe("torch_dataset");
    });

    it("writes dataloaderWorkers to both train and val loaders (caching pipeline)", () => {
      const hp = { ...defaultHyperparams, dataPipeline: "memory" as const, dataloaderWorkers: 4 };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.train_data_loader.num_workers).toBe(4);
      expect(doc.trainer_config.val_data_loader.num_workers).toBe(4);
    });

    it("clamps num_workers to 0 when pipeline is 'stream' (torch_dataset)", () => {
      const hp = { ...defaultHyperparams, dataPipeline: "stream" as const, dataloaderWorkers: 8 };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.train_data_loader.num_workers).toBe(0);
      expect(doc.trainer_config.val_data_loader.num_workers).toBe(0);
    });

    it("writes numDevices 'auto' to trainer_devices", () => {
      const hp = { ...defaultHyperparams, numDevices: "auto" as const };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.trainer_devices).toBe("auto");
    });

    it("writes numeric numDevices to trainer_devices", () => {
      const hp = { ...defaultHyperparams, numDevices: 2 };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.trainer_devices).toBe(2);
    });
  });

  describe("parseYamlConfig - performance", () => {
    it("parses dataPipeline (a training-recipe choice) from the file", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  data_pipeline_fw: torch_dataset_cache_img_memory
trainer_config:
  train_data_loader:
    num_workers: 4
  trainer_devices: 2
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.dataPipeline).toBe("memory");
    });

    it("always resets dataloaderWorkers and numDevices to defaults, regardless of the file", () => {
      // Machine-specific settings — never taken from an uploaded config (see
      // the "always resets machine/run fields on import" describe block).
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  data_pipeline_fw: torch_dataset
trainer_config:
  train_data_loader:
    num_workers: 4
  trainer_devices: 2
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.dataloaderWorkers).toBe(defaultHyperparams.dataloaderWorkers);
      expect(result!.hyperparams.numDevices).toBe(defaultHyperparams.numDevices);
    });

    it("round-trips dataPipeline (not device/worker fields) through parse → apply", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  data_pipeline_fw: torch_dataset_cache_img_disk
trainer_config:
  train_data_loader:
    num_workers: 3
  val_data_loader:
    num_workers: 3
  trainer_devices: 4
`;
      const parsed = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      const doc = yaml.load(applyHyperparamsToYaml(yamlText, parsed!.hyperparams)) as Record<string, any>;
      expect(doc.data_config.data_pipeline_fw).toBe("torch_dataset_cache_img_disk");
      // Forced back to the default worker/device count, not the file's stale 3/4.
      expect(doc.trainer_config.train_data_loader.num_workers).toBe(defaultHyperparams.dataloaderWorkers);
      expect(doc.trainer_config.val_data_loader.num_workers).toBe(defaultHyperparams.dataloaderWorkers);
      expect(doc.trainer_config.trainer_devices).toBe(defaultHyperparams.numDevices);
    });
  });

  describe("parseYamlConfig - always resets machine/run fields on import", () => {
    const yamlWithStaleFields = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  run_name: stale_run_from_another_machine
  trainer_accelerator: mps
  trainer_devices: 3
  train_data_loader:
    num_workers: 8
`;

    it("blanks runName even when the file has one", () => {
      const result = useTrainingStore.getState().parseYamlConfig(yamlWithStaleFields, "c.yaml", "centroid");
      expect(result!.hyperparams.runName).toBe("");
    });

    it("still detects hasTrainedModel from the file's run_name despite blanking the field", () => {
      const result = useTrainingStore.getState().parseYamlConfig(yamlWithStaleFields, "c.yaml", "centroid");
      expect(result!.hasTrainedModel).toBe(true);
    });

    it("resets accelerator to the default instead of the file's (possibly unavailable) value", () => {
      const result = useTrainingStore.getState().parseYamlConfig(yamlWithStaleFields, "c.yaml", "centroid");
      expect(result!.hyperparams.accelerator).toBe(defaultHyperparams.accelerator);
    });

    it("resets numDevices and dataloaderWorkers to defaults", () => {
      const result = useTrainingStore.getState().parseYamlConfig(yamlWithStaleFields, "c.yaml", "centroid");
      expect(result!.hyperparams.numDevices).toBe(defaultHyperparams.numDevices);
      expect(result!.hyperparams.dataloaderWorkers).toBe(defaultHyperparams.dataloaderWorkers);
    });
  });

  describe("applyHyperparamsToYaml - wandb.name staleness", () => {
    it("clears a pre-existing wandb.name (no UI field for it) so a stale run id can't ride through", () => {
      const yamlText = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  use_wandb: true
  wandb:
    entity: my-lab
    project: my-project
    name: some-old-run-id
`;
      const hp = { ...defaultHyperparams, useWandb: true, wandbEntity: "my-lab", wandbProject: "my-project" };
      const doc = yaml.load(applyHyperparamsToYaml(yamlText, hp)) as Record<string, any>;
      expect(doc.trainer_config.wandb.name).toBeUndefined();
      expect(doc.trainer_config.wandb.entity).toBe("my-lab");
      expect(doc.trainer_config.wandb.project).toBe("my-project");
    });
  });

  describe("applyHyperparamsToYaml - skeleton erasure", () => {
    it("erases a skeleton baked into an imported config — sleap-nn re-derives it from the real training data", () => {
      const yamlText = `
data_config:
  skeletons:
    - nodes:
        - name: head
        - name: tail
      edges: []
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;
      const doc = yaml.load(applyHyperparamsToYaml(yamlText, defaultHyperparams)) as Record<string, any>;
      expect(doc.data_config.skeletons).toEqual([]);
    });
  });

  describe("applyHyperparamsToYaml - run_name overwrite", () => {
    it("overwrites a stale baked-in run_name once a fresh one is resolved", () => {
      // Simulates the remote-training call site: `hyperparams.runName` is
      // always blank right after import (parseYamlConfig), but the caller
      // resolves a fresh name and passes `{ ...hyperparams, runName: fresh }`
      // into applyHyperparamsToYaml before serializing for the worker — there
      // is no Hydra CLI-override safety net for remote jobs, so this is the
      // only thing standing between an imported config's stale run_name and
      // the actual remote job.
      const yamlText = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  run_name: stale_run_from_another_machine
`;
      const hp = { ...defaultHyperparams, runName: "260818_143022.centroid.n=13" };
      const doc = yaml.load(applyHyperparamsToYaml(yamlText, hp)) as Record<string, any>;
      expect(doc.trainer_config.run_name).toBe("260818_143022.centroid.n=13");
    });
  });

  describe("applyHyperparamsToYaml - checkpoint saving", () => {
    const baseYaml = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;

    it("writes save_top_k=1 and save_last=false by default (Best Model on, Latest Model off)", () => {
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, defaultHyperparams)) as Record<string, any>;
      expect(doc.trainer_config.model_ckpt.save_top_k).toBe(1);
      expect(doc.trainer_config.model_ckpt.save_last).toBe(false);
    });

    it("writes save_top_k=0 when Best Model is unchecked", () => {
      const hp = { ...defaultHyperparams, saveBestModel: false };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.model_ckpt.save_top_k).toBe(0);
    });

    it("writes save_last=true when Latest Model is checked — this is the last.ckpt fix", () => {
      const hp = { ...defaultHyperparams, saveLastModel: true };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.model_ckpt.save_last).toBe(true);
    });
  });

  describe("applyHyperparamsToYaml - visualization", () => {
    const baseYaml = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;

    it("writes both fields true by default (fixes the previously-inert epoch-viz-scrubber)", () => {
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, defaultHyperparams)) as Record<string, any>;
      expect(doc.trainer_config.visualize_preds_during_training).toBe(true);
      expect(doc.trainer_config.keep_viz).toBe(true);
    });

    it("keep_viz is false whenever visualizePredictions is off, regardless of keepVizImages", () => {
      const hp = { ...defaultHyperparams, visualizePredictions: false, keepVizImages: true };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.visualize_preds_during_training).toBe(false);
      expect(doc.trainer_config.keep_viz).toBe(false);
    });

    it("keep_viz is false when keepVizImages is off even if visualizePredictions is on", () => {
      const hp = { ...defaultHyperparams, visualizePredictions: true, keepVizImages: false };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.keep_viz).toBe(false);
    });
  });

  describe("applyHyperparamsToYaml - color conversion", () => {
    const baseYaml = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;

    it("writes both ensure_rgb/ensure_grayscale false for 'auto'", () => {
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, defaultHyperparams)) as Record<string, any>;
      expect(doc.data_config.preprocessing.ensure_rgb).toBe(false);
      expect(doc.data_config.preprocessing.ensure_grayscale).toBe(false);
    });

    it("writes ensure_rgb=true for 'rgb'", () => {
      const hp = { ...defaultHyperparams, colorMode: "rgb" as const };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.data_config.preprocessing.ensure_rgb).toBe(true);
      expect(doc.data_config.preprocessing.ensure_grayscale).toBe(false);
    });

    it("writes ensure_grayscale=true for 'grayscale'", () => {
      const hp = { ...defaultHyperparams, colorMode: "grayscale" as const };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.data_config.preprocessing.ensure_rgb).toBe(false);
      expect(doc.data_config.preprocessing.ensure_grayscale).toBe(true);
    });
  });

  describe("applyHyperparamsToYaml - epoch-end evaluation", () => {
    it("writes eval.enabled and eval.frequency", () => {
      const baseYaml = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;
      const hp = { ...defaultHyperparams, evalEnabled: true, evalFrequency: 5 };
      const doc = yaml.load(applyHyperparamsToYaml(baseYaml, hp)) as Record<string, any>;
      expect(doc.trainer_config.eval.enabled).toBe(true);
      expect(doc.trainer_config.eval.frequency).toBe(5);
    });
  });

  describe("applyHyperparamsToYaml - W&B extras", () => {
    it("writes save_viz_imgs_wandb, prv_runid, and group when set", () => {
      const yamlText = `
data_config: {}
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  use_wandb: true
`;
      const hp = {
        ...defaultHyperparams,
        useWandb: true,
        wandbUploadViz: true,
        wandbPrevRunId: "abc123",
        wandbGroup: "experiment-1",
      };
      const doc = yaml.load(applyHyperparamsToYaml(yamlText, hp)) as Record<string, any>;
      expect(doc.trainer_config.wandb.save_viz_imgs_wandb).toBe(true);
      expect(doc.trainer_config.wandb.prv_runid).toBe("abc123");
      expect(doc.trainer_config.wandb.group).toBe("experiment-1");
    });
  });

  describe("parseYamlConfig - new Output/Evaluation/W&B fields", () => {
    it("applies sensible defaults when the file omits these keys entirely", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config: {}
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.saveBestModel).toBe(true);
      expect(result!.hyperparams.saveLastModel).toBe(false);
      expect(result!.hyperparams.visualizePredictions).toBe(true);
      expect(result!.hyperparams.keepVizImages).toBe(true);
      expect(result!.hyperparams.colorMode).toBe("auto");
      expect(result!.hyperparams.evalEnabled).toBe(false);
      expect(result!.hyperparams.evalFrequency).toBe(1);
      expect(result!.hyperparams.wandbUploadViz).toBe(false);
      expect(result!.hyperparams.wandbPrevRunId).toBe("");
      expect(result!.hyperparams.wandbGroup).toBe("");
    });

    it("respects explicit values in the file, including explicit false overriding the app default", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  model_ckpt:
    save_top_k: 0
    save_last: true
  visualize_preds_during_training: false
  keep_viz: false
  eval:
    enabled: true
    frequency: 3
  wandb:
    save_viz_imgs_wandb: true
    prv_runid: xyz789
    group: my-group
data_config:
  preprocessing:
    ensure_rgb: true
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.saveBestModel).toBe(false);
      expect(result!.hyperparams.saveLastModel).toBe(true);
      expect(result!.hyperparams.visualizePredictions).toBe(false);
      expect(result!.hyperparams.keepVizImages).toBe(false);
      expect(result!.hyperparams.colorMode).toBe("rgb");
      expect(result!.hyperparams.evalEnabled).toBe(true);
      expect(result!.hyperparams.evalFrequency).toBe(3);
      expect(result!.hyperparams.wandbUploadViz).toBe(true);
      expect(result!.hyperparams.wandbPrevRunId).toBe("xyz789");
      expect(result!.hyperparams.wandbGroup).toBe("my-group");
    });

    it("colorMode reads grayscale correctly", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  preprocessing:
    ensure_grayscale: true
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.colorMode).toBe("grayscale");
    });
  });

  describe("parseYamlConfig - data and optimization", () => {
    it("parses cropSize from preprocessing", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  preprocessing:
    crop_size: 192
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.cropSize).toBe(192);
    });

    it("defaults cropSize to null when not present", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config: {}
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.cropSize).toBeNull();
    });

    it("parses randomSeed from trainer_config.seed", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  seed: 42
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.randomSeed).toBe(42);
    });

    it("parses stopOnPlateau false", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  early_stopping:
    stop_training_on_plateau: false
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.stopOnPlateau).toBe(false);
    });

    it("parses online mining params", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  online_hard_keypoint_mining:
    online_mining: true
    min_hard_keypoints: 3
    max_hard_keypoints: 10
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.onlineMining).toBe(true);
      expect(result!.hyperparams.minHardKeypoints).toBe(3);
      expect(result!.hyperparams.maxHardKeypoints).toBe(10);
    });

    it("parses plateauMinDelta from early_stopping.min_delta", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  early_stopping:
    min_delta: 0.001
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.plateauMinDelta).toBe(0.001);
    });
  });

  describe("parseYamlConfig - augmentation reverse-map", () => {
    it("detects rotation ±180° from rotation_min/max", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    geometric:
      rotation_min: -180
      rotation_max: 180
      affine_p: 1.0
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.rotationPreset).toBe("180");
    });

    it("detects rotation off from affine_p=0", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    geometric:
      rotation_min: 0
      rotation_max: 0
      affine_p: 0
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.rotationPreset).toBe("off");
    });

    it("detects rotation ±15°", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    geometric:
      rotation_min: -15
      rotation_max: 15
      affine_p: 1.0
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.rotationPreset).toBe("15");
    });

    it("detects custom rotation from non-standard angles", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    geometric:
      rotation_min: -45
      rotation_max: 45
      affine_p: 1.0
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.rotationPreset).toBe("custom");
      expect(result!.hyperparams.rotationCustomAngle).toBe(45);
    });

    it("detects scale enabled from scale_min != scale_max", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    geometric:
      scale_min: 0.9
      scale_max: 1.1
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.scaleEnabled).toBe(true);
      expect(result!.hyperparams.scaleMin).toBe(0.9);
      expect(result!.hyperparams.scaleMax).toBe(1.1);
    });

    it("detects scale disabled when both are 1.0", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    geometric:
      scale_min: 1.0
      scale_max: 1.0
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.scaleEnabled).toBe(false);
    });

    it("detects gaussian noise enabled from p > 0", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config:
  augmentation_config:
    intensity:
      gaussian_noise_p: 0.5
      gaussian_noise_mean: 0.0
      gaussian_noise_std: 0.04
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.gaussianNoiseEnabled).toBe(true);
      expect(result!.hyperparams.gaussianNoiseStd).toBe(0.04);
    });

    it("defaults augmentation fields when no augmentation_config present", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
data_config: {}
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
      expect(result!.hyperparams.rotationPreset).toBe("180");
      expect(result!.hyperparams.scaleEnabled).toBe(false);
      expect(result!.hyperparams.gaussianNoiseEnabled).toBe(false);
      expect(result!.hyperparams.uniformNoiseEnabled).toBe(false);
      expect(result!.hyperparams.contrastEnabled).toBe(false);
      expect(result!.hyperparams.brightnessEnabled).toBe(false);
    });
  });
});

import type { ModelProgress } from "@/stores/trainingStore";

function makeModel(over: Partial<ModelProgress> = {}): ModelProgress {
  return {
    label: "Centroid", epoch: 0, maxEpochs: 100, loss: null, valLoss: null,
    bestValLoss: null, status: "running",
    epochSamples: [], batchSamples: [],
    epochSize: 1, lastBatchNumber: 0,
    metrics: { meanEpochTimeSec: null, etaNext10Min: null, epochsInPlateau: 0, inPlateau: false, bestValEpoch: null },
    epochStartedAt: null, plateauPatience: 10, plateauMinDelta: null,
    runDir: null,
    ...over,
  };
}

describe("recordEpoch", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("appends an epoch sample and updates scalars", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    useTrainingStore.getState().recordEpoch(0, { epoch: 0, trainLoss: 1.0, valLoss: 0.9 });
    const m = useTrainingStore.getState().models[0];
    expect(m.epochSamples).toHaveLength(1);
    expect(m.epochSamples[0]).toEqual({ epoch: 0, trainLoss: 1.0, valLoss: 0.9 });
    expect(m.epoch).toBe(1);          // PyQt displays epoch+1
    expect(m.loss).toBe(1.0);
    expect(m.valLoss).toBe(0.9);
    expect(m.bestValLoss).toBe(0.9);
  });

  it("tracks best val loss across epochs and recomputes metrics", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    const s = useTrainingStore.getState();
    s.recordEpoch(0, { epoch: 0, trainLoss: 1.0, valLoss: 0.5 });
    s.recordEpoch(0, { epoch: 1, trainLoss: 0.8, valLoss: 0.6 }); // worse
    const m = useTrainingStore.getState().models[0];
    expect(m.bestValLoss).toBe(0.5);
    expect(m.metrics.bestValEpoch).toBe(0);
    expect(m.metrics.inPlateau).toBe(true);
    expect(m.epochSamples).toHaveLength(2);
  });

  it("ignores out-of-range model index safely", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    expect(() => useTrainingStore.getState().recordEpoch(5, { epoch: 0, trainLoss: 1, valLoss: 1 })).not.toThrow();
  });

  it("recordEpoch preserves prior loss/valLoss when a sample field is null", () => {
    useTrainingStore.setState({ models: [makeModel({ loss: 0.7, valLoss: 0.6, bestValLoss: 0.6 })], startedAt: 0 });
    useTrainingStore.getState().recordEpoch(0, { epoch: 0, trainLoss: null, valLoss: null });
    const m = useTrainingStore.getState().models[0];
    expect(m.loss).toBe(0.7);        // unchanged (sample.trainLoss was null)
    expect(m.valLoss).toBe(0.6);     // unchanged (sample.valLoss was null)
    expect(m.bestValLoss).toBe(0.6); // unchanged (no new val loss)
    expect(m.epochSamples).toHaveLength(1);
  });
});

describe("recordBatch / epochSize", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("computes globalBatch = epoch*epochSize + batch (epochSize starts at 1)", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    useTrainingStore.getState().recordBatch(0, { epoch: 0, batch: 5, loss: 0.4 });
    const m = useTrainingStore.getState().models[0];
    expect(m.batchSamples).toEqual([{ globalBatch: 5, loss: 0.4 }]); // 0*1+5
    expect(m.lastBatchNumber).toBe(5);
  });

  it("recordEpoch learns epochSize from lastBatchNumber, used by later batches", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    const s = useTrainingStore.getState();
    s.recordBatch(0, { epoch: 0, batch: 5, loss: 0.4 });          // lastBatch=5
    s.recordEpoch(0, { epoch: 0, trainLoss: 0.4, valLoss: 0.5 }); // epochSize = max(1,6) = 6
    expect(useTrainingStore.getState().models[0].epochSize).toBe(6);
    s.recordBatch(0, { epoch: 1, batch: 2, loss: 0.3 });          // 1*6+2 = 8
    const m = useTrainingStore.getState().models[0];
    expect(m.batchSamples[m.batchSamples.length - 1]).toEqual({ globalBatch: 8, loss: 0.3 });
  });

  it("recordBatches appends multiple points in one update", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    useTrainingStore.getState().recordBatches(0, [
      { epoch: 0, batch: 0, loss: 1.0 },
      { epoch: 0, batch: 1, loss: 0.9 },
    ]);
    expect(useTrainingStore.getState().models[0].batchSamples).toEqual([
      { globalBatch: 0, loss: 1.0 },
      { globalBatch: 1, loss: 0.9 },
    ]);
  });

  it("ignores out-of-range model index safely", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    expect(() => useTrainingStore.getState().recordBatch(9, { epoch: 0, batch: 0, loss: 1 })).not.toThrow();
    expect(() => useTrainingStore.getState().recordBatches(9, [{ epoch: 0, batch: 0, loss: 1 }])).not.toThrow();
  });
});

describe("markEpochBegin / epochStartedAt", () => {
  beforeEach(() => useTrainingStore.getState().reset());
  it("recordEpoch keeps epochStartedAt (set by epoch_begin)", () => {
    useTrainingStore.setState({ models: [makeModel({ epochStartedAt: 1000 })], startedAt: 0 });
    useTrainingStore.getState().recordEpoch(0, { epoch: 0, trainLoss: 1, valLoss: 1 });
    expect(useTrainingStore.getState().models[0].epochStartedAt).toBe(1000);
  });
  it("markEpochBegin sets epoch and stamps epochStartedAt", () => {
    useTrainingStore.setState({ models: [makeModel()], startedAt: 0 });
    useTrainingStore.getState().markEpochBegin(0, 3);
    const m = useTrainingStore.getState().models[0];
    expect(m.epoch).toBe(3);
    expect(typeof m.epochStartedAt).toBe("number");
  });

  describe("mergeStdoutIntoLog (tqdm coalescing)", () => {
    it("appends normal (non-progress) lines", () => {
      expect(mergeStdoutIntoLog([], ["hello", "world"])).toEqual(["hello", "world"]);
    });

    it("coalesces consecutive tqdm progress lines into one in-place line", () => {
      const out = mergeStdoutIntoLog([], [
        "Epoch 0:  10%|#         | 2/20 [00:00<00:01, loss=0.5]",
        "Epoch 0:  50%|#####     | 10/20 [00:01<00:01, loss=0.3]",
        "Epoch 0: 100%|##########| 20/20 [00:02<00:00, loss=0.1]",
      ]);
      expect(out).toEqual(["Epoch 0: 100%|##########| 20/20 [00:02<00:00, loss=0.1]"]);
    });

    it("keeps non-progress lines that bracket a progress bar", () => {
      const out = mergeStdoutIntoLog([], [
        "starting",
        "Epoch 0:  10%|#         | 2/20",
        "Epoch 0:  90%|######### | 18/20",
        "done",
      ]);
      expect(out).toEqual(["starting", "Epoch 0:  90%|######### | 18/20", "done"]);
    });

    it("coalesces across calls (replaces a trailing progress line from prior log)", () => {
      const first = mergeStdoutIntoLog([], ["Epoch 0:  10%|#         | 2/20"]);
      const second = mergeStdoutIntoLog(first, ["Epoch 0:  80%|######## | 16/20"]);
      expect(second).toEqual(["Epoch 0:  80%|######## | 16/20"]);
    });

    it("strips ANSI escape codes and drops blank lines", () => {
      const out = mergeStdoutIntoLog([], ["\x1b[32mgreen\x1b[0m", "   ", ""]);
      expect(out).toEqual(["green"]);
    });
  });

  describe("countUserLabeledFrames", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = new Video({
      filename: "v.mp4",
      backendMetadata: { shape: [10, 100, 100, 3] },
      openBackend: false,
    });

    it("returns null with no project loaded", () => {
      expect(countUserLabeledFrames(null)).toBeNull();
    });

    it("counts frames with a user instance, ignores predicted-only frames, includes negative frames", () => {
      const userFrame = new LabeledFrame({ video, frameIdx: 0 });
      userFrame.instances.push(Instance.empty({ skeleton }));

      const predictedOnlyFrame = new LabeledFrame({ video, frameIdx: 1 });
      predictedOnlyFrame.instances.push(
        new PredictedInstance({
          skeleton,
          points: [{ xy: [0, 0], visible: true, complete: true, name: "a", score: 0.9 }],
          score: 0.9,
        }),
      );

      const negativeFrame = new LabeledFrame({ video, frameIdx: 2 });
      negativeFrame.isNegative = true;

      const emptyFrame = new LabeledFrame({ video, frameIdx: 3 });

      const labels = new Labels({
        videos: [video],
        skeletons: [skeleton],
        labeledFrames: [userFrame, predictedOnlyFrame, negativeFrame, emptyFrame],
      });

      // user-labeled + negative count, NOT predicted-only or empty
      expect(countUserLabeledFrames(labels)).toBe(2);
    });
  });
});
