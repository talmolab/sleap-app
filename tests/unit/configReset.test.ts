import { describe, it, expect, beforeEach } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useTrainingStore, defaultHyperparams } from "@/stores/trainingStore";
import type { ConfigFile, ConfigHyperparams } from "@/stores/trainingStore";

function makeConfig(hp: Partial<ConfigHyperparams> = {}): ConfigFile {
  const hyperparams = { ...defaultHyperparams, ...hp };
  return {
    filename: "t.yaml",
    content: "",
    modelType: "centroid",
    slot: "centroid",
    hyperparams,
    originalHyperparams: { ...hyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
  };
}

describe("config baseline snapshot + reset to as-loaded values", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("parseYamlConfig snapshots originalHyperparams equal to (but distinct from) the parsed hyperparams", () => {
    const yamlText = readFileSync(
      join(import.meta.dir, "../../src/assets/training_profiles/baseline_medium_rf.centroid.yaml"),
      "utf8",
    );
    const result = useTrainingStore.getState().parseYamlConfig(yamlText, "c.yaml", "centroid");
    expect(result).not.toBeNull();
    expect(result!.originalHyperparams).toEqual(result!.hyperparams);
    expect(result!.originalHyperparams).not.toBe(result!.hyperparams); // snapshot copy
  });

  it("resetConfigHyperparams restores ALL fields to the as-loaded baseline (not global defaults)", () => {
    useTrainingStore.getState().addConfigFile(makeConfig({ learningRate: 0.005, maxEpochs: 300 }));
    useTrainingStore.getState().updateConfigHyperparams("centroid", { learningRate: 0.01, maxEpochs: 50 });
    useTrainingStore.getState().resetConfigHyperparams("centroid");
    const hp = useTrainingStore.getState().config.configs[0].hyperparams;
    expect(hp.learningRate).toBe(0.005);
    expect(hp.maxEpochs).toBe(300);
  });

  it("reset does not mutate the originalHyperparams snapshot itself", () => {
    useTrainingStore.getState().addConfigFile(makeConfig({ learningRate: 0.005 }));
    useTrainingStore.getState().updateConfigHyperparams("centroid", { learningRate: 0.01 });
    useTrainingStore.getState().resetConfigHyperparams("centroid");
    expect(useTrainingStore.getState().config.configs[0].originalHyperparams.learningRate).toBe(0.005);
  });
});
