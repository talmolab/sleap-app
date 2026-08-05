/**
 * Instance placement algorithms for initializing new instance node positions.
 *
 * Ports the six placement methods from SLEAP's PyQt GUI:
 * best, template, force_directed, random, prior_frame, prediction.
 */

import { Instance, PredictedInstance } from "@talmolab/sleap-io.js";
import type { Labels, Skeleton, Video, LabeledFrame, InstancePlacementMethod } from "../types";

/** Default frame dimensions when video shape is unknown. */
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;

/** Get frame width/height from video shape or use defaults. */
function getFrameDims(video: Video | null): [number, number] {
  if (video?.shape) {
    const w = video.shape[2] ?? DEFAULT_WIDTH;
    const h = video.shape[1] ?? DEFAULT_HEIGHT;
    return [w, h];
  }
  return [DEFAULT_WIDTH, DEFAULT_HEIGHT];
}

/** Compute the centroid of an instance's placed (non-NaN) points. */
function computeCentroid(inst: Instance): [number, number] | null {
  const placed = inst.points.filter(
    (p) => !isNaN(p.xy[0]) && !isNaN(p.xy[1])
  );
  if (placed.length === 0) return null;
  const cx = placed.reduce((s, p) => s + p.xy[0], 0) / placed.length;
  const cy = placed.reduce((s, p) => s + p.xy[1], 0) / placed.length;
  return [cx, cy];
}

/** Check if an instance has any placed (non-NaN) points. */
function hasPlacedPoints(inst: Instance): boolean {
  return inst.points.some((p) => !isNaN(p.xy[0]) && !isNaN(p.xy[1]));
}

/**
 * Place instance at center with small per-node spread.
 * Returns the instance with points set.
 */
function placeAtCenter(
  instance: Instance,
  width: number,
  height: number
): Instance {
  const cx = width / 2;
  const cy = height / 2;
  const nodeCount = instance.points.length;

  for (let i = 0; i < nodeCount; i++) {
    // Spread nodes in a small circle around center
    const angle = (2 * Math.PI * i) / Math.max(nodeCount, 1);
    const radius = Math.min(width, height) * 0.05;
    instance.points[i].xy = [
      cx + radius * Math.cos(angle),
      cy + radius * Math.sin(angle),
    ];
    instance.points[i].visible = true;
    instance.points[i].complete = true;
  }
  return instance;
}

/**
 * Offset an instance so its centroid moves away from existing instance centroids.
 * Finds the direction that maximizes distance from existing centroids and
 * shifts the instance by 50px in that direction.
 */
function offsetFromExisting(
  instance: Instance,
  existingInstances: Instance[]
): Instance {
  const centroids = existingInstances
    .map(computeCentroid)
    .filter((c): c is [number, number] => c !== null);

  if (centroids.length === 0) return instance;

  const myCentroid = computeCentroid(instance);
  if (!myCentroid) return instance;

  // Try 8 directions, pick the one that maximizes minimum distance to existing centroids
  let bestDx = 0;
  let bestDy = 0;
  let bestMinDist = -Infinity;

  for (let a = 0; a < 8; a++) {
    const angle = (2 * Math.PI * a) / 8;
    const dx = 50 * Math.cos(angle);
    const dy = 50 * Math.sin(angle);
    const newCx = myCentroid[0] + dx;
    const newCy = myCentroid[1] + dy;

    let minDist = Infinity;
    for (const c of centroids) {
      const dist = Math.hypot(newCx - c[0], newCy - c[1]);
      minDist = Math.min(minDist, dist);
    }

    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      bestDx = dx;
      bestDy = dy;
    }
  }

  // Apply offset to all points
  for (const point of instance.points) {
    if (!isNaN(point.xy[0]) && !isNaN(point.xy[1])) {
      point.xy = [point.xy[0] + bestDx, point.xy[1] + bestDy];
    }
  }

  return instance;
}

/** "best" — centered template offset to avoid overlapping existing instances. */
function placeBest(
  skeleton: Skeleton,
  video: Video | null,
  existingInstances: Instance[]
): Instance {
  const [width, height] = getFrameDims(video);
  const instance = Instance.empty({ skeleton });
  placeAtCenter(instance, width, height);
  offsetFromExisting(instance, existingInstances);
  return instance;
}

/** "template" — center all points at frame center with small index-based spread. */
function placeTemplate(skeleton: Skeleton, video: Video | null): Instance {
  const [width, height] = getFrameDims(video);
  const instance = Instance.empty({ skeleton });
  placeAtCenter(instance, width, height);
  return instance;
}

/** "force_directed" — center + iterative repulsion from existing instances. */
function placeForceDirected(
  skeleton: Skeleton,
  video: Video | null,
  existingInstances: Instance[]
): Instance {
  const [width, height] = getFrameDims(video);
  const instance = Instance.empty({ skeleton });
  placeAtCenter(instance, width, height);

  const centroids = existingInstances
    .map(computeCentroid)
    .filter((c): c is [number, number] => c !== null);

  if (centroids.length === 0) return instance;

  // Run 5 iterations of repulsive force simulation
  for (let iter = 0; iter < 5; iter++) {
    const myCentroid = computeCentroid(instance);
    if (!myCentroid) break;

    let fx = 0;
    let fy = 0;

    for (const c of centroids) {
      const dx = myCentroid[0] - c[0];
      const dy = myCentroid[1] - c[1];
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        // Nearly overlapping — push in a consistent direction
        fx += 50;
        fy += 50;
      } else {
        // Repulsive force inversely proportional to distance
        const force = 5000 / (dist * dist);
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
    }

    // Apply force as displacement to all points
    for (const point of instance.points) {
      if (!isNaN(point.xy[0]) && !isNaN(point.xy[1])) {
        point.xy = [point.xy[0] + fx, point.xy[1] + fy];
      }
    }
  }

  return instance;
}

/**
 * "random" — each node gets its own independent random position within the
 * currently-visible portion of the frame (falling back to the full frame if
 * the viewport isn't known yet, e.g. before the canvas has real dimensions).
 * Ports PyQt SLEAP's `AddMissingInstanceNodes.get_xy_in_rect`, called once per
 * node against `QtVideoPlayer.getVisibleRect()` -- nodes land scattered across
 * the visible view, not clustered around one shared point, and can't end up
 * off-screen when zoomed into part of a larger frame.
 */
function placeRandom(
  skeleton: Skeleton,
  video: Video | null,
  visibleRect: [number, number, number, number] | null
): Instance {
  const instance = Instance.empty({ skeleton });

  let x1: number, y1: number, w: number, h: number;
  if (visibleRect) {
    [x1, y1] = visibleRect;
    w = visibleRect[2] - visibleRect[0];
    h = visibleRect[3] - visibleRect[1];
  } else {
    const [width, height] = getFrameDims(video);
    x1 = 0;
    y1 = 0;
    w = width;
    h = height;
  }

  for (let i = 0; i < instance.points.length; i++) {
    // Matches get_xy_in_rect: uniform within an inset 80%-of-rect box.
    instance.points[i].xy = [
      x1 + w * 0.1 + Math.random() * w * 0.8,
      y1 + h * 0.1 + Math.random() * h * 0.8,
    ];
    instance.points[i].visible = true;
    instance.points[i].complete = true;
  }

  return instance;
}

/** "prior_frame" — copy points from same-track instance on the previous frame. */
function placePriorFrame(
  skeleton: Skeleton,
  video: Video | null,
  existingInstances: Instance[],
  priorFrame: LabeledFrame | null
): Instance {
  if (priorFrame && priorFrame.instances.length > 0) {
    const userInstances = priorFrame.instances.filter(
      (inst) => !(inst instanceof PredictedInstance) && hasPlacedPoints(inst)
    );
    const candidates = userInstances.length > 0
      ? userInstances
      : priorFrame.instances.filter((inst) => hasPlacedPoints(inst));

    if (candidates.length > 0) {
      const usedTracks = new Set(
        existingInstances
          .filter((inst) => inst.track !== null)
          .map((inst) => inst.track)
      );

      const source = candidates.find(
        (inst) => !inst.track || !usedTracks.has(inst.track)
      ) ?? candidates[0];

      const instance = Instance.empty({ skeleton });
      for (let i = 0; i < instance.points.length && i < source.points.length; i++) {
        instance.points[i].xy = [source.points[i].xy[0], source.points[i].xy[1]];
        instance.points[i].visible = source.points[i].visible;
        instance.points[i].complete = source.points[i].complete;
      }
      if (source.track) instance.track = source.track;
      return instance;
    }
  }

  // Fall back to "best"
  return placeBest(skeleton, video, existingInstances);
}

/** "prediction" — copy from an unmatched predicted instance on the current frame. */
function placePrediction(
  skeleton: Skeleton,
  video: Video | null,
  existingInstances: Instance[]
): Instance {
  // Find predicted instances that don't have a corresponding user instance
  const predicted = existingInstances.filter(
    (inst) => inst instanceof PredictedInstance && hasPlacedPoints(inst)
  );
  const userInstances = existingInstances.filter(
    (inst) => !(inst instanceof PredictedInstance)
  );

  // Find a predicted instance whose track doesn't already have a user instance
  let source: Instance | undefined;
  for (const pred of predicted) {
    if (pred.track) {
      const hasUserWithTrack = userInstances.some(
        (u) => u.track === pred.track
      );
      if (!hasUserWithTrack) {
        source = pred;
        break;
      }
    } else {
      // No track — use first unmatched prediction
      source = pred;
      break;
    }
  }

  if (source) {
    const instance = Instance.empty({ skeleton });
    for (let i = 0; i < instance.points.length && i < source.points.length; i++) {
      instance.points[i].xy = [source.points[i].xy[0], source.points[i].xy[1]];
      instance.points[i].visible = source.points[i].visible;
      instance.points[i].complete = source.points[i].complete;
    }
    // Copy track from the prediction
    if (source.track) {
      instance.track = source.track;
    }
    return instance;
  }

  // Fall back to "best"
  return placeBest(skeleton, video, existingInstances);
}

/**
 * Create and place a new instance using the specified placement method.
 *
 * @param method - Placement algorithm to use
 * @param skeleton - Skeleton for the new instance
 * @param video - Current video (used for frame dimensions)
 * @param existingInstances - Instances already on the current frame
 * @param priorFrame - The labeled frame from frameIdx-1 (for prior_frame method)
 * @returns A new Instance with points positioned according to the method
 */
/**
 * Give any NaN-coordinate ("undetected") points in a converted-from-prediction
 * Instance a random position near the instance's own detected keypoints,
 * marked not-visible. A model leaves occluded/undetected keypoints at NaN;
 * left as NaN, the renderer can't draw anything there at all -- not even the
 * hollow "invisible node" marker it uses for genuinely non-visible points --
 * so the point silently disappears instead of showing up as an invisible
 * (but draggable) marker.
 *
 * Anchored on this instance's own detected-point centroid/extent (a
 * uniform-random point within that radius) rather than a full force-directed
 * skeleton layout, but for the same reason PyQt SLEAP does: so missing nodes
 * land on the animal instead of somewhere unrelated in the frame. Ports the
 * centroid/extent anchoring from `AddUserInstancesFromPredictions
 * .fill_missing_predicted_nodes` (see ../sleap/sleap/gui/commands.py) without
 * porting its networkx spring-layout step. No-op if every node is detected,
 * or if none are (no anchor to place around). Detected points, track, and
 * fromPredicted are left untouched.
 */
export function fillMissingPredictedNodes(instance: Instance): void {
  const missing: number[] = [];
  const detected: [number, number][] = [];
  instance.points.forEach((p, i) => {
    if (isNaN(p.xy[0]) || isNaN(p.xy[1])) missing.push(i);
    else detected.push(p.xy);
  });
  if (missing.length === 0 || detected.length === 0) return;

  const cx = detected.reduce((s, p) => s + p[0], 0) / detected.length;
  const cy = detected.reduce((s, p) => s + p[1], 0) / detected.length;
  const xs = detected.map((p) => p[0]);
  const ys = detected.map((p) => p[1]);
  const extent = Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys)
  );
  const scale = Math.max(extent / 2, 5);

  for (const idx of missing) {
    const angle = Math.random() * 2 * Math.PI;
    const r = Math.random() * scale;
    instance.points[idx].xy = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    instance.points[idx].visible = false;
    instance.points[idx].complete = false;
  }
}

/** Find the nearest labeled frame before `frameIdx` for the given video. */
export function findNearestPriorFrame(
  labels: Labels,
  video: Video,
  frameIdx: number
): LabeledFrame | null {
  if (frameIdx <= 0) return null;
  let best: LabeledFrame | null = null;
  let bestIdx = -1;
  for (const lf of labels.labeledFrames) {
    if (lf.video === video && lf.frameIdx < frameIdx && lf.frameIdx > bestIdx) {
      bestIdx = lf.frameIdx;
      best = lf;
    }
  }
  return best;
}

export function placeInstance(
  method: InstancePlacementMethod,
  skeleton: Skeleton,
  video: Video | null,
  existingInstances: Instance[],
  priorFrame: LabeledFrame | null,
  visibleRect: [number, number, number, number] | null = null
): Instance {
  switch (method) {
    case "best":
      return placeBest(skeleton, video, existingInstances);
    case "template":
      return placeTemplate(skeleton, video);
    case "force_directed":
      return placeForceDirected(skeleton, video, existingInstances);
    case "random":
      return placeRandom(skeleton, video, visibleRect);
    case "prior_frame":
      return placePriorFrame(skeleton, video, existingInstances, priorFrame);
    case "prediction":
      return placePrediction(skeleton, video, existingInstances);
    default:
      return placeBest(skeleton, video, existingInstances);
  }
}
