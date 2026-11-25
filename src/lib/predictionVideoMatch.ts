import { VideoMatcher, type Labels, type Video } from "@talmolab/sleap-io.js";

/**
 * Which project video(s) an inference run predicted on: one video's index, or
 * `"project"` for a run on the project .slp, whose output keeps the project's
 * video order.
 */
export type PredictionVideoTarget = number | "project";

/** The target of a run with this `videoIndex` (a spec's `video_index`, or a config's). */
export function videoTargetOf(videoIndex: number | "all" | undefined): PredictionVideoTarget {
  return typeof videoIndex === "number" ? videoIndex : "project";
}

/**
 * Pair each prediction video with the project video it was predicted on, where
 * the run makes that knowable. A single-video run's one output video is its
 * target. A run on the project keeps the project's video order, so its videos
 * pair up by position, each pair checked by basename in case sleap-nn dropped
 * or reordered one.
 */
export function knownPredictionVideos(
  predictionVideos: readonly Video[],
  projectVideos: readonly Video[],
  target: PredictionVideoTarget,
): Map<Video, Video> {
  const known = new Map<Video, Video>();
  if (typeof target === "number" && predictionVideos.length === 1 && projectVideos[target]) {
    known.set(predictionVideos[0], projectVideos[target]);
  } else if (predictionVideos.length === projectVideos.length) {
    predictionVideos.forEach((v, i) => {
      if (v.matchesPath(projectVideos[i], false)) known.set(v, projectVideos[i]);
    });
  }
  return known;
}

/**
 * Video matcher for merging an inference run's output into the project.
 *
 * Plain basename matching exists because the output can name a video by another
 * absolute path (a worker's mount, a moved file), but it takes the first video
 * with that basename, so two project videos named `cam.mp4` in different folders
 * both merge onto the first. With a known target, each prediction video goes to
 * the project video it was predicted on, and an ambiguous basename prefers the
 * target video. Without one, this is plain basename matching.
 */
export function predictionVideoMatcher(
  predictions: Labels,
  project: Labels,
  target?: PredictionVideoTarget,
): VideoMatcher | "basename" {
  if (target === undefined) return "basename";
  const known = knownPredictionVideos(predictions.videos, project.videos, target);
  const preferred = typeof target === "number" ? (project.videos[target] ?? null) : null;

  const matcher = new VideoMatcher("basename");
  const byBasename = matcher.findMatch.bind(matcher);
  matcher.findMatch = async (incoming, candidates, opts) => {
    const mapped = known.get(incoming);
    if (mapped && candidates.includes(mapped)) return mapped;
    if (preferred && candidates.includes(preferred) && (await matcher.match(preferred, incoming))) {
      return preferred;
    }
    return byBasename(incoming, candidates, opts);
  };
  return matcher;
}
