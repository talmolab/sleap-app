/**
 * The pure rules behind "Use a trained model (don't retrain)" per training
 * stage (lib/reuseTrainedModel.ts): which models a stage may reuse, which
 * stages train, and the model order post-training inference gets.
 */

import { describe, it, expect } from "../bun-test";
import { isPartialTopDownRun } from "@/lib/launcherSpec";
import {
  anchorPartOf,
  applyReusePins,
  bboxSettingsOf,
  reusePinnedHyperparams,
  reusedModelsStartProblem,
  pipelineModelPaths,
  readModelFolder,
  reuseCandidatesForSlot,
  reuseModelProblem,
  reuseStartProblem,
  scanReusableModels,
  skeletonCompat,
  slotsToTrain,
  type ReadModelFolder,
  type ScannedModel,
} from "@/lib/reuseTrainedModel";
import { defaultHyperparams, type ConfigFile } from "@/stores/trainingStore";
import type { ModelDirEntry, ModelFsAccess } from "@/lib/modelDiscovery";

const NODES = ["head", "thorax", "abdomen"];

function cfg(slot: string, reuse?: ConfigFile["reuse"]): ConfigFile {
  return {
    filename: "x.yaml",
    content: "",
    modelType: slot,
    slot,
    hyperparams: { ...defaultHyperparams },
    originalHyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
    ...(reuse !== undefined ? { reuse } : {}),
  };
}

const model = (path: string, headKey = "centroid") => ({ path, runName: null, headKey, nodeNames: null });

function scanned(path: string, headKey: string, nodeNames: string[] | null, extra: Partial<ScannedModel> = {}): ScannedModel {
  return { path, headKey, nodeNames, runName: null, mtimeMs: 0, checkpointFile: "best.ckpt", cropMode: "fixed", ...extra };
}

const label = (slot: string) => (slot === "centroid" ? "Centroid" : "Centered Instance");

describe("skeletonCompat", () => {
  // Node order doesn't matter; the names do.
  it("matches the same node names in any order", () => {
    expect(skeletonCompat(["thorax", "head", "abdomen"], NODES)).toBe("match");
  });
  // A renamed, missing or extra node is a different skeleton.
  it("flags a different set of names", () => {
    expect(skeletonCompat(["head", "thorax"], NODES)).toBe("mismatch");
    expect(skeletonCompat(["head", "thorax", "tail"], NODES)).toBe("mismatch");
  });
  // A config that doesn't record its skeleton can't be checked.
  it("is unknown when either side has no nodes", () => {
    expect(skeletonCompat(null, NODES)).toBe("unknown");
    expect(skeletonCompat(NODES, [])).toBe("unknown");
  });
});

describe("reuseCandidatesForSlot", () => {
  const all = [
    scanned("/m/centroid-ok", "centroid", NODES),
    scanned("/m/centroid-other-skel", "centroid", ["a", "b"]),
    scanned("/m/ci", "centered_instance", NODES),
    scanned("/m/ci-box", "centered_instance", NODES, { cropMode: "bbox" }),
    scanned("/m/bu", "bottomup", NODES),
  ];

  // Only the stage's own head type is offered; a skeleton mismatch stays listed (shown disabled).
  it("lists same-head models with their skeleton compatibility", () => {
    const c = reuseCandidatesForSlot(all, "top_down", "centroid", NODES);
    expect(c.map((x) => [x.model.path, x.compat])).toEqual([
      ["/m/centroid-ok", "match"],
      ["/m/centroid-other-skel", "mismatch"],
    ]);
  });

  // Box-crop and fixed-crop centered-instance models aren't interchangeable.
  it("tells box-crop from fixed-crop centered-instance models", () => {
    expect(reuseCandidatesForSlot(all, "top_down", "centered_instance", NODES).map((x) => x.model.path)).toEqual(["/m/ci"]);
    expect(reuseCandidatesForSlot(all, "top_down_bbox", "centered_instance", NODES).map((x) => x.model.path)).toEqual(["/m/ci-box"]);
  });

  // Single-model pipelines use the "config" slot, mapped through the pipeline type.
  it("maps the single 'config' slot to the pipeline's head", () => {
    expect(reuseCandidatesForSlot(all, "bottom_up", "config", NODES).map((x) => x.model.path)).toEqual(["/m/bu"]);
  });
});

describe("reuseModelProblem", () => {
  // Browsing to a folder must still respect the stage's head and skeleton.
  it("rejects a wrong head or a different skeleton, allows an unknown skeleton", () => {
    expect(reuseModelProblem({ headKey: "bottomup", nodeNames: NODES }, "top_down", "centroid", NODES)).toContain("bottomup");
    expect(reuseModelProblem({ headKey: "centroid", nodeNames: ["x"] }, "top_down", "centroid", NODES)).toContain("different skeleton");
    expect(reuseModelProblem({ headKey: "centroid", nodeNames: null }, "top_down", "centroid", NODES)).toBeNull();
    expect(reuseModelProblem({ headKey: "centroid", nodeNames: NODES }, "top_down", "centroid", NODES)).toBeNull();
  });
});

describe("slotsToTrain / reuseStartProblem", () => {
  const slots = ["centroid", "centered_instance"];

  // Reused stages drop out of training, the rest keep pipeline order.
  it("drops reused stages from training", () => {
    expect(slotsToTrain(slots, [cfg("centroid", { model: model("/m/c") }), cfg("centered_instance")])).toEqual(["centered_instance"]);
    expect(slotsToTrain(slots, [cfg("centroid"), cfg("centered_instance")])).toEqual(slots);
  });

  // A checked box without a model can't start.
  it("needs a model picked for every checked stage", () => {
    const configs = [cfg("centroid", { model: null }), cfg("centered_instance")];
    expect(reuseStartProblem(slots, configs, label)).toContain("Pick a trained model for Centroid");
  });

  // Locally every stage may be reused (just inference, like PyQt); on a worker there must be something to train.
  it("allows all stages reused locally but not on a worker", () => {
    const configs = [cfg("centroid", { model: model("/m/c") }), cfg("centered_instance", { model: model("/m/ci", "centered_instance") })];
    expect(reuseStartProblem(slots, configs, label, { inferenceTarget: "suggestions" })).toBeNull();
    expect(reuseStartProblem(slots, configs, label, { remote: true, inferenceTarget: "suggestions" })).toContain("nothing to train on the worker");
  });
});

describe("pipelineModelPaths", () => {
  const slots = ["centroid", "centered_instance"];

  // Inference must get the models in pipeline order, reused or new.
  it("slots the reused model in at its stage's position", () => {
    const configs = [cfg("centroid", { model: model("/m/old-centroid") }), cfg("centered_instance")];
    expect(pipelineModelPaths(slots, configs, ["/m/new-ci"])).toEqual(["/m/old-centroid", "/m/new-ci"]);
    const second = [cfg("centroid"), cfg("centered_instance", { model: model("/m/old-ci", "centered_instance") })];
    expect(pipelineModelPaths(slots, second, ["/m/new-c"])).toEqual(["/m/new-c", "/m/old-ci"]);
  });

  // A Connect run passes the reused model's worker-side path.
  it("maps reused paths through the given translator", () => {
    const configs = [cfg("centroid", { model: model("/local/c") }), cfg("centered_instance")];
    expect(pipelineModelPaths(slots, configs, ["/w/ci"], (m) => `/w${m.path}`)).toEqual(["/w/local/c", "/w/ci"]);
  });

  // Without reuse nothing changes: just the trained models.
  it("is the trained list when nothing is reused", () => {
    expect(pipelineModelPaths(slots, [cfg("centroid"), cfg("centered_instance")], ["/a", "/b"])).toEqual(["/a", "/b"]);
  });
});

describe("reading model folders", () => {
  const CENTROID_YAML = `
data_config:
  skeletons:
    - nodes: [{name: head}, {name: thorax}, {name: abdomen}]
model_config:
  head_configs:
    centroid:
      confmaps: {anchor_part: thorax, sigma: 2.5}
trainer_config:
  run_name: "250101_120000.centroid.n=40"
`;

  // The top-down anchor part is carried over to the stage that still trains.
  it("reads a top-down model's anchor part", () => {
    expect(anchorPartOf(CENTROID_YAML)).toBe("thorax");
    expect(anchorPartOf("model_config:\n  head_configs:\n    centroid:\n      confmaps: {anchor_part: null}\n")).toBeNull();
    expect(anchorPartOf("model_config:\n  head_configs:\n    bottomup:\n      confmaps: {}\n")).toBeUndefined();
  });

  function fakeFs(dirs: Record<string, ModelDirEntry[]>, files: Record<string, string>): ModelFsAccess {
    return {
      readDir: async (p) => {
        if (!dirs[p]) throw new Error("ENOENT");
        return dirs[p];
      },
      readTextFile: async (p) => {
        if (files[p] === undefined) throw new Error("ENOENT");
        return files[p];
      },
      exists: async (p) => p in dirs || p in files,
      mtimeMs: async () => 0,
    };
  }

  // The picker lists the project's trained runs with their skeleton and anchor.
  it("scans a project's models folder with node names and anchor", async () => {
    const run = "/proj/models/250101_120000.centroid.n=40";
    const fs = fakeFs(
      {
        "/proj/models": [{ name: "250101_120000.centroid.n=40", isDirectory: true }],
        [run]: [{ name: "training_config.yaml", isDirectory: false }, { name: "best.ckpt", isDirectory: false }],
      },
      { [`${run}/training_config.yaml`]: CENTROID_YAML },
    );
    const found = await scanReusableModels(["/proj", "/proj"], fs);
    expect(found).toHaveLength(1);
    expect(found[0].nodeNames).toEqual(NODES);
    expect(found[0].anchorPart).toBe("thorax");
  });

  // Browsing to a folder needs its config and a checkpoint.
  it("reads a browsed folder, or returns null without a config", async () => {
    const fs = fakeFs(
      { "/x/run": [{ name: "training_config.yaml", isDirectory: false }] },
      { "/x/run/training_config.yaml": CENTROID_YAML },
    );
    const info = await readModelFolder("/x/run", fs);
    expect(info?.headKey).toBe("centroid");
    expect(info?.hasCheckpoint).toBe(false);
    expect(await readModelFolder("/x/empty", fs)).toBeNull();
  });
});

describe("reuse review fixes", () => {
  const slots = ["centroid", "centered_instance"];

  // A reused centroid model fixes the anchor part for the stage that trains.
  it("pins a reused top-down model's anchor part on every stage", () => {
    const configs = [
      cfg("centroid", { model: { ...model("/m/c"), anchorPart: "thorax" } }),
      { ...cfg("centered_instance"), hyperparams: { ...defaultHyperparams, anchorPart: "head" } },
    ];
    expect(reusePinnedHyperparams("top_down", configs)).toEqual({ stage: "centroid", values: { anchorPart: "thorax" } });
    const pinned = applyReusePins("top_down", configs);
    expect(pinned.map((c) => c.hyperparams.anchorPart)).toEqual(["thorax", "thorax"]);
    // Nothing to change: the same array comes back.
    expect(applyReusePins("top_down", pinned)).toBe(pinned);
  });

  // A reused box detector fixes box source/padding for the box-crop stage it feeds.
  it("pins a reused box detector's box settings in a box-crop pipeline", () => {
    const configs = [
      cfg("bbox", { model: { ...model("/m/det", "bbox_centernet"), bboxSource: "instances", bboxPadding: 8 } }),
      cfg("centered_instance"),
    ];
    const pinned = applyReusePins("top_down_bbox", configs);
    expect(pinned[1].hyperparams.bboxSource).toBe("instances");
    expect(pinned[1].hyperparams.bboxPadding).toBe(8);
    expect(bboxSettingsOf("data_config:\n  bbox_source: instances\n  bbox_padding: 8\n")).toEqual({ bboxSource: "instances", bboxPadding: 8 });
  });

  // Nothing reused (or a model with nothing to pin): settings untouched.
  it("pins nothing without a reused model", () => {
    const configs = [cfg("centroid"), cfg("centered_instance")];
    expect(applyReusePins("top_down", configs)).toBe(configs);
  });

  // Locally, all stages reused is fine only when inference will run.
  it("refuses all-reused locally when post-training inference is off", () => {
    const configs = [cfg("centroid", { model: model("/m/c") }), cfg("centered_instance", { model: model("/m/ci", "centered_instance") })];
    expect(reuseStartProblem(slots, configs, label, { inferenceTarget: "nothing" })).toContain("nothing to run");
    expect(reuseStartProblem(slots, configs, label, {})).toContain("nothing to run");
    expect(reuseStartProblem(slots, configs, label, { inferenceTarget: "suggestions" })).toBeNull();
  });

  // Start re-checks each pick: gone, no checkpoint, wrong skeleton.
  it("re-checks reused models at Start", async () => {
    const configs = [cfg("centroid", { model: { ...model("/m/c"), nodeNames: NODES } }), cfg("centered_instance")];
    const read = (info: Awaited<ReturnType<ReadModelFolder>>): ReadModelFolder => async () => info;
    expect(await reusedModelsStartProblem(slots, configs, "top_down", label, { readFolder: read(null) })).toContain("no longer there");
    expect(await reusedModelsStartProblem(slots, configs, "top_down", label, {
      readFolder: read({ headKey: "centroid", nodeNames: NODES, hasCheckpoint: false }),
    })).toContain("no checkpoint");
    expect(await reusedModelsStartProblem(slots, configs, "top_down", label, { projectNodes: ["a", "b"] })).toContain("different skeleton");
    expect(await reusedModelsStartProblem(slots, configs, "top_down", label, {
      projectNodes: NODES,
      readFolder: read({ headKey: "centroid", nodeNames: NODES, hasCheckpoint: true }),
    })).toBeNull();
  });

  // "Run again" on a Connect run that trained one top-down stage (the other reused) explains itself.
  it("recognizes a one-stage top-down run", () => {
    expect(isPartialTopDownRun(["centered_instance"])).toBe(true);
    expect(isPartialTopDownRun(["centroid"])).toBe(true);
    expect(isPartialTopDownRun(["centroid", "centered_instance"])).toBe(false);
    expect(isPartialTopDownRun(["bottomup"])).toBe(false);
  });
});
