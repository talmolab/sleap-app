/**
 * The "Post-Training Inference Target" choices shared by the Training panel
 * and the Training Configuration dialog, and how a choice turns into the
 * frames/video an inference run covers.
 *
 * Mirrors PyQt SLEAP's frame target selector (`sleap/gui/learning/dialog.py`,
 * `_update_frame_target_selector`), which offers "Current frame" and
 * "Selected clip" in addition to the whole-video/sample/filter targets.
 */
import type { Labels, Video } from "@talmolab/sleap-io.js";
import type { InferenceConfig } from "@/stores/inferenceStore";

export interface PostTrainingTargetOption {
  value: string;
  label: string;
}

/** Every target, in the order the dropdowns list them. */
export const POST_TRAINING_TARGET_OPTIONS: readonly PostTrainingTargetOption[] = [
  { value: "nothing", label: "Nothing (skip inference)" },
  { value: "frame", label: "Current frame" },
  { value: "clip", label: "Selected clip" },
  { value: "suggestions", label: "Suggested frames" },
  { value: "user_labeled", label: "User labeled frames" },
  { value: "predicted", label: "Frames with predictions" },
  { value: "video", label: "Entire current video" },
  { value: "all_videos", label: "All videos" },
  { value: "random_video", label: "Random sample (current video)" },
  { value: "random", label: "Random sample (all videos)" },
];

/** Targets that only make sense with a project open in this window. */
const CURRENT_VIDEO_TARGETS = new Set(["frame", "clip", "video", "random_video"]);

/** The timeline selection as [first, last] (0-based, inclusive), sorted; `null` when nothing is selected. */
export function normalizeClip(
  frameRange: readonly [number, number] | null | undefined,
): { start: number; end: number } | null {
  if (!frameRange) return null;
  const a = Math.max(0, Math.floor(frameRange[0]));
  const b = Math.max(0, Math.floor(frameRange[1]));
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export interface ResolvedPostTrainingTarget {
  frameRange: InferenceConfig["frameRange"];
  videoIndex: number | "all";
}

/**
 * Turn a target choice into the `frameRange` + `videoIndex` of an
 * `InferenceConfig`, reading the current video and timeline selection at
 * the moment training finishes (like PyQt, which reads them when the job is
 * built). "Selected clip" becomes an explicit frame range on the current
 * video; "Current frame" stays `"frame"` (the runner reads the frame index
 * itself) but is pinned to the current video.
 *
 * Returns `{ skip }` with a reason when the target can't run — e.g.
 * "Selected clip" with nothing selected on the timeline.
 */
export function resolvePostTrainingTarget(
  target: string,
  state: {
    labels: Labels | null;
    video: Video | null;
    frameRange: readonly [number, number] | null;
  },
): ResolvedPostTrainingTarget | { skip: string } {
  const currentVideoIndex =
    state.labels && state.video ? Math.max(0, state.labels.videos.indexOf(state.video)) : 0;

  if (target === "clip") {
    const clip = normalizeClip(state.frameRange);
    if (!clip) {
      return {
        skip: "No clip is selected on the timeline, so post-training inference on the selected clip was skipped.",
      };
    }
    return { frameRange: clip, videoIndex: currentVideoIndex };
  }

  return {
    frameRange: target as InferenceConfig["frameRange"],
    videoIndex: CURRENT_VIDEO_TARGETS.has(target) ? currentVideoIndex : "all",
  };
}

/** Short description of a clip for the dropdown hint, e.g. "frames 10–19 (10 frames)". */
export function describeClip(frameRange: readonly [number, number] | null | undefined): string | null {
  const clip = normalizeClip(frameRange);
  if (!clip) return null;
  const n = clip.end - clip.start + 1;
  // 0-based, like the frame number in the status bar.
  return `frames ${clip.start}–${clip.end} (${n} frame${n === 1 ? "" : "s"})`;
}
