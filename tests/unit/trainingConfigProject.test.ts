/**
 * Stale PAF edges / ID class lists in reused sleap-nn configs, and the other
 * config fields a local run now always sets (validation labels, save_ckpt, val
 * batch size, kept augmentation probabilities).
 */
import { describe, it, expect } from "../bun-test";
import yaml from "js-yaml";
import { Skeleton, Video, Labels, Track } from "@talmolab/sleap-io.js";
import { projectHeadContext, reconcileHeadNameLists } from "@/lib/trainingConfigProject";
import { applyHyperparamsToYaml, defaultHyperparams, keptProbability } from "@/stores/trainingStore";

function makeLabels(trackNames: string[] = []): Labels {
  const skeleton = new Skeleton({ nodes: ["head", "thorax", "tail"], edges: [["head", "thorax"], ["thorax", "tail"]] });
  const video = new Video({ filename: "/data/v.mp4", backendMetadata: { shape: [10, 64, 64, 1] }, openBackend: false });
  return new Labels({ videos: [video], skeletons: [skeleton], tracks: trackNames.map((n) => new Track(n)) });
}

/** A config shaped like a finished run's training_config.yaml. */
function runConfig(edges: unknown, classes: unknown): string {
  return yaml.dump({
    data_config: {
      val_labels_path: ["/old/machine/labels.val_0.slp"],
      augmentation_config: {
        geometric: { affine_p: 0.3 },
        intensity: { contrast_p: 0.5, brightness_p: 0.25, uniform_noise_p: 0, gaussian_noise_p: 7 },
      },
    },
    model_config: {
      head_configs: {
        multi_class_bottomup: {
          confmaps: { part_names: ["head", "thorax", "tail"], sigma: 2.5, output_stride: 4 },
          class_maps: { classes, sigma: 5, output_stride: 16 },
        },
        bottomup: {
          confmaps: { part_names: null, sigma: 2.5, output_stride: 4 },
          pafs: { edges, sigma: 15, output_stride: 8 },
        },
      },
    },
    trainer_config: { train_data_loader: { batch_size: 4 }, val_data_loader: { batch_size: 4 } },
  });
}

// Loose nested access to a loaded YAML document, for assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const load = (text: string) => yaml.load(text) as Doc;

describe("projectHeadContext", () => {
  it("reads the skeleton's directed edges and every track name", () => {
    expect(projectHeadContext(makeLabels(["m1", "m2"]))).toEqual({
      edges: [["head", "thorax"], ["thorax", "tail"]],
      trackNames: ["m1", "m2"],
    });
  });

  it("is null without labels or with several skeletons", () => {
    expect(projectHeadContext(null)).toBeNull();
    const labels = makeLabels();
    labels.skeletons.push(new Skeleton({ nodes: ["x"] }));
    expect(projectHeadContext(labels)).toBeNull();
  });
});

describe("reconcileHeadNameLists", () => {
  const ctx = { edges: [["head", "thorax"], ["thorax", "tail"]] as [string, string][], trackNames: ["m1", "m2"] };

  it("keeps lists that still match, in their own order (a resumed model's outputs follow it)", () => {
    const heads = load(runConfig([["thorax", "tail"], ["head", "thorax"]], ["m2", "m1"])).model_config.head_configs;
    expect(reconcileHeadNameLists(heads, ctx)).toEqual([]);
    expect(heads.bottomup.pafs.edges).toEqual([["thorax", "tail"], ["head", "thorax"]]);
    expect(heads.multi_class_bottomup.class_maps.classes).toEqual(["m2", "m1"]);
  });

  it("clears edges after an edge is added, removed or reversed", () => {
    for (const stale of [
      [["head", "thorax"]],
      [["head", "thorax"], ["thorax", "tail"], ["head", "tail"]],
      [["thorax", "head"], ["thorax", "tail"]],
      "garbage",
    ]) {
      const heads = load(runConfig(stale, null)).model_config.head_configs;
      expect(reconcileHeadNameLists(heads, ctx)).toEqual(["bottomup.pafs.edges"]);
      expect(heads.bottomup.pafs.edges).toBeNull();
    }
  });

  it("clears classes after a track is added, renamed or removed", () => {
    for (const stale of [["m1"], ["m1", "m2", "m3"], ["m1", "mouse2"]]) {
      const heads = load(runConfig(null, stale)).model_config.head_configs;
      expect(reconcileHeadNameLists(heads, ctx)).toEqual(["multi_class_bottomup.class_maps.classes"]);
      expect(heads.multi_class_bottomup.class_maps.classes).toBeNull();
    }
  });

  it("leaves null lists (sleap-nn will derive them) and other fields alone", () => {
    const heads = load(runConfig(null, null)).model_config.head_configs;
    expect(reconcileHeadNameLists(heads, ctx)).toEqual([]);
    expect(heads.bottomup.pafs.edges).toBeNull();
    expect(heads.bottomup.pafs.sigma).toBe(15);
    expect(heads.multi_class_bottomup.class_maps.classes).toBeNull();
  });
});

describe("applyHyperparamsToYaml — fields a reused config must not carry over", () => {
  const ctx = projectHeadContext(makeLabels(["m1", "m2"]));

  it("clears stale edges/classes only when told the project", () => {
    const text = runConfig([["head", "thorax"]], ["old"]);
    const withProject = load(applyHyperparamsToYaml(text, { ...defaultHyperparams }, null, undefined, undefined, { project: ctx }));
    expect(withProject.model_config.head_configs.bottomup.pafs.edges).toBeNull();
    expect(withProject.model_config.head_configs.multi_class_bottomup.class_maps.classes).toBeNull();
    // Training a separately picked labels file: its skeleton isn't known here.
    const withoutProject = load(applyHyperparamsToYaml(text, { ...defaultHyperparams }));
    expect(withoutProject.model_config.head_configs.bottomup.pafs.edges).toEqual([["head", "thorax"]]);
  });

  it("val_labels_path follows the picker: the picked file, none, or untouched when not given", () => {
    const text = runConfig(null, null);
    const hp = { ...defaultHyperparams };
    expect(load(applyHyperparamsToYaml(text, hp, null, undefined, undefined, { valLabelsPath: "/data/val.slp" }))
      .data_config.val_labels_path).toEqual(["/data/val.slp"]);
    expect(load(applyHyperparamsToYaml(text, hp, null, undefined, undefined, { valLabelsPath: null }))
      .data_config.val_labels_path).toBeNull();
    expect(load(applyHyperparamsToYaml(text, hp)).data_config.val_labels_path).toEqual(["/old/machine/labels.val_0.slp"]);
  });

  it("always sets save_ckpt, and validation batches follow the training batch size", () => {
    const doc = load(applyHyperparamsToYaml(runConfig(null, null), { ...defaultHyperparams, batchSize: 16 }));
    expect(doc.trainer_config.save_ckpt).toBe(true);
    expect(doc.trainer_config.train_data_loader.batch_size).toBe(16);
    expect(doc.trainer_config.val_data_loader.batch_size).toBe(16);
  });

  it("an enabled augmentation keeps its config's probability; invalid or zero ones become 1", () => {
    const hp = {
      ...defaultHyperparams,
      rotationPreset: "15" as const,
      contrastEnabled: true,
      brightnessEnabled: false,
      uniformNoiseEnabled: true,
      gaussianNoiseEnabled: true,
    };
    const doc = load(applyHyperparamsToYaml(runConfig(null, null), hp));
    const { geometric, intensity } = doc.data_config.augmentation_config;
    expect(geometric.affine_p).toBe(0.3);
    expect(intensity.contrast_p).toBe(0.5);
    expect(intensity.brightness_p).toBe(0); // turned off
    expect(intensity.uniform_noise_p).toBe(1); // was 0, now on
    expect(intensity.gaussian_noise_p).toBe(1); // 7 isn't a probability
  });

  it("keptProbability", () => {
    expect(keptProbability(0.4)).toBe(0.4);
    expect(keptProbability(1)).toBe(1);
    expect(keptProbability(0)).toBe(1);
    expect(keptProbability(-0.2)).toBe(1);
    expect(keptProbability(undefined)).toBe(1);
    expect(keptProbability("0.5")).toBe(1);
  });
});
