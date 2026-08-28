/**
 * Pure builder for the `sleap-nn` local-inference CLI argv, plus the version
 * gate for the `predict` subcommand.
 *
 * Kept free of any Tauri / store imports so it is unit-testable in isolation
 * (see tests/unit/inferenceArgs.test.ts). `runInference` in ./backend.ts
 * resolves the runtime-only bits (temp paths, random-frame sampling via the app
 * store) and delegates the argv assembly here.
 *
 * Migration note (talmolab/sleap-nn): the app historically invoked the legacy
 * `track` command; it now invokes `predict` (the new `Predictor` pipeline).
 * `predict`'s flag set is a strict superset of every flag emitted here, so the
 * only argv change is the subcommand name.
 */

import type { InferenceConfig } from "@/stores/inferenceStore";

/**
 * Minimum `sleap-nn` version the app targets with the `predict` subcommand.
 *
 * `predict` first appeared in 0.2.0 (renamed from `infer`, talmolab/sleap-nn#607),
 * but wasn't reliable end-to-end for the app until **0.3.2**:
 *  - through 0.3.0 its save path crashed (`save_predictions` → sleap_io
 *    `Labels.save` on `video.backend is None`), so it never wrote an output —
 *    fixed in 0.3.1;
 *  - the app runs `predict --gui` for progress, and predict's `--gui` JSON was
 *    corrupted by interleaved log output until 0.3.2 (talmolab/sleap-nn#715),
 *    which routes logs to stderr and emits a structured JSON error line on
 *    failure.
 * 0.3.2 additionally writes the `metrics.{split}.{idx}.json` sibling the metrics
 * UI reads (#721). We therefore gate on 0.3.2; installs below it fall back to the
 * legacy `track` command (present in every version, with reliable `--gui`), so no
 * user is blocked.
 */
export const MIN_SLEAP_NN_PREDICT_VERSION = "0.3.2";

export interface BuildInferenceArgsOptions {
  /**
   * Path to the input .slp (the project file or a serialized temp copy), OR
   * the target video's own file when the caller resolved a video-scoped run
   * onto it directly (see `suppressVideoIndex`).
   */
  dataPath: string;
  /** Path the inference output .slp should be written to. */
  outputPath: string;
  /**
   * Pre-sampled frame indices for `frameRange === "random_video"`. The caller
   * resolves these (needs the app store + RNG); required for that range only.
   */
  sampledFrames?: number[];
  /**
   * Frame index for `frameRange === "frame"` (current frame). The caller
   * resolves this from the app store; required for that range only.
   */
  currentFrameIdx?: number;
  /**
   * Omit `--video_index` even though `config.videoIndex !== "all"`. Set this
   * when `dataPath` is already the target video's own file — `--video_index`
   * only means something when `--data_path` is a project .slp (see
   * talmolab/sleap#2848).
   */
  suppressVideoIndex?: boolean;
  /** sleap-nn subcommand. Defaults to `predict` (the current pipeline). */
  subcommand?: string;
}

/**
 * Build the full `sleap-nn <subcommand> ...` argv (excluding the `sleap-nn`
 * program token itself) for a local inference run. Order is significant and
 * mirrors the historical `track` invocation exactly.
 *
 * Throws on frame-range values that cannot be expressed as a single CLI call
 * (`"random"` needs per-video invocation) or that are missing a
 * caller-resolved value they depend on (`"frame"` needs `currentFrameIdx`,
 * `"random_video"` needs `sampledFrames`).
 */
export function buildInferenceArgs(
  config: InferenceConfig,
  opts: BuildInferenceArgsOptions
): string[] {
  const {
    dataPath,
    outputPath,
    sampledFrames,
    currentFrameIdx,
    suppressVideoIndex = false,
    subcommand = "predict",
  } = opts;

  const args = [subcommand, "--gui"];

  // Core I/O
  args.push("--data_path", dataPath);
  for (const mp of config.modelPaths) {
    args.push("--model_paths", mp);
  }
  args.push("--output_path", outputPath);

  // Data selection
  if (config.videoIndex !== "all" && !suppressVideoIndex) {
    args.push("--video_index", String(config.videoIndex));
  }

  // Frame range → CLI args (fail fast on unhandled types)
  if (typeof config.frameRange === "object") {
    args.push("--frames", `${config.frameRange.start}-${config.frameRange.end}`);
  } else {
    switch (config.frameRange) {
      case "user_labeled":
        args.push("--only_labeled_frames");
        break;
      case "suggestions":
        args.push("--only_suggested_frames");
        break;
      case "predicted":
        args.push("--only_predicted_frames");
        break;
      case "video":
      case "all_videos":
        break;
      case "frame": {
        if (currentFrameIdx == null) {
          throw new Error(
            "'frame' frame range requires the current frame index (opts.currentFrameIdx)."
          );
        }
        args.push("--frames", String(currentFrameIdx));
        break;
      }
      case "random_video": {
        if (!sampledFrames || sampledFrames.length === 0) {
          throw new Error(
            "random_video frame range requires pre-sampled frames (opts.sampledFrames)."
          );
        }
        args.push("--frames", sampledFrames.join(","));
        break;
      }
      case "random":
        // "random (all videos)" requires per-video invocation — handled by caller.
        throw new Error(
          "Random sampling across all videos requires per-video invocation. " +
          "Use 'random_video' for single-video random, or call runInference per video."
        );
      default:
        throw new Error(`Unhandled frame range type: ${config.frameRange}`);
    }
  }

  if (config.excludeUserLabeled) {
    args.push("--exclude_user_labeled");
  }

  // Inference settings
  args.push("--batch_size", String(config.batchSize));
  args.push("--device", config.device);
  // Runtime override for an exported ONNX/TensorRT model directory. Only the
  // `predict` subcommand accepts --runtime (the legacy `track` fallback has no
  // such flag), and "auto" is sleap-nn's own default, so emit only for a
  // non-auto predict run (mirrors the opt-in convention of the predict-only
  // filter flags below).
  if (subcommand === "predict" && config.runtime && config.runtime !== "auto") {
    args.push("--runtime", config.runtime);
  }
  if (config.maxInstances != null) {
    args.push("--max_instances", String(config.maxInstances));
  }
  args.push("--peak_threshold", String(config.peakThreshold));

  // Bottom-up advanced
  if (config.integralRefinement) {
    args.push("--integral_refinement", "integral");
    args.push("--integral_patch_size", String(config.integralPatchSize));
  }
  if (config.pipeline === "bottom-up" || config.pipeline === "bottom-up-id") {
    args.push("--n_points", String(config.nPoints));
    args.push("--max_edge_length_ratio", String(config.maxEdgeLengthRatio));
    args.push("--dist_penalty_weight", String(config.distPenaltyWeight));
    args.push("--min_line_scores", String(config.minLineScores));
  }

  // Preprocessing
  if (config.ensureChannels === "rgb") {
    args.push("--ensure_rgb");
  } else if (config.ensureChannels === "grayscale") {
    args.push("--ensure_grayscale");
  }

  // Tracking
  if (config.tracking) {
    args.push("--tracking");
    if (config.trackerMethod === "flow") {
      args.push("--use_flow");
      args.push("--of_img_scale", String(config.flowImgScale));
      args.push("--of_window_size", String(config.flowWindowSize));
      args.push("--of_max_levels", String(config.flowMaxLevels));
    } else if (config.trackerMethod === "kalman") {
      args.push("--use_kalman");
      args.push("--kf_track_features", config.kfTrackFeatures);
      args.push("--kf_init_frame_count", String(config.kfInitFrameCount));
      args.push("--kf_reset_gap_size", String(config.kfResetGapSize));
      if (config.kfNodeIndices.length > 0) {
        args.push("--kf_node_indices", config.kfNodeIndices.join(","));
      }
    }
    if (config.similarityMethod === "centroids") {
      args.push("--features", "centroids");
      args.push("--scoring_method", "euclidean_dist");
    } else {
      args.push("--scoring_method", config.similarityMethod);
    }
    args.push("--track_matching_method", config.matchingMethod);
    args.push("--tracking_window_size", String(config.trackingWindowSize));
    if (config.maxTracks != null) {
      args.push("--max_tracks", String(config.maxTracks));
    }
    args.push("--robust_best_instance", String(config.robust));
    if (config.connectSingleBreaks) {
      args.push("--post_connect_single_breaks");
    }
    args.push("--min_match_points", String(config.minMatchPoints));
    args.push("--min_new_track_points", String(config.minNewTrackPoints));
    args.push("--scoring_reduction", config.scoringReduction);
    if (config.trackingTargetInstanceCount != null) {
      args.push("--tracking_target_instance_count", String(config.trackingTargetInstanceCount));
    }
    if (config.trackingPreCullToTarget) {
      args.push("--tracking_pre_cull_to_target", "1");
      args.push("--tracking_pre_cull_iou_threshold", String(config.trackingPreCullIouThreshold));
    }
    if (config.trackingCleanInstanceCount != null) {
      args.push("--tracking_clean_instance_count", String(config.trackingCleanInstanceCount));
      args.push("--tracking_clean_iou_threshold", String(config.trackingCleanIouThreshold));
    }
  }

  // Post-processing
  if (config.filterOverlapping) {
    args.push("--filter_overlapping");
    args.push("--filter_overlapping_method", config.filterMethod);
    args.push("--filter_overlapping_threshold", String(config.filterThreshold));
  }
  if (config.filterMinVisibleNodes != null) {
    args.push("--filter_min_visible_nodes", String(config.filterMinVisibleNodes));
  }
  if (config.filterMinVisibleNodeFraction != null) {
    args.push("--filter_min_visible_node_fraction", String(config.filterMinVisibleNodeFraction));
  }
  if (config.filterMinMeanNodeScore != null) {
    args.push("--filter_min_mean_node_score", String(config.filterMinMeanNodeScore));
  }
  if (config.filterMinInstanceScore != null) {
    args.push("--filter_min_instance_score", String(config.filterMinInstanceScore));
  }
  if (config.filterMinCentroidDistance != null) {
    // predict-only flag (not present in legacy sleap-nn `track`'s flag set) —
    // only emitted when the user explicitly opts in, so old-version `track`
    // fallback runs that never set this are unaffected.
    args.push("--filter_min_centroid_distance", String(config.filterMinCentroidDistance));
  }

  return args;
}

/** Compare dotted numeric version cores (e.g. "0.2.0"). Returns -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the installed sleap-nn supports the `predict` subcommand. An
 * unknown/unparseable version returns `true` (don't block on uncertainty — a
 * doomed run will still surface a clear CLI error). A parseable version below
 * {@link MIN_SLEAP_NN_PREDICT_VERSION} returns `false`.
 */
export function isPredictSupported(
  version: string | null | undefined,
  min: string = MIN_SLEAP_NN_PREDICT_VERSION
): boolean {
  if (!version) return true;
  const core = version.trim().split(/[-+ ]/)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return true;
  return compareVersions(core, min) >= 0;
}

/**
 * Choose the sleap-nn inference subcommand for the installed version.
 *
 * Returns `predict` (the new Predictor pipeline) when it is available
 * ({@link isPredictSupported} — true for >= {@link MIN_SLEAP_NN_PREDICT_VERSION}
 * and for unknown/unparseable versions), otherwise the legacy `track` command,
 * which is present in *every* sleap-nn version. This is a graceful fallback, not
 * a block: users on older sleap-nn keep running inference via exactly the same
 * command the app used before the `predict` migration — no regression, no forced
 * upgrade.
 */
export function pickInferenceSubcommand(
  version: string | null | undefined
): "predict" | "track" {
  return isPredictSupported(version) ? "predict" : "track";
}
