import { describe, it, expect } from "../bun-test";
import type { InferenceConfig } from "@/stores/inferenceStore";
import {
  buildInferenceArgs,
  compareVersions,
  isPredictSupported,
  pickInferenceSubcommand,
  MIN_SLEAP_NN_PREDICT_VERSION,
} from "@/platform/inferenceArgs";

/** A complete top-down, no-tracking, no-filter baseline config. */
function baseConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    pipeline: "top-down",
    modelPaths: ["/models/centroid", "/models/centered_instance"],
    videoIndex: "all",
    frameRange: "video",
    sampleCount: 20,
    excludeUserLabeled: false,
    batchSize: 4,
    device: "auto",
    maxInstances: null,
    peakThreshold: 0.2,
    integralRefinement: false,
    integralPatchSize: 5,
    nPoints: 10,
    maxEdgeLengthRatio: 0.25,
    distPenaltyWeight: 1,
    minLineScores: 0.25,
    tracking: false,
    trackerMethod: "simple",
    similarityMethod: "oks",
    matchingMethod: "hungarian",
    trackingWindowSize: 5,
    maxTracks: null,
    connectSingleBreaks: false,
    robust: 1,
    minMatchPoints: 0,
    minNewTrackPoints: 0,
    scoringReduction: "mean",
    trackingTargetInstanceCount: null,
    trackingPreCullToTarget: false,
    trackingPreCullIouThreshold: 0,
    trackingCleanInstanceCount: null,
    trackingCleanIouThreshold: 0,
    flowImgScale: 1,
    flowWindowSize: 21,
    flowMaxLevels: 3,
    kfTrackFeatures: "centroid",
    kfInitFrameCount: 10,
    kfNodeIndices: [],
    kfResetGapSize: 5,
    ensureChannels: "auto",
    filterOverlapping: false,
    filterMethod: "iou",
    filterThreshold: 0.5,
    filterMinVisibleNodes: null,
    filterMinVisibleNodeFraction: null,
    filterMinMeanNodeScore: null,
    filterMinInstanceScore: null,
    filterMinCentroidDistance: null,
    ...overrides,
  };
}

const io = () => ({ dataPath: "in.slp", outputPath: "out.slp" });

/** Value that immediately follows a flag, or undefined if the flag is absent. */
function valAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** All values that follow each occurrence of a (repeatable) flag. */
function allAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

describe("buildInferenceArgs — subcommand", () => {
  it("defaults to the `predict` subcommand followed by --gui", () => {
    const args = buildInferenceArgs(baseConfig(), io());
    expect(args[0]).toBe("predict");
    expect(args[1]).toBe("--gui");
  });

  it("honors an explicit subcommand override (legacy `track`)", () => {
    const args = buildInferenceArgs(baseConfig(), { ...io(), subcommand: "track" });
    expect(args[0]).toBe("track");
    expect(args[1]).toBe("--gui");
  });
});

describe("buildInferenceArgs — core I/O", () => {
  it("emits data/output paths and repeats --model_paths in order", () => {
    const args = buildInferenceArgs(baseConfig({ modelPaths: ["/m/a", "/m/b"] }), io());
    expect(valAfter(args, "--data_path")).toBe("in.slp");
    expect(valAfter(args, "--output_path")).toBe("out.slp");
    expect(allAfter(args, "--model_paths")).toEqual(["/m/a", "/m/b"]);
    expect(valAfter(args, "--batch_size")).toBe("4");
    expect(valAfter(args, "--device")).toBe("auto");
    expect(valAfter(args, "--peak_threshold")).toBe("0.2");
  });

  it("omits --video_index when 'all' and includes it for a number", () => {
    expect(buildInferenceArgs(baseConfig({ videoIndex: "all" }), io())).not.toContain("--video_index");
    expect(valAfter(buildInferenceArgs(baseConfig({ videoIndex: 2 }), io()), "--video_index")).toBe("2");
  });

  it("includes optional max_instances when set, omits when null", () => {
    const set = buildInferenceArgs(baseConfig({ maxInstances: 3 }), io());
    expect(valAfter(set, "--max_instances")).toBe("3");
    const unset = buildInferenceArgs(baseConfig({ maxInstances: null }), io());
    expect(unset).not.toContain("--max_instances");
  });

  it("never emits --anchor_part (not a predict/track flag — sleap-nn eval only)", () => {
    const args = buildInferenceArgs(baseConfig(), io());
    expect(args).not.toContain("--anchor_part");
  });
});

describe("buildInferenceArgs — frame ranges", () => {
  it("maps a {start,end} object to --frames start-end", () => {
    const args = buildInferenceArgs(baseConfig({ frameRange: { start: 10, end: 20 } }), io());
    expect(valAfter(args, "--frames")).toBe("10-20");
  });

  it("maps named ranges to their flags", () => {
    expect(buildInferenceArgs(baseConfig({ frameRange: "user_labeled" }), io())).toContain("--only_labeled_frames");
    expect(buildInferenceArgs(baseConfig({ frameRange: "suggestions" }), io())).toContain("--only_suggested_frames");
    expect(buildInferenceArgs(baseConfig({ frameRange: "predicted" }), io())).toContain("--only_predicted_frames");
  });

  it("emits no frame-selection flag for 'video' / 'all_videos'", () => {
    for (const fr of ["video", "all_videos"] as const) {
      const args = buildInferenceArgs(baseConfig({ frameRange: fr }), io());
      expect(args).not.toContain("--frames");
      expect(args).not.toContain("--only_labeled_frames");
    }
  });

  it("uses caller-supplied sampledFrames for 'random_video'", () => {
    const args = buildInferenceArgs(baseConfig({ frameRange: "random_video" }), {
      ...io(),
      sampledFrames: [1, 4, 9],
    });
    expect(valAfter(args, "--frames")).toBe("1,4,9");
  });

  it("throws for 'random_video' without sampledFrames", () => {
    expect(() => buildInferenceArgs(baseConfig({ frameRange: "random_video" }), io())).toThrow(/pre-sampled/);
  });

  it("throws for 'random' (needs per-video invocation)", () => {
    expect(() => buildInferenceArgs(baseConfig({ frameRange: "random" }), io())).toThrow(/per-video/);
  });

  it("uses caller-supplied currentFrameIdx for 'frame'", () => {
    const args = buildInferenceArgs(baseConfig({ frameRange: "frame" }), {
      ...io(),
      currentFrameIdx: 42,
    });
    expect(valAfter(args, "--frames")).toBe("42");
  });

  it("throws for 'frame' without currentFrameIdx", () => {
    expect(() => buildInferenceArgs(baseConfig({ frameRange: "frame" }), io())).toThrow(/currentFrameIdx/);
  });

  it("omits --video_index when suppressVideoIndex is set, even with a specific videoIndex", () => {
    const args = buildInferenceArgs(baseConfig({ frameRange: "video", videoIndex: 2 }), {
      ...io(),
      suppressVideoIndex: true,
    });
    expect(args).not.toContain("--video_index");
  });
});

describe("buildInferenceArgs — tracking / bottom-up / preprocessing / filter", () => {
  it("emits tracking flags only when tracking is on", () => {
    expect(buildInferenceArgs(baseConfig({ tracking: false }), io())).not.toContain("--tracking");
    const args = buildInferenceArgs(
      baseConfig({ tracking: true, similarityMethod: "oks", matchingMethod: "greedy", trackingWindowSize: 7 }),
      io()
    );
    expect(args).toContain("--tracking");
    expect(valAfter(args, "--scoring_method")).toBe("oks");
    expect(valAfter(args, "--track_matching_method")).toBe("greedy");
    expect(valAfter(args, "--tracking_window_size")).toBe("7");
  });

  it("centroids similarity emits --features centroids + euclidean_dist scoring", () => {
    const args = buildInferenceArgs(baseConfig({ tracking: true, similarityMethod: "centroids" }), io());
    expect(valAfter(args, "--features")).toBe("centroids");
    expect(valAfter(args, "--scoring_method")).toBe("euclidean_dist");
  });

  it("flow tracker emits --use_flow plus the optical-flow sub-params (regression: these were previously dropped)", () => {
    const args = buildInferenceArgs(
      baseConfig({ tracking: true, trackerMethod: "flow", flowImgScale: 0.5, flowWindowSize: 15, flowMaxLevels: 4 }),
      io()
    );
    expect(args).toContain("--use_flow");
    expect(valAfter(args, "--of_img_scale")).toBe("0.5");
    expect(valAfter(args, "--of_window_size")).toBe("15");
    expect(valAfter(args, "--of_max_levels")).toBe("4");
    expect(args).not.toContain("--use_kalman");
  });

  it("kalman tracker emits --use_kalman plus kf_* params, and --kf_node_indices only when nodes are selected", () => {
    const noNodes = buildInferenceArgs(
      baseConfig({
        tracking: true,
        trackerMethod: "kalman",
        kfTrackFeatures: "keypoints",
        kfInitFrameCount: 15,
        kfResetGapSize: 8,
        kfNodeIndices: [],
      }),
      io()
    );
    expect(noNodes).toContain("--use_kalman");
    expect(valAfter(noNodes, "--kf_track_features")).toBe("keypoints");
    expect(valAfter(noNodes, "--kf_init_frame_count")).toBe("15");
    expect(valAfter(noNodes, "--kf_reset_gap_size")).toBe("8");
    expect(noNodes).not.toContain("--kf_node_indices");
    expect(noNodes).not.toContain("--use_flow");

    const withNodes = buildInferenceArgs(
      baseConfig({ tracking: true, trackerMethod: "kalman", kfNodeIndices: [0, 2, 3] }),
      io()
    );
    expect(valAfter(withNodes, "--kf_node_indices")).toBe("0,2,3");
  });

  it("emits the general scoring/matching params unconditionally when tracking is on", () => {
    const args = buildInferenceArgs(
      baseConfig({
        tracking: true,
        minMatchPoints: 2,
        minNewTrackPoints: 3,
        scoringReduction: "robust_quantile",
      }),
      io()
    );
    expect(valAfter(args, "--min_match_points")).toBe("2");
    expect(valAfter(args, "--min_new_track_points")).toBe("3");
    expect(valAfter(args, "--scoring_reduction")).toBe("robust_quantile");
  });

  it("includes --tracking_target_instance_count only when set", () => {
    const set = buildInferenceArgs(baseConfig({ tracking: true, trackingTargetInstanceCount: 4 }), io());
    expect(valAfter(set, "--tracking_target_instance_count")).toBe("4");
    const unset = buildInferenceArgs(baseConfig({ tracking: true, trackingTargetInstanceCount: null }), io());
    expect(unset).not.toContain("--tracking_target_instance_count");
  });

  it("emits pre-cull flags only when enabled", () => {
    const off = buildInferenceArgs(baseConfig({ tracking: true, trackingPreCullToTarget: false }), io());
    expect(off).not.toContain("--tracking_pre_cull_to_target");
    expect(off).not.toContain("--tracking_pre_cull_iou_threshold");
    const on = buildInferenceArgs(
      baseConfig({ tracking: true, trackingPreCullToTarget: true, trackingPreCullIouThreshold: 0.6 }),
      io()
    );
    expect(valAfter(on, "--tracking_pre_cull_to_target")).toBe("1");
    expect(valAfter(on, "--tracking_pre_cull_iou_threshold")).toBe("0.6");
  });

  it("emits clean-up flags only when an instance count is set", () => {
    const off = buildInferenceArgs(baseConfig({ tracking: true, trackingCleanInstanceCount: null }), io());
    expect(off).not.toContain("--tracking_clean_instance_count");
    expect(off).not.toContain("--tracking_clean_iou_threshold");
    const on = buildInferenceArgs(
      baseConfig({ tracking: true, trackingCleanInstanceCount: 2, trackingCleanIouThreshold: 0.7 }),
      io()
    );
    expect(valAfter(on, "--tracking_clean_instance_count")).toBe("2");
    expect(valAfter(on, "--tracking_clean_iou_threshold")).toBe("0.7");
  });

  it("adds PAF flags for bottom-up pipelines only", () => {
    const bu = buildInferenceArgs(baseConfig({ pipeline: "bottom-up", nPoints: 8 }), io());
    expect(valAfter(bu, "--n_points")).toBe("8");
    expect(bu).toContain("--max_edge_length_ratio");
    expect(buildInferenceArgs(baseConfig({ pipeline: "top-down" }), io())).not.toContain("--n_points");
  });

  it("maps ensureChannels to the right preprocessing flag", () => {
    expect(buildInferenceArgs(baseConfig({ ensureChannels: "rgb" }), io())).toContain("--ensure_rgb");
    expect(buildInferenceArgs(baseConfig({ ensureChannels: "grayscale" }), io())).toContain("--ensure_grayscale");
    const auto = buildInferenceArgs(baseConfig({ ensureChannels: "auto" }), io());
    expect(auto).not.toContain("--ensure_rgb");
    expect(auto).not.toContain("--ensure_grayscale");
  });

  it("emits filter-overlapping flags when enabled", () => {
    const args = buildInferenceArgs(
      baseConfig({ filterOverlapping: true, filterMethod: "oks", filterThreshold: 0.3 }),
      io()
    );
    expect(args).toContain("--filter_overlapping");
    expect(valAfter(args, "--filter_overlapping_method")).toBe("oks");
    expect(valAfter(args, "--filter_overlapping_threshold")).toBe("0.3");
  });

  it("omits every filter_min_* flag when all are unset", () => {
    const args = buildInferenceArgs(baseConfig(), io());
    expect(args).not.toContain("--filter_min_visible_nodes");
    expect(args).not.toContain("--filter_min_visible_node_fraction");
    expect(args).not.toContain("--filter_min_mean_node_score");
    expect(args).not.toContain("--filter_min_instance_score");
    expect(args).not.toContain("--filter_min_centroid_distance");
  });

  it("emits each filter_min_* flag independently when set", () => {
    const args = buildInferenceArgs(
      baseConfig({
        filterMinVisibleNodes: 3,
        filterMinVisibleNodeFraction: 0.5,
        filterMinMeanNodeScore: 0.4,
        filterMinInstanceScore: 0.2,
        filterMinCentroidDistance: 10,
      }),
      io()
    );
    expect(valAfter(args, "--filter_min_visible_nodes")).toBe("3");
    expect(valAfter(args, "--filter_min_visible_node_fraction")).toBe("0.5");
    expect(valAfter(args, "--filter_min_mean_node_score")).toBe("0.4");
    expect(valAfter(args, "--filter_min_instance_score")).toBe("0.2");
    expect(valAfter(args, "--filter_min_centroid_distance")).toBe("10");
  });
});

describe("isPredictSupported / version floor", () => {
  it("MIN_SLEAP_NN_PREDICT_VERSION is 0.3.2 (reliable predict --gui + metrics JSON sibling)", () => {
    expect(MIN_SLEAP_NN_PREDICT_VERSION).toBe("0.3.2");
  });

  it("allows unknown/empty/unparseable versions (don't block on uncertainty)", () => {
    expect(isPredictSupported(null)).toBe(true);
    expect(isPredictSupported(undefined)).toBe(true);
    expect(isPredictSupported("")).toBe(true);
    expect(isPredictSupported("garbage")).toBe(true);
    expect(isPredictSupported("0.3.0a1")).toBe(true); // no separator → unparseable → allowed
  });

  it("blocks parseable versions below the floor (0.2.0–0.3.1: broken save or corrupt predict --gui)", () => {
    expect(isPredictSupported("0.1.0")).toBe(false);
    expect(isPredictSupported("0.1.3")).toBe(false);
    expect(isPredictSupported("0.2.0")).toBe(false);
    expect(isPredictSupported("0.3.0")).toBe(false);
    expect(isPredictSupported("0.3.1")).toBe(false); // save works but predict --gui JSON is corrupt
  });

  it("allows the floor and above", () => {
    expect(isPredictSupported("0.3.2")).toBe(true);
    expect(isPredictSupported("0.3.3")).toBe(true);
    expect(isPredictSupported("0.4.0")).toBe(true);
    expect(isPredictSupported("1.0.0")).toBe(true);
    expect(isPredictSupported("0.3.2-rc1")).toBe(true); // separator → core 0.3.2 ≥ floor
  });
});

describe("pickInferenceSubcommand — back-compat fallback (never blocks old users)", () => {
  it("uses `predict` on the floor and newer installs", () => {
    expect(pickInferenceSubcommand("0.3.2")).toBe("predict");
    expect(pickInferenceSubcommand("0.3.3")).toBe("predict");
    expect(pickInferenceSubcommand("0.4.0")).toBe("predict");
    expect(pickInferenceSubcommand("1.0.0")).toBe("predict");
  });

  it("falls back to legacy `track` below the floor (< 0.3.2)", () => {
    expect(pickInferenceSubcommand("0.1.3")).toBe("track"); // predict didn't exist yet
    expect(pickInferenceSubcommand("0.2.0")).toBe("track"); // predict exists but save is broken
    expect(pickInferenceSubcommand("0.3.0")).toBe("track"); // ditto
    expect(pickInferenceSubcommand("0.3.1")).toBe("track"); // save works but predict --gui JSON is corrupt
  });

  it("uses `predict` when the version is unknown/unparseable (new installs report a version)", () => {
    expect(pickInferenceSubcommand(null)).toBe("predict");
    expect(pickInferenceSubcommand(undefined)).toBe("predict");
    expect(pickInferenceSubcommand("")).toBe("predict");
    expect(pickInferenceSubcommand("garbage")).toBe("predict");
  });
});

describe("compareVersions", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("0.1.3", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.3.1", "0.2.0")).toBe(1);
    expect(compareVersions("1.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
  });
});

describe("buildInferenceArgs — full-config parity lock", () => {
  // A maximal "everything on" config that exercises every optional branch in one
  // shot (excludeUserLabeled, integral, bottom-up-id PAF block, flow tracker,
  // non-centroids scoring, maxTracks, connectSingleBreaks, filter). Asserting the
  // exact array locks in byte-for-byte argv parity, so any future edit that
  // reorders/renames a flag or changes value coercion fails loudly.
  const maximal = baseConfig({
    pipeline: "bottom-up-id",
    modelPaths: ["/m/a"],
    videoIndex: 3,
    frameRange: "user_labeled",
    excludeUserLabeled: true,
    batchSize: 8,
    device: "cuda",
    maxInstances: 2,
    peakThreshold: 0.15,
    integralRefinement: true,
    integralPatchSize: 7,
    nPoints: 12,
    maxEdgeLengthRatio: 0.3,
    distPenaltyWeight: 2,
    minLineScores: 0.1,
    tracking: true,
    trackerMethod: "flow",
    similarityMethod: "iou",
    matchingMethod: "greedy",
    trackingWindowSize: 9,
    maxTracks: 4,
    connectSingleBreaks: true,
    robust: 0.95,
    ensureChannels: "rgb",
    filterOverlapping: true,
    filterMethod: "oks",
    filterThreshold: 0.4,
  });

  const expected = [
    "predict", "--gui",
    "--data_path", "in.slp",
    "--model_paths", "/m/a",
    "--output_path", "out.slp",
    "--video_index", "3",
    "--only_labeled_frames",
    "--exclude_user_labeled",
    "--batch_size", "8",
    "--device", "cuda",
    "--max_instances", "2",
    "--peak_threshold", "0.15",
    "--integral_refinement", "integral",
    "--integral_patch_size", "7",
    "--n_points", "12",
    "--max_edge_length_ratio", "0.3",
    "--dist_penalty_weight", "2",
    "--min_line_scores", "0.1",
    "--ensure_rgb",
    "--tracking",
    "--use_flow",
    "--of_img_scale", "1",
    "--of_window_size", "21",
    "--of_max_levels", "3",
    "--scoring_method", "iou",
    "--track_matching_method", "greedy",
    "--tracking_window_size", "9",
    "--max_tracks", "4",
    "--robust_best_instance", "0.95",
    "--post_connect_single_breaks",
    "--min_match_points", "0",
    "--min_new_track_points", "0",
    "--scoring_reduction", "mean",
    "--filter_overlapping",
    "--filter_overlapping_method", "oks",
    "--filter_overlapping_threshold", "0.4",
  ];

  it("produces the exact expected argv for a maximal config", () => {
    expect(buildInferenceArgs(maximal, io())).toEqual(expected);
  });

  it("the ONLY difference between predict and legacy track is the first token", () => {
    const predictArgs = buildInferenceArgs(maximal, io());
    const trackArgs = buildInferenceArgs(maximal, { ...io(), subcommand: "track" });
    expect(trackArgs[0]).toBe("track");
    expect(predictArgs[0]).toBe("predict");
    expect(trackArgs.slice(1)).toEqual(predictArgs.slice(1));
  });
});
