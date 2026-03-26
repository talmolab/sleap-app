import { describe, it, expect, beforeEach } from "vitest";
import { useTrainingStore } from "@/stores/trainingStore";
import { getConfigSlots, getSlotLabel } from "@/stores/trainingStore";

describe("trainingStore", () => {
  beforeEach(() => {
    useTrainingStore.getState().reset();
  });

  describe("initial state", () => {
    it("starts idle with default config", () => {
      const state = useTrainingStore.getState();
      expect(state.status).toBe("idle");
      expect(state.config.modelType).toBe("top_down");
      expect(state.config.maxEpochs).toBe(100);
      expect(state.config.batchSize).toBe(4);
      expect(state.config.configs).toEqual([]);
    });
  });

  describe("setConfig", () => {
    it("updates a single config field", () => {
      useTrainingStore.getState().setConfig("maxEpochs", 200);
      expect(useTrainingStore.getState().config.maxEpochs).toBe(200);
    });

    it("updates model type", () => {
      useTrainingStore.getState().setConfig("modelType", "bottom_up");
      expect(useTrainingStore.getState().config.modelType).toBe("bottom_up");
    });
  });

  describe("addConfigFile / removeConfigFile", () => {
    it("adds a config file to the correct slot", () => {
      const file = {
        filename: "centroid.yaml",
        content: "test: true",
        modelType: "centroid",
        slot: "centroid",
      };
      useTrainingStore.getState().addConfigFile(file);
      expect(useTrainingStore.getState().config.configs).toHaveLength(1);
      expect(useTrainingStore.getState().config.configs[0].slot).toBe("centroid");
    });

    it("replaces existing file in same slot", () => {
      const file1 = { filename: "old.yaml", content: "", modelType: "centroid", slot: "centroid" };
      const file2 = { filename: "new.yaml", content: "", modelType: "centroid", slot: "centroid" };
      useTrainingStore.getState().addConfigFile(file1);
      useTrainingStore.getState().addConfigFile(file2);
      expect(useTrainingStore.getState().config.configs).toHaveLength(1);
      expect(useTrainingStore.getState().config.configs[0].filename).toBe("new.yaml");
    });

    it("removes a config file by slot", () => {
      const file = { filename: "test.yaml", content: "", modelType: "centroid", slot: "centroid" };
      useTrainingStore.getState().addConfigFile(file);
      useTrainingStore.getState().removeConfigFile("centroid");
      expect(useTrainingStore.getState().config.configs).toHaveLength(0);
    });
  });

  describe("parseYamlConfig", () => {
    it("parses valid YAML and extracts model type", () => {
      const yamlText = `
model_config:
  head_configs:
    centroid:
      sigma: 1.5
trainer_config:
  max_epochs: 200
`;
      const result = useTrainingStore.getState().parseYamlConfig(yamlText, "centroid.yaml", "centroid");
      expect(result).not.toBeNull();
      expect(result!.modelType).toBe("centroid");
      expect(result!.filename).toBe("centroid.yaml");
    });

    it("returns null for invalid YAML", () => {
      const result = useTrainingStore.getState().parseYamlConfig("not: [valid: yaml", "bad.yaml", "config");
      expect(result).toBeNull();
    });
  });

  describe("autoFillFromConfig", () => {
    it("extracts hyperparameters from config", () => {
      const configFile = {
        filename: "test.yaml",
        content: `
trainer_config:
  max_epochs: 300
  train_data_loader:
    batch_size: 8
  optimizer:
    lr: 0.001
  run_name: my_run
  wandb:
    entity: my-lab
    project: my-project
data_config:
  train_labels_path: /path/to/labels.slp
`,
        modelType: "centroid",
        slot: "centroid",
      };
      useTrainingStore.getState().autoFillFromConfig(configFile);
      const config = useTrainingStore.getState().config;
      expect(config.maxEpochs).toBe(300);
      expect(config.batchSize).toBe(8);
      expect(config.learningRate).toBe(0.001);
      expect(config.runName).toBe("my_run");
      expect(config.wandbEntity).toBe("my-lab");
      expect(config.wandbProject).toBe("my-project");
      expect(config.trainingLabelsPath).toBe("/path/to/labels.slp");
    });
  });

  describe("reset", () => {
    it("resets to initial state", () => {
      useTrainingStore.getState().setConfig("maxEpochs", 999);
      useTrainingStore.getState().reset();
      expect(useTrainingStore.getState().config.maxEpochs).toBe(100);
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
});
