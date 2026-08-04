/**
 * Transfer-learning config round-trip: `model_config.pretrained_backbone_weights`,
 * `model_config.pretrained_head_weights` and `trainer_config.resume_ckpt_path`.
 *
 * These are the fields that let an existing model seed a new run's backbone.
 * sleap-nn reads them straight out of the emitted YAML (sleap_nn/train.py), so
 * the writer is the whole contract — before this they were parsed as nothing and
 * written as nothing, and the "Resume training (fine-tune)" radio was inert.
 */

import { describe, it, expect } from "../bun-test";
import yaml from "js-yaml";
import {
  applyHyperparamsToYaml,
  defaultHyperparams,
  useTrainingStore,
  type ConfigHyperparams,
} from "@/stores/trainingStore";

/** Minimal config with the same shape as the shipped baseline profiles. */
const BASE_YAML = `
data_config:
  preprocessing:
    scale: 1.0
    crop_size: 160
model_config:
  init_weights: default
  pretrained_backbone_weights: null
  pretrained_head_weights: null
  backbone_config:
    unet:
      in_channels: 1
      filters: 16
  head_configs:
    bottomup:
      confmaps: {}
trainer_config:
  max_epochs: 10
  ckpt_dir: models
  run_name: null
  resume_ckpt_path: null
  train_data_loader:
    batch_size: 4
`;

function hpWith(overrides: Partial<ConfigHyperparams>): ConfigHyperparams {
  return { ...defaultHyperparams, ...overrides };
}

function emit(overrides: Partial<ConfigHyperparams>): Record<string, never> & {
  model_config: Record<string, unknown>;
  trainer_config: Record<string, unknown>;
} {
  return yaml.load(applyHyperparamsToYaml(BASE_YAML, hpWith(overrides))) as never;
}

describe("pretrained weights reach the emitted YAML", () => {
  it("writes a backbone checkpoint path sleap-nn will read", () => {
    const doc = emit({ pretrainedBackboneWeights: "/models/bottomup_run/best.ckpt" });
    expect(doc.model_config.pretrained_backbone_weights).toBe(
      "/models/bottomup_run/best.ckpt",
    );
  });

  it("writes head weights and the resume path independently", () => {
    const doc = emit({
      pretrainedHeadWeights: "/models/a/best.ckpt",
      resumeCkptPath: "/models/b/last.ckpt",
    });
    expect(doc.model_config.pretrained_head_weights).toBe("/models/a/best.ckpt");
    expect(doc.trainer_config.resume_ckpt_path).toBe("/models/b/last.ckpt");
  });

  it("defaults to null — an untouched config still trains from scratch", () => {
    const doc = emit({});
    expect(doc.model_config.pretrained_backbone_weights).toBeNull();
    expect(doc.model_config.pretrained_head_weights).toBeNull();
    expect(doc.trainer_config.resume_ckpt_path).toBeNull();
  });

  it("CLEARING a path overwrites the source YAML's value with null", () => {
    // The regression that a write-only-when-set implementation would have: the
    // baseline's stale path would survive and silently keep seeding the run.
    const seeded = BASE_YAML.replace(
      "pretrained_backbone_weights: null",
      "pretrained_backbone_weights: /stale/old.ckpt",
    );
    const doc = yaml.load(
      applyHyperparamsToYaml(seeded, hpWith({ pretrainedBackboneWeights: null })),
    ) as { model_config: Record<string, unknown> };
    expect(doc.model_config.pretrained_backbone_weights).toBeNull();
  });

  it("leaves the rest of model_config alone", () => {
    const doc = emit({ pretrainedBackboneWeights: "/m/best.ckpt" });
    expect(doc.model_config.init_weights).toBe("default");
    expect((doc.model_config.backbone_config as Record<string, unknown>).unet).toBeTruthy();
  });
});

describe("parseYamlConfig round-trips the paths", () => {
  it("reads existing paths instead of dropping them", () => {
    const seeded = BASE_YAML.replace(
      "pretrained_backbone_weights: null",
      "pretrained_backbone_weights: /models/prior/best.ckpt",
    ).replace("resume_ckpt_path: null", "resume_ckpt_path: /models/prior/last.ckpt");

    const parsed = useTrainingStore
      .getState()
      .parseYamlConfig(seeded, "cfg.yaml", "config");
    expect(parsed).not.toBeNull();
    expect(parsed!.hyperparams.pretrainedBackboneWeights).toBe("/models/prior/best.ckpt");
    expect(parsed!.hyperparams.resumeCkptPath).toBe("/models/prior/last.ckpt");
  });

  it("maps YAML nulls to null, not the string 'null'", () => {
    const parsed = useTrainingStore
      .getState()
      .parseYamlConfig(BASE_YAML, "cfg.yaml", "config");
    expect(parsed!.hyperparams.pretrainedBackboneWeights).toBeNull();
    expect(parsed!.hyperparams.pretrainedHeadWeights).toBeNull();
    expect(parsed!.hyperparams.resumeCkptPath).toBeNull();
  });

  it("survives a parse → emit → parse cycle", () => {
    const store = useTrainingStore.getState();
    const first = store.parseYamlConfig(
      BASE_YAML.replace(
        "pretrained_backbone_weights: null",
        "pretrained_backbone_weights: /m/best.ckpt",
      ),
      "cfg.yaml",
      "config",
    )!;
    const round = store.parseYamlConfig(
      applyHyperparamsToYaml(BASE_YAML, first.hyperparams),
      "cfg.yaml",
      "config",
    )!;
    expect(round.hyperparams.pretrainedBackboneWeights).toBe("/m/best.ckpt");
  });
});
