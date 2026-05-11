import { describe, it, expect, beforeEach } from "vitest";
import yaml from "js-yaml";
import { useTrainingStore } from "@/stores/trainingStore";
import { getConfigSlots, getSlotLabel, defaultHyperparams, applyHyperparamsToYaml } from "@/stores/trainingStore";
import type { ConfigFile } from "@/stores/trainingStore";

/** Helper to create a ConfigFile with default hyperparams */
function makeConfigFile(overrides: Partial<ConfigFile> = {}): ConfigFile {
  return {
    filename: "test.yaml",
    content: "",
    modelType: "centroid",
    slot: "centroid",
    hyperparams: { ...defaultHyperparams },
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
      expect(result!.hyperparams.runName).toBe("my_run");
      expect(result!.hyperparams.backbone).toBe("unet");
      expect(result!.hyperparams.useWandb).toBe(true);
      expect(result!.hyperparams.wandbEntity).toBe("my-lab");
      expect(result!.hyperparams.wandbProject).toBe("my-project");
      // Data path auto-filled into global config
      expect(useTrainingStore.getState().config.trainingLabelsPath).toBe("/path/to/labels.slp");
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

    it("handles train_labels_path as array", () => {
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
      expect(useTrainingStore.getState().config.trainingLabelsPath).toBe("/path/first.slp");
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
});
