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
    anchorPart: null,
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
    flowImgScale: 1,
    flowWindowSize: 21,
    flowMaxLevels: 3,
    ensureChannels: "auto",
    filterOverlapping: false,
    filterMethod: "iou",
    filterThreshold: 0.5,
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

  it("includes optional max_instances/anchor_part when set, omits when null", () => {
    const set = buildInferenceArgs(baseConfig({ maxInstances: 3, anchorPart: "thorax" }), io());
    expect(valAfter(set, "--max_instances")).toBe("3");
    expect(valAfter(set, "--anchor_part")).toBe("thorax");
    const unset = buildInferenceArgs(baseConfig({ maxInstances: null, anchorPart: null }), io());
    expect(unset).not.toContain("--max_instances");
    expect(unset).not.toContain("--anchor_part");
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

  it("throws for the non-runnable 'frame' range", () => {
    expect(() => buildInferenceArgs(baseConfig({ frameRange: "frame" }), io())).toThrow(/Unhandled frame range/);
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
});

describe("isPredictSupported / version floor", () => {
  it("MIN_SLEAP_NN_PREDICT_VERSION is 0.2.0", () => {
    expect(MIN_SLEAP_NN_PREDICT_VERSION).toBe("0.2.0");
  });

  it("allows unknown/empty/unparseable versions (don't block on uncertainty)", () => {
    expect(isPredictSupported(null)).toBe(true);
    expect(isPredictSupported(undefined)).toBe(true);
    expect(isPredictSupported("")).toBe(true);
    expect(isPredictSupported("garbage")).toBe(true);
    expect(isPredictSupported("0.3.0a1")).toBe(true); // no separator → unparseable → allowed
  });

  it("blocks parseable versions below the floor", () => {
    expect(isPredictSupported("0.1.0")).toBe(false);
    expect(isPredictSupported("0.1.3")).toBe(false);
  });

  it("allows the floor and above", () => {
    expect(isPredictSupported("0.2.0")).toBe(true);
    expect(isPredictSupported("0.3.1")).toBe(true);
    expect(isPredictSupported("1.0.0")).toBe(true);
    expect(isPredictSupported("0.3.0-rc1")).toBe(true); // separator → core 0.3.0 ≥ floor
  });
});

describe("pickInferenceSubcommand — back-compat fallback (never blocks old users)", () => {
  it("uses `predict` on the floor and newer installs", () => {
    expect(pickInferenceSubcommand("0.2.0")).toBe("predict");
    expect(pickInferenceSubcommand("0.3.1")).toBe("predict");
    expect(pickInferenceSubcommand("1.0.0")).toBe("predict");
  });

  it("falls back to legacy `track` on installs that predate `predict` (< 0.2.0)", () => {
    expect(pickInferenceSubcommand("0.1.0")).toBe("track");
    expect(pickInferenceSubcommand("0.1.3")).toBe("track");
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
    anchorPart: "head",
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
    "--anchor_part", "head",
    "--integral_refinement", "integral",
    "--integral_patch_size", "7",
    "--n_points", "12",
    "--max_edge_length_ratio", "0.3",
    "--dist_penalty_weight", "2",
    "--min_line_scores", "0.1",
    "--ensure_rgb",
    "--tracking",
    "--use_flow",
    "--scoring_method", "iou",
    "--track_matching_method", "greedy",
    "--tracking_window_size", "9",
    "--max_tracks", "4",
    "--robust_best_instance", "0.95",
    "--post_connect_single_breaks",
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
