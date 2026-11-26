/**
 * Box-detector model types (#488, part 4): the training configs the app writes
 * for sleap-nn's `bbox_centernet` / `bbox_ssd` detectors and its
 * `topdown_bbox_*` pipeline, the slots/presets behind them, trained-model
 * discovery, and the inference rules (both models required for top-down-box,
 * no tracking for a detector alone, predicted boxes merged and cleared).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import yaml from "js-yaml";
import {
  Labels,
  LabeledFrame,
  PredictedBoundingBox,
  UserBoundingBox,
  Video,
} from "@talmolab/sleap-io.js";
import {
  useTrainingStore,
  getConfigSlots,
  getSlotLabel,
  applyHyperparamsToYaml,
  buildPostTrainingInferenceConfig,
  planPostTrainingExports,
  isBboxModelType,
  BBOX_REMOTE_UNSUPPORTED,
  type ConfigFile,
} from "@/stores/trainingStore";
import {
  BASELINE_PROFILES,
  getBaselineProfilesForHead,
  getRecommendedProfileForHead,
  slotToHeadType,
} from "@/lib/trainingProfiles";
import { headTypeMatches, isBboxHeadKey, cropModeOf } from "@/lib/bboxModels";
import {
  findTrainedModels,
  pickModelsForPipeline,
  pipelineModelsProblem,
  type DiscoveredModel,
  type ModelFsAccess,
} from "@/lib/modelDiscovery";
import { resolveSlotConfigSource } from "@/lib/trainedConfigAutoload";
import { buildInferenceArgs } from "@/platform/inferenceArgs";
import { CommandContext } from "@/commands/CommandContext";
import { MergePredictions } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function profile(filename: string) {
  const p = BASELINE_PROFILES.find((x) => x.filename === filename);
  if (!p) throw new Error(`no profile ${filename}`);
  return p;
}

/** Parse a preset the way the Training panel does, for `slot`. */
function loadPreset(filename: string, slot: string): ConfigFile {
  const p = profile(filename);
  const cf = useTrainingStore.getState().parseYamlConfig(p.content, p.filename, slot);
  if (!cf) throw new Error("parse failed");
  return cf;
}

/** The YAML a run of `cf` would write (no project: default stride/channels). */
function written(cf: ConfigFile): Doc {
  return yaml.load(applyHyperparamsToYaml(cf.content, cf.hyperparams)) as Doc;
}

function activeHeads(doc: Doc): string[] {
  return Object.entries(doc.model_config.head_configs as Doc)
    .filter(([, v]) => v != null)
    .map(([k]) => k);
}

describe("box model types: slots and presets", () => {
  it("adds a detector-only type and a top-down-with-box-crops type", () => {
    expect(getConfigSlots("bbox")).toEqual(["bbox"]);
    // Detector first: post-training inference passes model dirs in slot order.
    expect(getConfigSlots("top_down_bbox")).toEqual(["bbox", "centered_instance"]);
    expect(getSlotLabel("bbox")).toBe("Box Detector Config");
    expect(isBboxModelType("bbox")).toBe(true);
    expect(isBboxModelType("top_down_bbox")).toBe(true);
    expect(isBboxModelType("top_down")).toBe(false);
  });

  it("maps the box slots to head families with their own presets", () => {
    expect(slotToHeadType("bbox", "bbox")).toBe("bbox");
    expect(slotToHeadType("top_down_bbox", "bbox")).toBe("bbox");
    expect(slotToHeadType("top_down_bbox", "centered_instance")).toBe("centered_instance_bbox");
    // Classic top-down keeps its fixed-crop presets.
    expect(slotToHeadType("top_down", "centered_instance")).toBe("centered_instance");

    const detectors = getBaselineProfilesForHead("bbox");
    expect(detectors.map((p) => p.filename)).toEqual([
      "baseline.bbox_centernet.yaml",
      "baseline.bbox_ssd.yaml",
      "baseline.bbox_detr.yaml",
    ]);
    // The detector style is picked by preset; CenterNet is the default whatever the RF tier.
    expect(getRecommendedProfileForHead("bbox", { tier: "large" } as never)?.filename).toBe("baseline.bbox_centernet.yaml");

    const crops = getBaselineProfilesForHead("centered_instance_bbox");
    expect(crops).toHaveLength(2);
    for (const p of crops) expect(cropModeOf(yaml.load(p.content))).toBe("bbox");
    for (const p of getBaselineProfilesForHead("centered_instance")) {
      expect(cropModeOf(yaml.load(p.content))).toBe("fixed");
    }
  });
});

describe("box model types: parsed hyperparameters", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("reads a detector preset's head, stride and box source", () => {
    const cn = loadPreset("baseline.bbox_centernet.yaml", "bbox");
    expect(cn.modelType).toBe("bbox_centernet");
    expect(cn.hyperparams.outputStride).toBe(4);
    expect(cn.hyperparams.bboxSource).toBe("auto");
    expect(cn.hyperparams.bboxPadding).toBe(0);
    // Rotated boxes inflate the enclosing box: detectors train without rotation.
    expect(cn.hyperparams.rotationPreset).toBe("off");
    // Eval on, so sleap-nn keeps the checkpoint with the best box mAP.
    expect(cn.hyperparams.evalEnabled).toBe(true);

    const ssd = loadPreset("baseline.bbox_ssd.yaml", "bbox");
    expect(ssd.modelType).toBe("bbox_ssd");
    expect(ssd.hyperparams.outputStride).toBe(8);
  });

  it("reads a box-crop centered-instance preset's crop settings", () => {
    const ci = loadPreset("baseline_medium_rf.topdown_bbox.yaml", "centered_instance");
    expect(ci.modelType).toBe("centered_instance");
    expect(ci.hyperparams.cropMode).toBe("bbox");
    expect(ci.hyperparams.cropBboxAspect).toBe("square");
    expect(ci.hyperparams.cropBboxPadding).toBe(0.1);
    expect(ci.hyperparams.cropBboxMinSize).toBeNull();
  });
});

describe("box model types: the config the app writes", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("writes a CenterNet detector with one head and its stride on every sub-head", () => {
    const cf = loadPreset("baseline.bbox_centernet.yaml", "bbox");
    const doc = written({ ...cf, hyperparams: { ...cf.hyperparams, outputStride: 8, bboxSource: "instances", bboxPadding: 5 } });
    expect(activeHeads(doc)).toEqual(["bbox_centernet"]);
    const head = doc.model_config.head_configs.bbox_centernet;
    // sleap-nn requires center/size/offset to share one stride ...
    expect([head.center.output_stride, head.size.output_stride, head.offset.output_stride]).toEqual([8, 8, 8]);
    // ... and rejects keys the head doesn't define.
    expect(Object.keys(head).sort()).toEqual(["center", "offset", "size"]);
    // Adaptive (per-box) heatmap radius stays: the app's sigma isn't applied.
    expect(head.center.sigma).toBeNull();
    expect(doc.data_config.bbox_source).toBe("instances");
    expect(doc.data_config.bbox_padding).toBe(5);
    // A detector sees the whole frame: no crop keys.
    expect("crop_mode" in doc.data_config.preprocessing).toBe(false);
  });

  it("writes an SSD detector's stride on its pyramid head", () => {
    const cf = loadPreset("baseline.bbox_ssd.yaml", "bbox");
    const doc = written(cf);
    expect(activeHeads(doc)).toEqual(["bbox_ssd"]);
    expect(doc.model_config.head_configs.bbox_ssd.ssd.output_stride).toBe(8);
    expect(Object.keys(doc.model_config.head_configs.bbox_ssd)).toEqual(["ssd"]);
  });

  it("writes a box-crop centered-instance model's crop and box settings", () => {
    const cf = loadPreset("baseline_medium_rf.topdown_bbox.yaml", "centered_instance");
    const doc = written({
      ...cf,
      hyperparams: { ...cf.hyperparams, cropBboxAspect: "letterbox", cropBboxPadding: 0.2, cropBboxMinSize: 24, bboxPadding: 3 },
    });
    expect(activeHeads(doc)).toEqual(["centered_instance"]);
    const pre = doc.data_config.preprocessing;
    expect(pre.crop_mode).toBe("bbox");
    expect(pre.crop_bbox_aspect).toBe("letterbox");
    expect(pre.crop_bbox_padding).toBe(0.2);
    expect(pre.crop_bbox_min_size).toBe(24);
    expect(doc.data_config.bbox_source).toBe("auto");
    expect(doc.data_config.bbox_padding).toBe(3);
  });

  it("keeps a pose config free of box keys (loadable by sleap-nn < 0.3.5)", () => {
    for (const [filename, slot] of [
      ["baseline_medium_rf.topdown.yaml", "centered_instance"],
      ["baseline_medium_rf.centroid.yaml", "centroid"],
      ["baseline_medium_rf.bottomup.yaml", "config"],
    ] as const) {
      const doc = written(loadPreset(filename, slot));
      expect("bbox_source" in doc.data_config).toBe(false);
      expect("bbox_padding" in doc.data_config).toBe(false);
      expect("crop_mode" in doc.data_config.preprocessing).toBe(false);
    }
  });

  it("switches a box-crop instance model back to fixed crops", () => {
    const cf = loadPreset("baseline_medium_rf.topdown_bbox.yaml", "centered_instance");
    const doc = written({ ...cf, hyperparams: { ...cf.hyperparams, cropMode: "fixed" } });
    expect(doc.data_config.preprocessing.crop_mode).toBe("fixed");
  });
});

describe("box model types: store", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("sets a top-down-box pair's box source and padding on both configs", () => {
    const store = useTrainingStore.getState();
    store.setConfig("modelType", "top_down_bbox");
    store.addConfigFile(loadPreset("baseline.bbox_centernet.yaml", "bbox"));
    store.addConfigFile(loadPreset("baseline_medium_rf.topdown_bbox.yaml", "centered_instance"));

    useTrainingStore.getState().updateConfigHyperparams("bbox", { bboxPadding: 6, bboxSource: "instances", maxEpochs: 3 });
    const [det, ci] = ["bbox", "centered_instance"].map(
      (s) => useTrainingStore.getState().config.configs.find((c) => c.slot === s)!.hyperparams,
    );
    expect(det.bboxPadding).toBe(6);
    expect(ci.bboxPadding).toBe(6);
    expect(ci.bboxSource).toBe("instances");
    // Only the shared box settings travel.
    expect(det.maxEpochs).toBe(3);
    expect(ci.maxEpochs).not.toBe(3);
  });

  it("doesn't sync box settings outside the top-down-box pipeline", () => {
    const store = useTrainingStore.getState();
    store.setConfig("modelType", "top_down");
    store.addConfigFile(loadPreset("baseline_medium_rf.centroid.yaml", "centroid"));
    store.addConfigFile(loadPreset("baseline_medium_rf.topdown.yaml", "centered_instance"));
    useTrainingStore.getState().updateConfigHyperparams("centroid", { bboxPadding: 6 });
    const ci = useTrainingStore.getState().config.configs.find((c) => c.slot === "centered_instance")!;
    expect(ci.hyperparams.bboxPadding).toBe(0);
  });

  it("refuses remote training for box models", async () => {
    const store = useTrainingStore.getState();
    store.setConfig("modelType", "bbox");
    store.addConfigFile(loadPreset("baseline.bbox_centernet.yaml", "bbox"));
    await useTrainingStore.getState().startTraining({ remote: true, workerId: "w", labelsSource: "worker-file", workerLabelsPath: "/x.slp" });
    expect(useTrainingStore.getState().status).toBe("error");
    expect(useTrainingStore.getState().error).toBe(BBOX_REMOTE_UNSUPPORTED);
  });

  it("maps the box model types to their inference pipelines", () => {
    const pipeline = (modelType: "bbox" | "top_down_bbox") =>
      buildPostTrainingInferenceConfig({ modelType, modelPaths: ["/m"], inferenceTarget: "suggestions", videoIndex: "all" }).pipeline;
    expect(pipeline("bbox")).toBe("bbox");
    expect(pipeline("top_down_bbox")).toBe("top-down-bbox");
  });
});

// ── Discovery ───────────────────────────────────────────────────────────────

const cfg = (head: string, extra = "") => `
data_config:
  preprocessing:
    scale: 1.0
${extra}
model_config:
  head_configs:
    ${head}: {}
trainer_config:
  run_name: "run.${head}"
`;

function memFs(runs: Record<string, { yaml: string; mtime: number }>): ModelFsAccess {
  const root = "/proj/models";
  return {
    async exists(path) {
      return path === root || Object.keys(runs).some((r) => path === `${root}/${r}/training_config.yaml`);
    },
    async readDir(path) {
      if (path === root) return Object.keys(runs).map((name) => ({ name, isDirectory: true }));
      return [{ name: "best.ckpt", isDirectory: false }, { name: "training_config.yaml", isDirectory: false }];
    },
    async readTextFile(path) {
      const name = path.split("/").at(-2)!;
      return runs[name].yaml;
    },
    async mtimeMs(path) {
      return runs[path.split("/").at(-1)!]?.mtime ?? 0;
    },
  };
}

describe("box model types: trained-model discovery", () => {
  const fs = memFs({
    detector: { yaml: cfg("bbox_ssd"), mtime: 50 },
    ci_box: { yaml: cfg("centered_instance", "    crop_mode: bbox"), mtime: 40 },
    ci_fixed: { yaml: cfg("centered_instance"), mtime: 30 },
    centroid: { yaml: cfg("centroid"), mtime: 20 },
  });

  it("records each centered-instance run's crop mode", async () => {
    const found = await findTrainedModels("/proj", fs);
    const byName = Object.fromEntries(found.map((m) => [m.path.split("/").at(-1), m]));
    expect(byName.detector.headKey).toBe("bbox_ssd");
    expect(byName.ci_box.cropMode).toBe("bbox");
    expect(byName.ci_fixed.cropMode).toBe("fixed");
  });

  it("picks a detector and a box-crop instance model for top-down-box, and keeps them out of top-down", async () => {
    const found = await findTrainedModels("/proj", fs);
    expect(pickModelsForPipeline(found, "bbox")).toEqual(["/proj/models/detector"]);
    expect(pickModelsForPipeline(found, "top-down-bbox")).toEqual(["/proj/models/detector", "/proj/models/ci_box"]);
    // The newer box-crop run can't follow a centroid model.
    expect(pickModelsForPipeline(found, "top-down")).toEqual(["/proj/models/centroid", "/proj/models/ci_fixed"]);
  });

  it("returns nothing for top-down-box without a box-crop instance model", () => {
    const models: DiscoveredModel[] = [
      { path: "/d", headKey: "bbox_centernet", runName: null, mtimeMs: 2, checkpointFile: "best.ckpt" },
      { path: "/c", headKey: "centered_instance", cropMode: "fixed", runName: null, mtimeMs: 1, checkpointFile: "best.ckpt" },
    ];
    expect(pickModelsForPipeline(models, "top-down-bbox")).toEqual([]);
  });

  it("matches head families", () => {
    expect(isBboxHeadKey("bbox_centernet")).toBe(true);
    expect(isBboxHeadKey("centroid")).toBe(false);
    expect(headTypeMatches("bbox", { headKey: "bbox_centernet" })).toBe(true);
    expect(headTypeMatches("bbox", { headKey: "centroid" })).toBe(false);
    // Unknown crop mode (e.g. a checkpoint's sibling config read elsewhere) fits either kind.
    expect(headTypeMatches("centered_instance_bbox", { headKey: "centered_instance" })).toBe(true);
    expect(headTypeMatches("centered_instance", { headKey: "centered_instance", cropMode: "bbox" })).toBe(false);
  });

  it("auto-loads a trained box-crop run into the top-down-box slot, else the box-crop preset", async () => {
    const found = await findTrainedModels("/proj", fs);
    const files = { readTextFile: fs.readTextFile, join: async (a: string, b: string) => `${a}/${b}` };
    const trained = await resolveSlotConfigSource("centered_instance", "top_down_bbox", found, files);
    expect(trained?.source).toBe("trained");
    expect(cropModeOf(yaml.load(trained!.yamlText))).toBe("bbox");

    const onlyFixed = found.filter((m) => m.cropMode !== "bbox");
    const baseline = await resolveSlotConfigSource("centered_instance", "top_down_bbox", onlyFixed, files);
    expect(baseline?.source).toBe("baseline");
    expect(baseline?.filename).toBe("baseline_medium_rf.topdown_bbox.yaml");
  });
});

// ── Inference ───────────────────────────────────────────────────────────────

describe("box model types: inference", () => {
  const base = buildPostTrainingInferenceConfig({
    modelType: "bbox",
    modelPaths: ["/models/det"],
    inferenceTarget: "video",
    videoIndex: 0,
  });

  it("needs both models for a top-down-box run, the instance one trained on box crops", () => {
    const det = { headKey: "bbox_centernet", cropMode: "fixed" as const };
    const boxCi = { headKey: "centered_instance", cropMode: "bbox" as const };
    const fixedCi = { headKey: "centered_instance", cropMode: "fixed" as const };
    expect(pipelineModelsProblem("top-down-bbox", [det, boxCi])).toBeNull();
    expect(pipelineModelsProblem("top-down-bbox", [det])).toMatch(/Top-Down \(Box Crops\) needs these models: Box Detector \+ Centered Instance \(box crops\)\. Add the missing one\./);
    expect(pipelineModelsProblem("top-down-bbox", [det, fixedCi])).toMatch(/Missing: Centered Instance \(box crops\)/);
    expect(pipelineModelsProblem("bbox", [{ headKey: "bbox_ssd" }])).toBeNull();
    expect(pipelineModelsProblem("bbox", ["centroid"])).toMatch(/Missing: Box Detector/);
    // A box-crop instance model doesn't fill a regular Top-Down slot.
    expect(pipelineModelsProblem("top-down", [{ headKey: "centroid" }, boxCi])).toMatch(/Missing/);
    // Plain head keys (unknown crop mode) still work as before.
    expect(pipelineModelsProblem("top-down", ["centroid", "centered_instance"])).toBeNull();
  });

  it("never asks sleap-nn to track a detector's boxes", () => {
    const args = buildInferenceArgs({ ...base, tracking: true }, { dataPath: "/p.slp", outputPath: "/o.slp" });
    expect(args).not.toContain("--tracking");
    expect(args.filter((a) => a === "--model_paths")).toHaveLength(1);
  });

  it("tracks a top-down-box run's poses, and a track-only run whatever the pipeline", () => {
    const td = buildInferenceArgs(
      { ...base, pipeline: "top-down-bbox", modelPaths: ["/d", "/c"], tracking: true },
      { dataPath: "/p.slp", outputPath: "/o.slp" },
    );
    expect(td).toContain("--tracking");
    const trackOnly = buildInferenceArgs(
      { ...base, trackOnly: true, modelPaths: [], tracking: true },
      { dataPath: "/p.slp", outputPath: "/o.slp" },
    );
    expect(trackOnly).toContain("--tracking");
  });
});

describe("box model types: merging predicted boxes", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  const video = (filename: string) =>
    new Video({ filename, backendMetadata: { shape: [100, 64, 64, 1] }, openBackend: false });

  it("clears old predicted boxes on clear_all, keeps drawn ones, and reports box counts", async () => {
    const baseVideo = video("/base/v.mp4");
    const user = new UserBoundingBox({ x1: 0, y1: 0, x2: 5, y2: 5 });
    const stale = new PredictedBoundingBox({ x1: 1, y1: 1, x2: 9, y2: 9, score: 0.5 });
    const elsewhere = new PredictedBoundingBox({ x1: 2, y1: 2, x2: 8, y2: 8, score: 0.4 });
    const labels = new Labels({
      labeledFrames: [
        new LabeledFrame({ video: baseVideo, frameIdx: 0, bboxes: [user, stale] }),
        new LabeledFrame({ video: baseVideo, frameIdx: 7, bboxes: [elsewhere] }),
      ],
      videos: [baseVideo],
    });
    useAppStore.getState().setLabels(labels, "base.slp");

    const predVideo = video("/node/v.mp4");
    const predictions = new Labels({
      labeledFrames: [
        new LabeledFrame({
          video: predVideo,
          frameIdx: 0,
          bboxes: [new PredictedBoundingBox({ x1: 3, y1: 3, x2: 20, y2: 20, score: 0.9 })],
        }),
      ],
      videos: [predVideo],
    });
    const spy = vi.spyOn(toast, "success");
    await ctx.execute(MergePredictions, { predictions, mode: "clear_all" });

    const current = useAppStore.getState().labels as Labels;
    const f0 = current.find({ video: baseVideo, frameIdx: 0 })[0];
    expect(f0.bboxes.filter((b) => !b.isPredicted)).toHaveLength(1);
    expect(f0.bboxes.filter((b) => b.isPredicted).map((b) => (b as PredictedBoundingBox).score)).toEqual([0.9]);
    // The frame that only held a stale predicted box is gone.
    expect(current.find({ video: baseVideo, frameIdx: 7 })).toHaveLength(0);
    expect(String(spy.mock.calls.at(-1)?.[0])).toContain("1 box(es)");
    spy.mockRestore();
  });
});

describe("sleap-nn 0.4: bbox_detr, pretrained backbones, and per-stage export", () => {
  beforeEach(() => useTrainingStore.getState().reset());

  it("recognizes bbox_detr in BBOX_HEAD_KEYS, headTypeMatches, and preset parsing without clobbering dinov2_windowed or detr stride", () => {
    expect(isBboxHeadKey("bbox_detr")).toBe(true);
    expect(headTypeMatches("bbox", { headKey: "bbox_detr" })).toBe(true);

    const cf = loadPreset("baseline.bbox_detr.yaml", "bbox");
    expect(cf.modelType).toBe("bbox_detr");
    expect(cf.hyperparams.backbone).toBe("dinov2_windowed");
    expect(cf.hyperparams.colorMode).toBe("rgb");

    const doc = written({ ...cf, hyperparams: { ...cf.hyperparams, bboxSource: "bboxes", bboxPadding: 4 } });
    expect(activeHeads(doc)).toEqual(["bbox_detr"]);
    expect(doc.model_config.head_configs.bbox_detr.detr.output_stride).toBe(16);
    expect(doc.data_config.bbox_source).toBe("bboxes");
    expect(doc.data_config.bbox_padding).toBe(4);
    // Only dinov2_windowed is non-null (never clobbered into unet).
    const activeBackbones = Object.entries(doc.model_config.backbone_config as Doc)
      .filter(([, v]) => v != null)
      .map(([k]) => k);
    expect(activeBackbones).toEqual(["dinov2_windowed"]);
    expect(doc.model_config.backbone_config.dinov2_windowed.weights).toBe("facebook/dinov2-small");
  });

  it("preserves backbone_config.pretrained verbatim and nulls it when switching back to UNet/ConvNeXt", () => {
    const pretrainedYaml = yaml.dump({
      data_config: { preprocessing: { ensure_rgb: true, scale: 1.0 } },
      model_config: {
        backbone_config: {
          unet: null,
          convnext: null,
          swint: null,
          pretrained: {
            model_name: "facebook/dinov2-small",
            vit_decoder: "vit_decoder",
            in_channels: 3,
            max_stride: 16,
          },
        },
        head_configs: {
          centered_instance: { confmaps: { output_stride: 4, sigma: 2.5 } },
        },
      },
      trainer_config: { max_epochs: 50, train_data_loader: { batch_size: 4 } },
    });

    const cf = useTrainingStore.getState().parseYamlConfig(pretrainedYaml, "pretrained.yaml", "centered_instance")!;
    expect(cf.hyperparams.backbone).toBe("pretrained");

    // Keeping pretrained preserves all fields and leaves all other backbones null.
    const kept = written(cf);
    const activeKept = Object.entries(kept.model_config.backbone_config as Doc)
      .filter(([, v]) => v != null)
      .map(([k]) => k);
    expect(activeKept).toEqual(["pretrained"]);
    expect(kept.model_config.backbone_config.pretrained.model_name).toBe("facebook/dinov2-small");
    expect(kept.model_config.backbone_config.pretrained.vit_decoder).toBe("vit_decoder");

    // Switching to unet nulls out pretrained so @oneof never sees two active backbones.
    const switched = written({ ...cf, hyperparams: { ...cf.hyperparams, backbone: "unet" } });
    const activeSwitched = Object.entries(switched.model_config.backbone_config as Doc)
      .filter(([, v]) => v != null)
      .map(([k]) => k);
    expect(activeSwitched).toEqual(["unet"]);
    expect(switched.model_config.backbone_config.pretrained).toBeNull();
  });

  it("plans per-stage exports (with --network-only on pose) for top_down_bbox, single bundle for classic top_down", () => {
    const bboxJobs = planPostTrainingExports(
      "top_down_bbox",
      ["/m/det", "/m/pose"],
      "/m/exported",
      "onnx",
      "fp16",
    );
    expect(bboxJobs).toEqual([
      { modelPaths: ["/m/det"], outputDir: "/m/exported/detector", format: "onnx", precision: "fp16" },
      { modelPaths: ["/m/pose"], outputDir: "/m/exported/pose", format: "onnx", precision: "fp16", networkOnly: true },
    ]);

    const classicJobs = planPostTrainingExports(
      "top_down",
      ["/m/centroid", "/m/ci"],
      "/m/exported",
      "tensorrt",
      "bf16",
    );
    expect(classicJobs).toEqual([
      { modelPaths: ["/m/centroid", "/m/ci"], outputDir: "/m/exported", format: "tensorrt", precision: "bf16" },
    ]);
  });
});
