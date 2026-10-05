/**
 * Merge compatibility check for a worker-file inference job's predictions
 * (design §6) — "Fetch & Load" on a job that isn't obviously the open
 * project's own run needs to know, BEFORE merging anything, how well the
 * predictions actually line up: same file (skip the check entirely), partial
 * video overlap, or an incompatible skeleton. Pure: everything it needs
 * (the two `Labels`, the path rules) is handed in by the caller
 * (`MergePredictionsDialog`, PR5b).
 */
import { Labels, posixBasename, type Video } from "@talmolab/sleap-io.js";
import { translatePath, type PathMapping } from "@/lib/pathMappings";

export interface MergeCompat {
  /** The open project's path maps (via `ctx.rules`) to the job's own worker labels path — the exact file the job ran against, so every video and the skeleton are trivially compatible. */
  sameFile: boolean;
  skeletonOk: boolean;
  skeletonDetail: string;
  videos: { name: string; matched: boolean }[];
  matchedCount: number;
  total: number;
}

/** The display name for one of `predictions`'s videos — its first filename's basename (mirrors `workerLabels.ts`'s `WorkerFileVideoCheck` for a multi-file `ImageVideo`). */
function videoDisplayName(video: Video): string {
  const filename = Array.isArray(video.filename) ? video.filename[0] : video.filename;
  return posixBasename(filename);
}

/**
 * Checks whether `predictions` (a completed worker-file track job's result)
 * can be merged into `project`, predicting the real merge rather than just
 * guessing: `project.match(predictions, ...)` uses the exact same matchers
 * `MergePredictions` merges with (`editCommands.ts`'s `video: "basename"`,
 * `track: "name"`, default/STRUCTURE skeleton) — if this says a video or the
 * skeleton won't match, merging for real wouldn't either.
 *
 * The `sameFile` fast path (the open project's path maps, via `ctx.rules`,
 * to the exact worker path the job ran against) skips matching entirely:
 * every video and the skeleton are necessarily the project's own.
 *
 * `project: null` (no project open) always reports full incompatibility
 * (`skeletonOk: false`, nothing matched) — there's nothing to merge into,
 * only "Open predictions"/"Download" make sense (PR5b's
 * `MergePredictionsDialog`).
 */
export async function checkMergeCompat(
  project: Labels | null,
  predictions: Labels,
  ctx: { projectPath: string | null; jobLabelsPath: string | null; rules: PathMapping[] },
): Promise<MergeCompat> {
  const sameFile =
    ctx.projectPath !== null &&
    ctx.jobLabelsPath !== null &&
    translatePath(ctx.projectPath, ctx.rules) === ctx.jobLabelsPath;

  if (!project) {
    return {
      sameFile,
      skeletonOk: false,
      skeletonDetail: "No project open",
      videos: predictions.videos.map((v) => ({ name: videoDisplayName(v), matched: false })),
      matchedCount: 0,
      total: predictions.videos.length,
    };
  }

  if (sameFile) {
    return {
      sameFile: true,
      skeletonOk: true,
      skeletonDetail: "Same file the job ran against",
      videos: predictions.videos.map((v) => ({ name: videoDisplayName(v), matched: true })),
      matchedCount: predictions.videos.length,
      total: predictions.videos.length,
    };
  }

  const result = await project.match(predictions, { video: "basename", track: "name" });
  const skeletonOk = result.allSkeletonsMatched;
  const predictionsNodeCount = predictions.skeletons[0]?.nodes.length ?? 0;
  const projectNodeCount = project.skeletons[0]?.nodes.length ?? 0;

  const videos = predictions.videos.map((v) => ({
    name: videoDisplayName(v),
    matched: result.videoMap.get(v) != null,
  }));

  return {
    sameFile: false,
    skeletonOk,
    skeletonDetail: skeletonOk
      ? "Skeleton matches"
      : `Skeleton doesn't match the open project (${predictionsNodeCount} vs ${projectNodeCount} node(s))`,
    videos,
    matchedCount: videos.filter((v) => v.matched).length,
    total: videos.length,
  };
}

/**
 * Keeps only the frames (and their videos) of `predictions` whose video
 * matches one of `project`'s, by the same basename comparison
 * `checkMergeCompat`/`MergePredictions` use (`Video.matchesPath(other,
 * false)` — sleap-io.js's own `BASENAME_VIDEO_MATCHER` primitive, so this
 * never has to re-run the async `Labels.match` just to answer "is this one
 * video matched"). Backs "Merge matching" in `MergePredictionsDialog`
 * (PR5b) when only some videos are visible on the worker.
 */
export function filterPredictionsToMatchedVideos(predictions: Labels, project: Labels): Labels {
  const matchedVideos = predictions.videos.filter((pv) =>
    project.videos.some((ov) => ov.matchesPath(pv, false)),
  );
  const matchedSet = new Set(matchedVideos);
  return new Labels({
    videos: matchedVideos,
    skeletons: predictions.skeletons,
    tracks: predictions.tracks,
    labeledFrames: predictions.labeledFrames.filter((lf) => matchedSet.has(lf.video)),
  });
}

/**
 * Worker-path -> local-path mirror of `translatePath` (which only goes
 * local -> worker) — longest-prefix match against each rule's `.worker`
 * side instead of its `.local` side. Used to map a predictions video's
 * worker-side path back to something openable locally when the user picks
 * "Open predictions" (PR5b's `MergePredictionsDialog`) on a worker-file job.
 */
export function translatePathToLocal(workerPath: string, rules: PathMapping[]): string | null {
  if (rules.length === 0) return null;

  let bestMatch: PathMapping | null = null;
  let bestLen = 0;

  for (const rule of rules) {
    const prefix = rule.worker.replace(/\/+$/, "");
    if (workerPath.startsWith(prefix)) {
      const nextChar = workerPath[prefix.length];
      if (nextChar === undefined || nextChar === "/") {
        if (prefix.length > bestLen) {
          bestLen = prefix.length;
          bestMatch = rule;
        }
      }
    }
  }

  if (!bestMatch) return null;

  const normalizedWorker = bestMatch.worker.replace(/\/+$/, "");
  const normalizedLocal = bestMatch.local.replace(/\/+$/, "");
  const suffix = workerPath.slice(normalizedWorker.length);
  return normalizedLocal + suffix;
}
