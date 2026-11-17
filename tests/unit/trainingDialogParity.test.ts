/**
 * Training dialog parity with PyQt SLEAP (feat/training-dialog-parity):
 * negative-frame settings in the sleap-nn config, the crop-size warnings,
 * and the "Current frame" / "Selected clip" post-training inference targets.
 */
import { describe, it, expect } from "../bun-test";
import yaml from "js-yaml";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import { applyHyperparamsToYaml, defaultHyperparams, useTrainingStore } from "@/stores/trainingStore";
import { cropSizeWarnings, isCropHead, negativeFramesWarning, usesNegativeFrames } from "@/lib/cropWarnings";
import {
  POST_TRAINING_TARGET_OPTIONS,
  describeClip,
  normalizeClip,
  resolvePostTrainingTarget,
} from "@/lib/postTrainingTarget";
import { buildInferenceArgs } from "@/platform/inferenceArgs";
import { buildPostTrainingInferenceConfig } from "@/stores/trainingStore";

const BASE_YAML = `
data_config:
  validation_fraction: 0.1
  preprocessing:
    scale: 1.0
trainer_config:
  max_epochs: 10
model_config:
  head_configs:
    centroid:
      confmaps:
        sigma: 5.0
`;

function dataConfigOf(yamlText: string): Record<string, unknown> {
  return (yaml.load(yamlText) as { data_config: Record<string, unknown> }).data_config;
}

/** One 150×75 px animal on a 1000×1000 video, plus two empty videos for index checks. */
function makeLabels(): { labels: Labels; videos: Video[] } {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const videos = ["v0.mp4", "v1.mp4", "v2.mp4"].map(
    (filename) =>
      new Video({ filename, backendMetadata: { shape: [100, 1000, 1000, 3] }, openBackend: false }),
  );
  const lf = new LabeledFrame({ video: videos[0], frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  inst.points[0].xy = [0, 0];
  inst.points[0].visible = true;
  inst.points[1].xy = [150, 75];
  inst.points[1].visible = true;
  lf.instances.push(inst);
  return { labels: new Labels({ videos, skeletons: [skeleton], labeledFrames: [lf] }), videos };
}

describe("negative frames in the sleap-nn config", () => {
  // Older sleap-nn (< 0.1.3) rejects unknown config keys, so leaving the option off must not add them.
  it("does not add the keys while the option is off", () => {
    const data = dataConfigOf(applyHyperparamsToYaml(BASE_YAML, { ...defaultHyperparams }));
    expect("use_negative_frames" in data).toBe(false);
    expect("negative_loss_weight" in data).toBe(false);
  });

  // Turning the option on must reach sleap-nn under PyQt's exact key names.
  it("writes use_negative_frames and negative_loss_weight when on", () => {
    const out = applyHyperparamsToYaml(BASE_YAML, {
      ...defaultHyperparams,
      useNegativeFrames: true,
      negativeLossWeight: 2.5,
    });
    const data = dataConfigOf(out);
    expect(data.use_negative_frames).toBe(true);
    expect(data.negative_loss_weight).toBe(2.5);
  });

  // A config that already carries the keys (e.g. a previous run's) must really be turned off.
  it("turns the option off in a config that already has it on", () => {
    const withKeys = `${BASE_YAML.replace("validation_fraction: 0.1", "validation_fraction: 0.1\n  use_negative_frames: true\n  negative_loss_weight: 3.0")}`;
    const data = dataConfigOf(applyHyperparamsToYaml(withKeys, { ...defaultHyperparams, useNegativeFrames: false }));
    expect(data.use_negative_frames).toBe(false);
    expect(data.negative_loss_weight).toBe(1.0);
  });

  // sleap-nn requires the weight to be > 0; a bad value must never reach it.
  it("never writes a weight of zero or less", () => {
    const data = dataConfigOf(
      applyHyperparamsToYaml(BASE_YAML, { ...defaultHyperparams, useNegativeFrames: true, negativeLossWeight: 0 }),
    );
    expect(data.negative_loss_weight).toBe(1.0);
  });

  // Loading a config (profile, previous run, or browsed file) must show its saved values.
  it("reads both values back when a config is loaded", () => {
    const withKeys = BASE_YAML.replace(
      "validation_fraction: 0.1",
      "validation_fraction: 0.1\n  use_negative_frames: true\n  negative_loss_weight: 0.5",
    );
    const cf = useTrainingStore.getState().parseYamlConfig(withKeys, "c.yaml", "centroid");
    expect(cf?.hyperparams.useNegativeFrames).toBe(true);
    expect(cf?.hyperparams.negativeLossWeight).toBe(0.5);
    const plain = useTrainingStore.getState().parseYamlConfig(BASE_YAML, "c.yaml", "centroid");
    expect(plain?.hyperparams.useNegativeFrames).toBe(false);
    expect(plain?.hyperparams.negativeLossWeight).toBe(1.0);
  });

  // PyQt hides the fields on the cropping heads, which ignore negative frames.
  it("only applies to heads that use negative frames", () => {
    for (const head of ["single_instance", "centroid", "bottomup", "multi_class_bottomup"]) {
      expect(usesNegativeFrames(head)).toBe(true);
    }
    for (const head of ["centered_instance", "multi_class_topdown"]) {
      expect(usesNegativeFrames(head)).toBe(false);
      expect(isCropHead(head)).toBe(true);
    }
  });
});

describe("negative frames warning (PyQt LearningDialog)", () => {
  // Turning the option on without any negative frames does nothing; PyQt says so.
  it("warns when the option is on but no frame is marked negative", () => {
    const { labels } = makeLabels();
    expect(negativeFramesWarning(true, labels)).toContain("no frames are marked as negative");
    expect(negativeFramesWarning(false, labels)).toBeNull();
    expect(negativeFramesWarning(true, null)).toBeNull();
  });

  // Once a frame is marked negative the option does something, so the warning goes away.
  it("is quiet once a frame is marked negative", () => {
    const { labels, videos } = makeLabels();
    const neg = new LabeledFrame({ video: videos[0], frameIdx: 5 });
    neg.isNegative = true;
    labels.labeledFrames.push(neg);
    expect(negativeFramesWarning(true, labels)).toBeNull();
  });
});

describe("crop-size warnings (PyQt get_config_warnings)", () => {
  const { labels } = makeLabels();

  // The warnings are about crops, so heads that don't crop never get them.
  it("says nothing for heads that don't crop, or without labels", () => {
    expect(cropSizeWarnings("centroid", { ...defaultHyperparams, cropSize: 32 }, labels)).toEqual([]);
    expect(cropSizeWarnings("centered_instance", { ...defaultHyperparams, cropSize: 32 }, null)).toEqual([]);
  });

  // An explicit crop smaller than the biggest animal cuts animals off.
  it("warns when an explicit crop is smaller than the largest labeled animal", () => {
    const w = cropSizeWarnings("centered_instance", { ...defaultHyperparams, cropSize: 128 }, labels);
    expect(w.some((m) => m.includes("Crop size (128px) is smaller than the largest labeled instance (150px)"))).toBe(true);
  });

  // Input scaling shrinks the crop the model sees; under 100px centered-instance models do badly.
  it("warns when the crop after input scaling is under 100px", () => {
    const w = cropSizeWarnings("centered_instance", { ...defaultHyperparams, cropSize: 192, scale: 0.5 }, labels);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("only 96px after input scaling");
  });

  // Auto crop is computed in original pixels, then scaled — same as PyQt.
  it("checks the Auto crop size after scaling too", () => {
    const w = cropSizeWarnings("centered_instance", { ...defaultHyperparams, cropSize: null, scale: 0.25 }, labels);
    expect(w.some((m) => m.includes("after input scaling"))).toBe(true);
  });

  // A sensible setup must stay quiet.
  it("is quiet for a big-enough crop at full scale", () => {
    expect(cropSizeWarnings("centered_instance", { ...defaultHyperparams, cropSize: 256 }, labels)).toEqual([]);
    expect(cropSizeWarnings("multi_class_topdown", { ...defaultHyperparams, cropSize: null }, labels)).toEqual([]);
  });
});

describe("post-training inference targets", () => {
  const { labels, videos } = makeLabels();

  // PyQt's frame target selector offers both; the app now does too.
  it("lists Current frame and Selected clip", () => {
    const values = POST_TRAINING_TARGET_OPTIONS.map((o) => o.value);
    expect(values).toContain("frame");
    expect(values).toContain("clip");
    expect(new Set(values).size).toBe(values.length);
  });

  // "Current frame" must run on the video that's open, not every video.
  it("pins Current frame to the current video", () => {
    const r = resolvePostTrainingTarget("frame", { labels, video: videos[2], frameRange: null });
    expect(r).toEqual({ frameRange: "frame", videoIndex: 2 });
  });

  // "Selected clip" becomes an explicit range on the current video, even if dragged right-to-left.
  it("turns the timeline selection into a sorted frame range", () => {
    const r = resolvePostTrainingTarget("clip", { labels, video: videos[1], frameRange: [40, 10] });
    expect(r).toEqual({ frameRange: { start: 10, end: 40 }, videoIndex: 1 });
  });

  // With nothing selected there is nothing to run; skip with a reason instead of failing training.
  it("skips Selected clip when nothing is selected", () => {
    const r = resolvePostTrainingTarget("clip", { labels, video: videos[0], frameRange: null });
    expect("skip" in r).toBe(true);
  });

  // The existing targets keep their old video scoping.
  it("keeps whole-project targets on all videos", () => {
    expect(resolvePostTrainingTarget("suggestions", { labels, video: videos[1], frameRange: [1, 2] })).toEqual({
      frameRange: "suggestions",
      videoIndex: "all",
    });
    expect(resolvePostTrainingTarget("video", { labels, video: videos[1], frameRange: null })).toEqual({
      frameRange: "video",
      videoIndex: 1,
    });
  });

  // The clip must reach sleap-nn as an inclusive "start-end" range on the right video.
  it("builds sleap-nn arguments for a selected clip", () => {
    const r = resolvePostTrainingTarget("clip", { labels, video: videos[1], frameRange: [5, 9] });
    if ("skip" in r) throw new Error("unexpected skip");
    const cfg = buildPostTrainingInferenceConfig({
      modelType: "single_animal",
      modelPaths: ["/models/a"],
      inferenceTarget: r.frameRange,
      videoIndex: r.videoIndex,
    });
    const args = buildInferenceArgs(cfg, { dataPath: "/p.slp", outputPath: "/o.slp" });
    expect(args.join(" ")).toContain("--video_index 1");
    expect(args.join(" ")).toContain("--frames 5-9");
  });

  // The dropdown hint shows the same 0-based numbers as the status bar.
  it("describes the selected clip", () => {
    expect(describeClip([3, 3])).toBe("frames 3–3 (1 frame)");
    expect(describeClip([12, 3])).toBe("frames 3–12 (10 frames)");
    expect(describeClip(null)).toBeNull();
    expect(normalizeClip([2.7, -1])).toEqual({ start: 0, end: 2 });
  });
});
