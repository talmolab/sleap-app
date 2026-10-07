/**
 * Round-engine retrain configs against REAL trained sleap-nn model folders.
 *
 * `prepareRetrainConfigs` rebuilds the next round's training configs from the
 * previous round's run directories and points fine-tuning at each run's best
 * checkpoint. This drives it with the real on-disk files of a trained top-down
 * pair (no training run): real `training_config.yaml`s, the real checkpoint
 * lookup, the real parser, and the real YAML writer the training launch uses.
 *
 * The models live in a local demo project, so the suite skips where they
 * don't exist (CI). Set `SLEAP_AL_EMIT_DIR` to also write the emitted YAMLs
 * out, e.g. to validate them with sleap-nn's own config loader.
 */

import { describe, it, expect } from "../bun-test";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { prepareRetrainConfigs } from "@/lib/activeLearning/roundEngine";
import { findFineTuneCheckpoint, type ModelFsAccess } from "@/lib/modelDiscovery";
import { applyHyperparamsToYaml, useTrainingStore, type ConfigFile } from "@/stores/trainingStore";
import type { RoundRecord } from "@/stores/activeLearningStore";
import { buildTrainingArgs } from "@/platform/trainingArgs";
import { resolveInputChannels } from "@/lib/modelStats";

const MODELS = path.join(process.env.HOME ?? "", "work/phase3-demo/models");
const CENTROID = path.join(MODELS, "centroid_20260727200401.");
const CENTERED = path.join(MODELS, "centered_instance_20260727200439.");
const present = [CENTROID, CENTERED].every((d) => fs.existsSync(path.join(d, "training_config.yaml")));

const nodeFs: ModelFsAccess = {
  readDir: async (p) => fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
  readTextFile: async (p) => fs.readFileSync(p, "utf8"),
  exists: async (p) => fs.existsSync(p),
  mtimeMs: async (p) => fs.statSync(p).mtimeMs,
};

const round1: RoundRecord = {
  round: 1,
  modelType: "top_down",
  models: [
    { slot: "centroid", dir: CENTROID },
    { slot: "centered_instance", dir: CENTERED },
  ],
  trainedAt: "2026-07-27T20:04:39.000Z",
  fineTuned: false,
};

describe.skipIf(!present)("prepareRetrainConfigs on real trained model folders", () => {
  it("rebuilds both top-down configs, fine-tuning from each run's best.ckpt", async () => {
    const out = await prepareRetrainConfigs(round1, true, {
      readText: async (p) => fs.readFileSync(p, "utf8"),
      findCheckpoint: (dir) => findFineTuneCheckpoint(dir, nodeFs),
      parseYamlConfig: (text, filename, slot, ckpt) =>
        useTrainingStore.getState().parseYamlConfig(text, filename, slot, ckpt),
    });
    expect(typeof out, typeof out === "string" ? out : "").not.toBe("string");
    const cfgs = out as ConfigFile[];
    expect(cfgs.map((c) => c.slot)).toEqual(["centroid", "centered_instance"]);

    for (const cf of cfgs) {
      const runDir = cf.slot === "centroid" ? CENTROID : CENTERED;
      expect(cf.checkpointPath).toBe(path.join(runDir, "best.ckpt"));
      expect(cf.hyperparams.trainingMode).toBe("finetune");
      expect(cf.hyperparams.runName).toBe("");
      // These models were trained on 3-channel input; the fine-tune must match.
      expect(cf.hyperparams.colorMode).toBe("rgb");

      // What the training launch writes for this config — with the project's
      // video channel count UNKNOWN (null), the case that used to fall back to
      // 1 channel and break loading the 3-channel weights.
      const emitted = applyHyperparamsToYaml(
        cf.content,
        cf.hyperparams,
        cf.checkpointPath,
        undefined,
        resolveInputChannels(cf.hyperparams.colorMode, null),
      );
      const doc = yaml.load(emitted) as {
        model_config: Record<string, unknown>;
        trainer_config: Record<string, unknown>;
      };
      expect(doc.model_config.pretrained_backbone_weights).toBe(cf.checkpointPath);
      const backbone = (doc.model_config.backbone_config as Record<string, { in_channels?: number } | null>).unet;
      expect(backbone?.in_channels).toBe(3);
      expect(doc.model_config.pretrained_head_weights).toBe(cf.checkpointPath);
      // A fine-tune is a NEW run, not a resume of the old one.
      expect(doc.trainer_config.resume_ckpt_path ?? null).toBeNull();
      // The YAML may still carry the old run's name, but the launch always
      // overrides it on the command line with the fresh one it computes for a
      // blank `runName` — so the round gets its own run folder.
      const args = buildTrainingArgs({
        configFileName: "c.yaml",
        configDir: "/tmp",
        labelsPath: "/proj/labels.slp",
        runName: "261007_120000.centered_instance.n=40",
        ckptDir: MODELS,
      });
      expect(args).toContain("trainer_config.run_name='261007_120000.centered_instance.n=40'");

      const emitDir = process.env.SLEAP_AL_EMIT_DIR;
      if (emitDir) fs.writeFileSync(path.join(emitDir, `${cf.slot}.round2.yaml`), emitted);
    }
  });

  it("trains from scratch (no pretrained weights) when fine-tuning is off", async () => {
    const cfgs = (await prepareRetrainConfigs(round1, false, {
      readText: async (p) => fs.readFileSync(p, "utf8"),
      findCheckpoint: (dir) => findFineTuneCheckpoint(dir, nodeFs),
      parseYamlConfig: (text, filename, slot, ckpt) =>
        useTrainingStore.getState().parseYamlConfig(text, filename, slot, ckpt),
    })) as ConfigFile[];
    for (const cf of cfgs) {
      const doc = yaml.load(applyHyperparamsToYaml(cf.content, cf.hyperparams, cf.checkpointPath)) as {
        model_config: Record<string, unknown>;
      };
      expect(doc.model_config.pretrained_backbone_weights ?? null).toBeNull();
      expect(doc.model_config.pretrained_head_weights ?? null).toBeNull();
    }
  });
});
