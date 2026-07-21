/**
 * Merge prediction Labels into target Labels.
 *
 * Designed to integrate inference results (from sleap-nn) into a user's
 * current project. Intended for upstreaming to @talmolab/sleap-io.js.
 */

import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

export interface MergeOptions {
  frameStrategy?: "auto" | "replace_predictions";
  instanceMatchThreshold?: number; // default 5.0 (pixels)
}

export interface MergeResult {
  framesAdded: number;
  instancesAdded: number;
  instancesSkipped: number;
  conflicts: number;
  /** First-class centroid annotations (`frame.centroids`) carried over. */
  centroidsAdded: number;
}

/**
 * Compute the centroid of an instance from its visible points.
 * Returns null if no visible points with finite coordinates exist.
 */
export function centroid(
  instance: Instance | PredictedInstance
): [number, number] | null {
  const visible = instance.points.filter(
    (p) => p.visible && !isNaN(p.xy[0]) && !isNaN(p.xy[1])
  );
  if (visible.length === 0) return null;
  const x = visible.reduce((s, p) => s + p.xy[0], 0) / visible.length;
  const y = visible.reduce((s, p) => s + p.xy[1], 0) / visible.length;
  return [x, y];
}

/**
 * Compute the Euclidean distance between the centroids of two instances.
 * Returns Infinity if either instance has no visible points.
 */
export function centroidDistance(
  a: Instance | PredictedInstance,
  b: Instance | PredictedInstance
): number {
  const ca = centroid(a);
  const cb = centroid(b);
  if (!ca || !cb) return Infinity;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}

/**
 * Find the index of the best spatial match for `instance` among `candidates`.
 * Returns -1 if no candidate is within `threshold` pixels.
 *
 * The match is strict-less-than: dist < threshold (not <=).
 */
function findBestMatch(
  instance: Instance | PredictedInstance,
  candidates: Array<Instance | PredictedInstance>,
  threshold: number
): number {
  let bestIdx = -1;
  let bestDist = threshold;
  for (let i = 0; i < candidates.length; i++) {
    const dist = centroidDistance(instance, candidates[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Merge `source` Labels into `target` Labels (in-place).
 *
 * Steps:
 *  1. Match/add skeletons
 *  2. Match/add videos
 *  3. Match/add tracks
 *  4. Merge labeled frames
 *
 * @returns MergeResult with counts of what was added/skipped/conflicted.
 */
export function merge(
  target: Labels,
  source: Labels,
  options: MergeOptions = {}
): MergeResult {
  const strategy = options.frameStrategy ?? "auto";
  const threshold = options.instanceMatchThreshold ?? 5.0;

  const result: MergeResult = {
    framesAdded: 0,
    instancesAdded: 0,
    instancesSkipped: 0,
    conflicts: 0,
    centroidsAdded: 0,
  };

  // -------------------------------------------------------------------------
  // Step 1: Match skeletons
  // -------------------------------------------------------------------------
  const skeletonMap = new Map<Skeleton, Skeleton>();
  for (const sourceSkel of source.skeletons) {
    const match = target.skeletons.find((t) => t.matches(sourceSkel));
    if (match) {
      skeletonMap.set(sourceSkel, match);
    } else {
      target.skeletons.push(sourceSkel);
      skeletonMap.set(sourceSkel, sourceSkel);
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Match videos
  // -------------------------------------------------------------------------
  const videoMap = new Map<Video, Video>();
  for (const sourceVideo of source.videos) {
    const match = target.videos.find((t) =>
      sourceVideo.matchesPath(t, false /* basename comparison */)
    );
    if (match) {
      videoMap.set(sourceVideo, match);
    } else {
      target.videos.push(sourceVideo);
      videoMap.set(sourceVideo, sourceVideo);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Match tracks
  // -------------------------------------------------------------------------
  const trackMap = new Map<Track, Track>();
  for (const sourceTrack of source.tracks) {
    const match = target.tracks.find((t) => t.name === sourceTrack.name);
    if (match) {
      trackMap.set(sourceTrack, match);
    } else {
      target.tracks.push(sourceTrack);
      trackMap.set(sourceTrack, sourceTrack);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Merge labeled frames
  // -------------------------------------------------------------------------
  for (const sourceFrame of source.labeledFrames) {
    // Remap video
    const targetVideo = videoMap.get(sourceFrame.video) ?? sourceFrame.video;

    // Remap instances (skeleton + track)
    const remappedInstances = sourceFrame.instances.map((inst) => {
      const remappedSkeleton =
        skeletonMap.get(inst.skeleton) ?? inst.skeleton;
      const remappedTrack = inst.track
        ? (trackMap.get(inst.track) ?? inst.track)
        : inst.track;

      // Mutate in place (sleap-io.js objects are plain mutable classes)
      inst.skeleton = remappedSkeleton;
      inst.track = remappedTrack;
      return inst;
    });

    // Remap first-class centroid annotations (`frame.centroids`). Centroid-only
    // model output (e.g. the AL locator, `--centroid_output centroid`) writes
    // these with no instances, so without carrying them across the merge would
    // silently drop every predicted centroid. Only `track` needs remapping; the
    // `instance` back-link (if any) points into `source` and is re-established
    // app-side by the pairing step, so it is left untouched (null for
    // centroid-only predictions).
    const remappedCentroids = sourceFrame.centroids.map((c) => {
      if (c.track) c.track = trackMap.get(c.track) ?? c.track;
      return c;
    });

    // Find existing frame in target
    const existingFrames = target.find({
      video: targetVideo,
      frameIdx: sourceFrame.frameIdx,
    });

    if (existingFrames.length === 0) {
      // No match: create new LabeledFrame and append
      const newFrame = new LabeledFrame({
        video: targetVideo,
        frameIdx: sourceFrame.frameIdx,
        instances: remappedInstances,
      });
      if (remappedCentroids.length > 0) newFrame.centroids = remappedCentroids;
      target.append(newFrame);
      result.framesAdded++;
      result.instancesAdded += remappedInstances.length;
      result.centroidsAdded += remappedCentroids.length;
    } else {
      // Match exists: merge instances using the chosen strategy
      const targetFrame = existingFrames[0];

      if (strategy === "replace_predictions") {
        // Keep user instances from target, replace all predictions with source
        const sourcePredictions = remappedInstances.filter(
          (inst) => inst instanceof PredictedInstance
        );
        const userInstances = targetFrame.instances.filter(isUserInstance);
        targetFrame.instances = [...userInstances, ...sourcePredictions];
        result.instancesAdded += sourcePredictions.length;
      } else {
        // "auto" strategy
        mergeFrameAuto(
          targetFrame,
          remappedInstances,
          threshold,
          result
        );
      }

      // Merge centroids independently of the instance strategy: keep the user's
      // own centroids and replace any previously-predicted ones with the source
      // set, so re-running the locator refreshes rather than accumulates.
      if (remappedCentroids.length > 0) {
        const userCentroids = targetFrame.centroids.filter((c) => !c.isPredicted);
        targetFrame.centroids = [...userCentroids, ...remappedCentroids];
        result.centroidsAdded += remappedCentroids.length;
      }
    }
  }

  return result;
}

/**
 * Return true if the instance is a user-labeled instance (not a prediction).
 *
 * Note: `LabeledFrame.userInstances` in sleap-io.js v0.2.x is buggy — it uses
 * `instanceof Instance` which also matches PredictedInstance (since PredictedInstance
 * extends Instance). We use the negative check instead.
 */
function isUserInstance(inst: Instance | PredictedInstance): boolean {
  return !(inst instanceof PredictedInstance);
}

/**
 * Apply the "auto" merge strategy to a single target frame.
 *
 * Algorithm:
 * 1. Start with merged = [...userInstances from targetFrame]
 * 2. Track matchedTargetIndices
 * 3. For each incoming instance:
 *    - Find best spatial match among ALL current target instances
 *    - If matched to user instance → skip (user wins), count conflict
 *    - If matched to prediction → replace with incoming (newer wins)
 *    - If no match → add incoming to merged
 * 4. Add unmatched target predictions (not in matchedTargetIndices)
 * 5. Set targetFrame.instances = merged
 */
function mergeFrameAuto(
  targetFrame: LabeledFrame,
  incoming: Array<Instance | PredictedInstance>,
  threshold: number,
  result: MergeResult
): void {
  const targetInstances = targetFrame.instances;
  const matchedTargetIndices = new Set<number>();

  // merged starts with all user instances from target (excluding predictions)
  const merged: Array<Instance | PredictedInstance> = targetInstances.filter(
    isUserInstance
  );

  for (const inst of incoming) {
    const bestIdx = findBestMatch(inst, targetInstances, threshold);

    if (bestIdx === -1) {
      // No spatial match → add the incoming instance
      merged.push(inst);
      result.instancesAdded++;
    } else {
      const matched = targetInstances[bestIdx];
      matchedTargetIndices.add(bestIdx);

      if (matched instanceof PredictedInstance) {
        // Matched a prediction → newer prediction wins; replace it
        merged.push(inst);
        result.instancesAdded++;
      } else {
        // Matched a user instance → user wins; skip incoming prediction
        result.instancesSkipped++;
        result.conflicts++;
      }
    }
  }

  // Add target predictions that were not matched by any incoming instance
  for (let i = 0; i < targetInstances.length; i++) {
    if (
      !matchedTargetIndices.has(i) &&
      targetInstances[i] instanceof PredictedInstance
    ) {
      merged.push(targetInstances[i]);
    }
  }

  targetFrame.instances = merged;
}
