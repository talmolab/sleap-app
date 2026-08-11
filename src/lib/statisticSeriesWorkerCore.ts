/**
 * Pure, array-only worker job runner for the heavy seekbar header statistic
 * graphs. Runs inside the Vite `?worker` (statisticSeries.worker.ts) but is
 * defined here, decoupled from the Worker runtime, so it can be unit-tested
 * directly (bun cannot host a Web Worker).
 *
 * Frame data arrives as plain structured-clone-safe arrays — NO sleap-io.js
 * objects — and the reduction math is REUSED from statisticSeriesCore.ts
 * (instanceVelocity, medianCentroid, minCentroidDistance,
 * primaryDisplacementFromMatrix). The semantics here MUST match the
 * main-thread facade in statisticSeries.ts:
 *  - min-centroid-proximity uses the MEDIAN centroid (medianCentroid), the
 *    SAME nanmedian get_centroid the main-thread path uses (HYBRID parity).
 *  - the displacement graphs apply the same NaN-propagation via
 *    instanceVelocity / primaryDisplacementFromMatrix.
 */
import {
  instanceVelocity,
  medianCentroid,
  minCentroidDistance,
  primaryDisplacementFromMatrix,
  type Reduction,
} from "./statisticSeriesCore";

/** The heavy graph types this worker covers. */
export type WorkerGraphType =
  | "point-displacement"
  | "primary-point-displacement"
  | "min-centroid-proximity";

/** Plain, structured-clone-safe instance: track index + [x, y] point rows. */
export interface WorkerInstance {
  /** Index into Labels.tracks, or -1 for an untracked instance. */
  trackIdx: number;
  /** Instance.numpy() rows: [x, y] per node (NaN for invisible coords). */
  points: number[][];
}

/** Plain, structured-clone-safe labeled frame. */
export interface WorkerFrame {
  frameIdx: number;
  instances: WorkerInstance[];
}

export interface WorkerRequest {
  graph: WorkerGraphType;
  reduction: Reduction;
  /** Number of tracks (Labels.tracks.length); needed by primary displacement. */
  trackCount: number;
  /** Anchor node index for primary-point-displacement. */
  primaryNodeIdx: number;
  /** Frames in ascending frameIdx order (caller guarantees the ordering). */
  frames: WorkerFrame[];
}

export interface WorkerResponse {
  /** [frameIdx, value] pairs, mirroring Map<number, number>.entries(). */
  entries: [number, number][];
}

/**
 * Min pairwise centroid distance per frame. Mirrors
 * statisticSeries.ts minCentroidProximitySeries: each centroid is the MEDIAN
 * centroid (medianCentroid); frames yielding <2 centroids (NaN) are skipped.
 */
function minCentroidProximity(frames: WorkerFrame[]): [number, number][] {
  const entries: [number, number][] = [];
  for (const lf of frames) {
    const centroids: Array<[number, number]> = [];
    for (const inst of lf.instances) {
      const c = medianCentroid(inst.points);
      if (c) centroids.push(c);
    }
    const val = minCentroidDistance(centroids);
    if (!Number.isNaN(val)) entries.push([lf.frameIdx, val]);
  }
  return entries;
}

/**
 * Point displacement per frame vs the previous labeled frame, matching
 * instances by track index. Mirrors statisticSeries.ts pointDisplacementSeries:
 * untracked instances (trackIdx < 0) are skipped, and a NaN per-instance
 * velocity (NaN-propagation under sum/max) contributes 0 to the frame total.
 */
function pointDisplacement(
  frames: WorkerFrame[],
  reduction: Reduction,
): [number, number][] {
  const entries: [number, number][] = [];
  let lastFrame: WorkerFrame | null = null;
  for (const lf of frames) {
    let val = 0;
    if (lastFrame) {
      for (const inst of lf.instances) {
        if (inst.trackIdx < 0) continue;
        const prev = lastFrame.instances.find(
          (o) => o.trackIdx === inst.trackIdx,
        );
        if (prev) {
          const d = instanceVelocity(inst.points, prev.points, reduction);
          if (!Number.isNaN(d)) val += d;
        }
      }
    }
    lastFrame = lf;
    if (!Number.isNaN(val)) entries.push([lf.frameIdx, val]);
  }
  return entries;
}

/**
 * Primary (single anchor node) displacement per frame, reduced across tracks.
 * Mirrors statisticSeries.ts primaryPointDisplacementSeries: builds a
 * per-frame, per-track anchor location matrix with carry-forward of the last
 * known position (and backfill on first sighting), then computes the shifted
 * displacement via primaryDisplacementFromMatrix.
 */
function primaryPointDisplacement(
  frames: WorkerFrame[],
  reduction: Reduction,
  trackCount: number,
  primaryNodeIdx: number,
): [number, number][] {
  const entries: [number, number][] = [];
  // Untracked data → all-zero displacement; return empty so nothing is drawn
  // (the renderer also skips all-zero). See statisticSeries.ts.
  if (trackCount === 0) return entries;

  let lastFrameIdx = 0;
  for (const lf of frames) if (lf.frameIdx > lastFrameIdx) lastFrameIdx = lf.frameIdx;

  const byFrame = new Map<number, WorkerFrame>();
  for (const lf of frames) byFrame.set(lf.frameIdx, lf);

  const loc: Array<Array<[number, number]>> = [];
  const lastPos: Array<[number, number]> = Array.from(
    { length: trackCount },
    () => [0, 0] as [number, number],
  );
  const seen = new Set<number>();

  for (let f = 0; f <= lastFrameIdx; f++) {
    const row: Array<[number, number]> = lastPos.map((p) => [p[0], p[1]]);
    const lf = byFrame.get(f);
    if (lf) {
      for (const inst of lf.instances) {
        const trackIdx = inst.trackIdx;
        if (trackIdx < 0 || trackIdx >= trackCount) continue;
        const point = inst.points[primaryNodeIdx];
        if (!point) continue;
        row[trackIdx] = [point[0], point[1]];
        if (!Number.isNaN(point[0]) && !Number.isNaN(point[1])) {
          lastPos[trackIdx] = [point[0], point[1]];
          if (!seen.has(trackIdx)) {
            for (let pf = 0; pf < f; pf++) loc[pf][trackIdx] = [point[0], point[1]];
            seen.add(trackIdx);
          }
        }
      }
    }
    loc.push(row);
  }

  const out = primaryDisplacementFromMatrix(loc, reduction);
  for (let f = 0; f < out.length; f++) {
    if (byFrame.has(f)) entries.push([f, out[f]]);
  }
  return entries;
}

/** Pure dispatch for the 3 heavy graphs. */
export function runWorkerJob(req: WorkerRequest): WorkerResponse {
  switch (req.graph) {
    case "min-centroid-proximity":
      return { entries: minCentroidProximity(req.frames) };
    case "point-displacement":
      return { entries: pointDisplacement(req.frames, req.reduction) };
    case "primary-point-displacement":
      return {
        entries: primaryPointDisplacement(
          req.frames,
          req.reduction,
          req.trackCount,
          req.primaryNodeIdx,
        ),
      };
  }
}
