/**
 * Inference settings that used to be dropped: what a Connect worker won't
 * apply (and the fields sent for one that will), the post-training run's max
 * instances / overlap filter / device / batch size, and the Inference panel's
 * remembered settings.
 */
import { describe, it, expect } from "../bun-test";
import type { InferenceConfig } from "@/stores/inferenceStore";
import { INFERENCE_DEFAULTS } from "@/lib/inferenceDefaults";
import { remoteIgnoredSettings, WORKER_ALL_TRACK_OPTIONS_FEATURE } from "@/lib/remoteInferenceSupport";
import { buildRemoteTrackSpecs } from "@/lib/remoteTrackSpec";
import {
  buildPostTrainingInferenceConfig,
  defaultHyperparams,
  postTrainingBatchSize,
  postTrainingDevice,
  type ConfigFile,
} from "@/stores/trainingStore";
import { sanitizeSavedInferenceSettings, settingsToSave } from "@/lib/inferenceSettings";

function config(over: Partial<InferenceConfig> = {}): InferenceConfig {
  return { ...INFERENCE_DEFAULTS, modelPaths: ["/m/a"], videoIndex: 0, frameRange: "video", ...over };
}

function cf(over: Partial<ConfigFile["hyperparams"]> = {}): ConfigFile {
  const hp = { ...defaultHyperparams, ...over };
  return {
    filename: "c.yaml",
    content: "",
    modelType: "centroid",
    slot: "centroid",
    hyperparams: hp,
    originalHyperparams: hp,
    hasTrainedModel: false,
    checkpointPath: null,
  } as ConfigFile;
}

describe("remoteIgnoredSettings", () => {
  it("is empty at the defaults", () => {
    expect(remoteIgnoredSettings(config())).toEqual([]);
  });

  it("lists changed settings a worker drops, and only those", () => {
    const got = remoteIgnoredSettings(
      config({
        maxInstances: 2,
        integralRefinement: false,
        device: "cpu",
        tracking: true,
        trackerMethod: "kalman",
        similarityMethod: "iou",
        filterOverlapping: true,
        filterMinInstanceScore: 0.3,
        // Applied by the worker: not listed.
        batchSize: 16,
        peakThreshold: 0.4,
        trackingWindowSize: 9,
        maxTracks: 2,
      }),
    );
    expect(got).toEqual([
      "Max instances",
      "Integral refinement",
      "Device",
      "Kalman tracker (the worker runs the classic tracker)",
      "IoU similarity (the worker compares keypoints, not boxes)",
      "Filter overlapping instances",
      "Instance filters",
    ]);
  });

  it("bottom-up grouping only counts for bottom-up pipelines", () => {
    expect(remoteIgnoredSettings(config({ nPoints: 20 }))).toEqual([]);
    expect(remoteIgnoredSettings(config({ pipeline: "bottom-up", nPoints: 20 }))).toEqual(["Bottom-up grouping"]);
  });

  it("is empty for a worker that applies every option", () => {
    expect(remoteIgnoredSettings(config({ maxInstances: 2 }), [WORKER_ALL_TRACK_OPTIONS_FEATURE])).toEqual([]);
  });
});

describe("remote track spec carries every setting", () => {
  const ctx = { dataPath: "/w/p.slp", pathMappings: {}, videoFrameCounts: [100], currentFrameIdx: 0, activeVideoFrameCount: 100 };

  it("sends max instances, refinement, device; bottom-up grouping only for bottom-up", () => {
    const [spec] = buildRemoteTrackSpecs(config({ maxInstances: 3, integralRefinement: false, device: "cuda" }), ctx);
    expect(spec.max_instances).toBe(3);
    expect(spec.integral_refinement).toBe("none");
    expect(spec.integral_patch_size).toBeUndefined();
    expect(spec.device).toBe("cuda");
    expect(spec.n_points).toBeUndefined();
    const [bu] = buildRemoteTrackSpecs(config({ pipeline: "bottom-up", nPoints: 12 }), ctx);
    expect(bu.n_points).toBe(12);
    expect(bu.integral_refinement).toBe("integral");
    expect(bu.integral_patch_size).toBe(5);
    expect(bu.device).toBeUndefined();
  });
});

describe("post-training inference settings", () => {
  const base = { modelType: "top_down" as const, modelPaths: ["/m/c", "/m/ci"], inferenceTarget: "suggestions", videoIndex: "all" as const };

  it("defaults: no max, no overlap filter, batch 4, device auto", () => {
    const c = buildPostTrainingInferenceConfig(base);
    expect([c.maxInstances, c.filterOverlapping, c.batchSize, c.device]).toEqual([null, false, 4, "auto"]);
  });

  it("applies the Training window's max instances and overlap filter, and the given batch size", () => {
    const c = buildPostTrainingInferenceConfig({
      ...base,
      batchSize: 8,
      postInference: { maxInstances: 2, filterOverlapping: true, filterMethod: "oks", filterThreshold: 0.5 },
    });
    expect([c.maxInstances, c.filterOverlapping, c.filterMethod, c.filterThreshold, c.batchSize]).toEqual([2, true, "oks", 0.5, 8]);
  });

  it("device follows the training accelerator when the configs agree; batch is the smallest training batch", () => {
    expect(postTrainingDevice([cf({ accelerator: "cpu" }), cf({ accelerator: "cpu" })])).toBe("cpu");
    expect(postTrainingDevice([cf({ accelerator: "cpu" }), cf({ accelerator: "mps" })])).toBe("auto");
    expect(postTrainingBatchSize([cf({ batchSize: 16 }), cf({ batchSize: 4 })])).toBe(4);
    expect(postTrainingBatchSize([])).toBe(4);
  });
});

describe("remembered Inference panel settings", () => {
  it("round-trips the settings, target and custom range; never model paths, video or track-only", () => {
    const saved = settingsToSave(config({
      peakThreshold: 0.35,
      maxInstances: 2,
      tracking: true,
      trackOnly: true,
      pipeline: "bottom-up",
      integralRefinement: "dark",
      precision: "bf16-encoder",
      uploadBatches: true,
      flipTest: true,
      rescore: true,
      bboxNmsIou: 0.45,
      slpVersion: "v3",
    }), {
      target: "clip",
      customStart: "10",
      customEnd: "20",
    });
    const back = sanitizeSavedInferenceSettings(JSON.parse(JSON.stringify(saved)));
    expect(back.peakThreshold).toBe(0.35);
    expect(back.maxInstances).toBe(2);
    expect(back.pipeline).toBe("bottom-up");
    expect(back.integralRefinement).toBe("dark");
    expect(back.precision).toBe("bf16-encoder");
    expect(back.uploadBatches).toBe(true);
    expect(back.flipTest).toBe(true);
    expect(back.rescore).toBe(true);
    expect(back.bboxNmsIou).toBe(0.45);
    expect(back.slpVersion).toBe("v3");
    expect([back.target, back.customStart, back.customEnd]).toEqual(["clip", "10", "20"]);
    expect("trackOnly" in back).toBe(false);
    expect("modelPaths" in back).toBe(false);
    expect("videoIndex" in back).toBe(false);
  });

  it("migrates legacy boolean integralRefinement (true -> auto, false -> none)", () => {
    expect(sanitizeSavedInferenceSettings({ integralRefinement: true }).integralRefinement).toBe("auto");
    expect(sanitizeSavedInferenceSettings({ integralRefinement: false }).integralRefinement).toBe("none");
  });

  it("drops unknown keys and wrongly typed values", () => {
    expect(
      sanitizeSavedInferenceSettings({ peakThreshold: "high", batchSize: 8, bogus: 1, target: "nowhere", maxInstances: null, kfNodeIndices: [1, "x"] }),
    ).toEqual({ batchSize: 8, maxInstances: null });
    expect(sanitizeSavedInferenceSettings(null)).toEqual({});
    expect(sanitizeSavedInferenceSettings("junk")).toEqual({});
  });
});
