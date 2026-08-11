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
 * The `predict` command first appeared in 0.2.0 (renamed from `infer` in
 * talmolab/sleap-nn#607), BUT its save path was broken through 0.3.0:
 * `save_predictions` → sleap_io `Labels.save` crashed on `video.backend is None`
 * (`AttributeError`), so inference ran but never wrote an output file. That was
 * fixed in **0.3.1**. We therefore gate on the version where `predict` actually
 * works end-to-end — not where the command first existed. Installs below this
 * fall back to the legacy `track` command (present in every version), which
 * saves correctly, so no user is blocked.
 */
export const MIN_SLEAP_NN_PREDICT_VERSION = "0.3.1";

export interface BuildInferenceArgsOptions {
  /** Path to the input .slp (the project file or a serialized temp copy). */
  dataPath: string;
  /** Path the inference output .slp should be written to. */
  outputPath: string;
  /**
   * Pre-sampled frame indices for `frameRange === "random_video"`. The caller
   * resolves these (needs the app store + RNG); required for that range only.
   */
  sampledFrames?: number[];
  /** sleap-nn subcommand. Defaults to `predict` (the current pipeline). */
  subcommand?: string;
}

/**
 * Build the full `sleap-nn <subcommand> ...` argv (excluding the `sleap-nn`
 * program token itself) for a local inference run. Order is significant and
 * mirrors the historical `track` invocation exactly.
 *
 * Throws on frame-range values that cannot be expressed as a single CLI call
 * (`"random"` needs per-video invocation; `"frame"` is not a runnable range).
 */
export function buildInferenceArgs(
  config: InferenceConfig,
  opts: BuildInferenceArgsOptions
): string[] {
  const { dataPath, outputPath, sampledFrames, subcommand = "predict" } = opts;

  // A standalone centroid model can't run through `track` (that needs a paired
  // centered-instance model); it always runs via `sleap-nn predict
  // --centroid_output`, regardless of the version-picked subcommand. Track-only
  // flags (--gui, --tracking, bottom-up, --filter_overlapping, --max_instances,
  // --anchor_part) are guarded out below.
  const isCentroid = config.pipeline === "centroid";
  const args = isCentroid ? ["predict"] : [subcommand, "--gui"];

  // Core I/O (identical for predict + track; predict accepts a .slp data_path,
  // so frame filters like --only_suggested_frames still apply)
  args.push("--data_path", dataPath);
  for (const mp of config.modelPaths) {
    args.push("--model_paths", mp);
  }
  args.push("--output_path", outputPath);
  if (isCentroid) {
    args.push("--centroid_output", config.centroidOutput ?? "instance");
  }

  // Data selection
  if (config.videoIndex !== "all") {
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

  // Inference settings (batch/device/peak_threshold apply to predict too)
  args.push("--batch_size", String(config.batchSize));
  args.push("--device", config.device);
  if (!isCentroid && config.maxInstances != null) {
    args.push("--max_instances", String(config.maxInstances));
  }
  args.push("--peak_threshold", String(config.peakThreshold));
  if (!isCentroid && config.anchorPart) {
    args.push("--anchor_part", config.anchorPart);
  }

  // Bottom-up advanced (track-only; the centroid model outputs single points)
  if (!isCentroid && config.integralRefinement) {
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

  // Tracking (track-only)
  if (!isCentroid && config.tracking) {
    args.push("--tracking");
    if (config.trackerMethod === "flow") {
      args.push("--use_flow");
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
  }

  // Post-processing (track-only)
  if (!isCentroid && config.filterOverlapping) {
    args.push("--filter_overlapping");
    args.push("--filter_overlapping_method", config.filterMethod);
    args.push("--filter_overlapping_threshold", String(config.filterThreshold));
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
