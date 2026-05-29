/**
 * Seekbar header statistic series. Port of sleap/info/summary.py
 * StatisticSeries. Pure read-only functions over Labels/Video returning
 * Map<frameIdx, value>. Reduction is an explicit enum (NOT regex-parsed
 * from a menu label as in PyQt app.py:1611).
 *
 * Array-only math lives in ./statisticSeriesCore so it can be shared with
 * the Web Worker.
 */
import type { Labels, Video } from "@/types";
import type { Reduction } from "./statisticSeriesCore";

export type { Reduction } from "./statisticSeriesCore";

export type StatisticGraphType =
  | "none"
  | "instance-count"
  | "point-count"
  | "point-score"
  | "instance-score"
  | "point-displacement"
  | "primary-point-displacement"
  | "min-centroid-proximity"
  | "tracking-score";

export interface GraphSpec {
  type: StatisticGraphType;
  label: string;
  reductions: Reduction[]; // [] => no reduction selector
  defaultReduction: Reduction;
  heavy: boolean;          // gate behind worker threshold
}

export const GRAPH_SPECS: GraphSpec[] = [
  { type: "none", label: "None", reductions: [], defaultReduction: "sum", heavy: false },
  { type: "instance-count", label: "Instance Count", reductions: [], defaultReduction: "sum", heavy: false },
  { type: "point-count", label: "Point Count", reductions: [], defaultReduction: "sum", heavy: false },
  { type: "point-score", label: "Point Score", reductions: ["sum", "min"], defaultReduction: "sum", heavy: false },
  { type: "instance-score", label: "Instance Score", reductions: ["sum", "min"], defaultReduction: "sum", heavy: false },
  { type: "point-displacement", label: "Point Displacement", reductions: ["sum", "max", "mean"], defaultReduction: "sum", heavy: true },
  { type: "primary-point-displacement", label: "Primary Point Displacement", reductions: ["sum", "max", "mean"], defaultReduction: "sum", heavy: true },
  { type: "min-centroid-proximity", label: "Min Centroid Proximity", reductions: [], defaultReduction: "sum", heavy: true },
  { type: "tracking-score", label: "Tracking Score", reductions: ["mean", "min"], defaultReduction: "min", heavy: false },
];

export function getGraphSpec(type: StatisticGraphType): GraphSpec | undefined {
  return GRAPH_SPECS.find((s) => s.type === type);
}

import { reduceValues } from "./statisticSeriesCore";

/** Whether an instance is predicted (has a score). Mirrors summary.py hasattr(inst,"score"). */
function isPredicted(inst: unknown): inst is { score: number } {
  return typeof inst === "object" && inst !== null && "score" in inst &&
    typeof (inst as { score: unknown }).score === "number";
}

/** Total predicted points per frame (summary.py get_point_count_series). */
export function pointCountSeries(labels: Labels, video: Video): Map<number, number> {
  const series = new Map<number, number>();
  for (const lf of labels.find({ video })) {
    let val = 0;
    for (const inst of lf.instances) {
      if (isPredicted(inst)) val += inst.points.length;
    }
    series.set(lf.frameIdx, val);
  }
  return series;
}

/** Reduced instance scores per frame (summary.py get_instance_score_series). */
export function instanceScoreSeries(
  labels: Labels,
  video: Video,
  reduction: Reduction,
): Map<number, number> {
  const series = new Map<number, number>();
  for (const lf of labels.find({ video })) {
    const vals: number[] = [];
    for (const inst of lf.instances) {
      if (isPredicted(inst)) vals.push(inst.score);
    }
    series.set(lf.frameIdx, reduceValues(vals, reduction));
  }
  return series;
}

/** Reduced per-point scores per frame (summary.py get_point_score_series). */
export function pointScoreSeries(
  labels: Labels,
  video: Video,
  reduction: Reduction,
): Map<number, number> {
  const series = new Map<number, number>();
  for (const lf of labels.find({ video })) {
    const vals: number[] = [];
    for (const inst of lf.instances) {
      if (!isPredicted(inst)) continue;
      for (const p of (inst as unknown as { points: Array<{ score?: number }> }).points) {
        if (typeof p.score === "number") vals.push(p.score);
      }
    }
    series.set(lf.frameIdx, reduceValues(vals, reduction));
  }
  return series;
}

/**
 * Reduced tracking scores per frame (summary.py get_tracking_score_series).
 * Reduction is nanmin/nanmean; frames with no usable score are skipped.
 */
export function trackingScoreSeries(
  labels: Labels,
  video: Video,
  reduction: Reduction,
): Map<number, number> {
  const series = new Map<number, number>();
  for (const lf of labels.find({ video })) {
    const vals: number[] = [];
    for (const inst of lf.instances) {
      const ts = (inst as unknown as { trackingScore?: number }).trackingScore;
      if (typeof ts === "number") vals.push(ts);
    }
    if (vals.length === 0) continue;
    const val = reduceValues(vals, reduction);
    if (!Number.isNaN(val)) series.set(lf.frameIdx, val);
  }
  return series;
}

import { medianCentroid, minCentroidDistance } from "./statisticSeriesCore";

/**
 * Min pairwise centroid distance per frame (summary.py
 * get_min_centroid_proximity_series). HYBRID parity: uses a MEDIAN centroid
 * (medianCentroid over Instance.numpy() rows) to match summary.py's
 * np.nanmedian get_centroid — INTENTIONALLY NOT Instance.centroidXy
 * (src/model/instance.ts:173), which is a MEAN centroid. Frames with <2
 * centroids are skipped.
 */
export function minCentroidProximitySeries(labels: Labels, video: Video): Map<number, number> {
  const series = new Map<number, number>();
  for (const lf of labels.find({ video })) {
    const centroids: Array<[number, number]> = [];
    for (const inst of lf.instances) {
      const points = (inst as unknown as { numpy: () => number[][] }).numpy();
      const c = medianCentroid(points);
      if (c) centroids.push(c);
    }
    const val = minCentroidDistance(centroids);
    if (!Number.isNaN(val)) series.set(lf.frameIdx, val);
  }
  return series;
}

import { instanceVelocity } from "./statisticSeriesCore";

/**
 * Point displacement per frame vs the closest earlier labeled frame,
 * matching instances by track (summary.py get_point_displacement_series
 * + _calculate_frame_velocity). Track matching is reference identity,
 * same as Seekbar.tsx track occupancy.
 */
export function pointDisplacementSeries(
  labels: Labels,
  video: Video,
  reduction: Reduction,
): Map<number, number> {
  const series = new Map<number, number>();
  let lastLf: { instances: unknown[] } | null = null;
  for (const lf of labels.find({ video })) {
    let val = 0;
    if (lastLf) {
      for (const inst of lf.instances) {
        const track = (inst as { track?: unknown }).track ?? null;
        // Match PyQt labeled_frame_find(last_lf, track=inst.track)
        // (summary.py:252 + lf_labels_utils.py:1390):
        //   track === null -> ALL previous instances, take the first;
        //   track !== null -> previous instances with that track, take the first.
        // So UNTRACKED instances are matched against the first instance of the
        // previous labeled frame (this is how SLEAP shows displacement on
        // user-labeled data that has not been tracked yet).
        const prev =
          track === null
            ? lastLf.instances[0]
            : lastLf.instances.find(
                (o) => ((o as { track?: unknown }).track ?? null) === track,
              );
        if (prev) {
          const a = (inst as unknown as { numpy: () => number[][] }).numpy();
          const b = (prev as unknown as { numpy: () => number[][] }).numpy();
          const d = instanceVelocity(a, b, reduction);
          // summary.py:262: NaN per-instance velocity (e.g. a partially-visible
          // instance under sum/max NaN-propagation) contributes 0 to the frame.
          if (!Number.isNaN(d)) val += d;
        }
      }
    }
    lastLf = lf as unknown as { instances: unknown[] };
    if (!Number.isNaN(val)) series.set(lf.frameIdx, val);
  }
  return series;
}

import { primaryDisplacementFromMatrix } from "./statisticSeriesCore";

/**
 * Primary (single anchor node) displacement per frame, reduced across
 * tracks (summary.py get_primary_point_displacement_series). Builds a
 * per-frame, per-track anchor location matrix with carry-forward of last
 * known position, then computes shifted displacement.
 */
export function primaryPointDisplacementSeries(
  labels: Labels,
  video: Video,
  reduction: Reduction,
  primaryNodeIdx = 0,
): Map<number, number> {
  const tracks = labels.tracks as unknown[];
  const trackCount = tracks.length;
  const series = new Map<number, number>();
  if (trackCount === 0) return series;

  const frames = labels.find({ video });
  let lastFrameIdx = 0;
  for (const lf of frames) if (lf.frameIdx > lastFrameIdx) lastFrameIdx = lf.frameIdx;

  // location_matrix[frame][track] = [x, y]; carry-forward of last known pos.
  const loc: Array<Array<[number, number]>> = [];
  const lastPos: Array<[number, number]> = tracks.map(() => [0, 0]);
  const seen = new Set<number>();
  const byFrame = new Map<number, (typeof frames)[number]>();
  for (const lf of frames) byFrame.set(lf.frameIdx, lf);

  for (let f = 0; f <= lastFrameIdx; f++) {
    // start with last known positions
    const row: Array<[number, number]> = lastPos.map((p) => [p[0], p[1]]);
    const lf = byFrame.get(f);
    if (lf) {
      for (const inst of lf.instances) {
        const track = (inst as { track?: unknown }).track ?? null;
        if (track === null) continue;
        const trackIdx = tracks.indexOf(track);
        if (trackIdx < 0 || trackIdx >= trackCount) continue;
        const point = (inst as unknown as { numpy: () => number[][] }).numpy()[primaryNodeIdx];
        if (!point) continue;
        row[trackIdx] = [point[0], point[1]];
        if (!Number.isNaN(point[0]) && !Number.isNaN(point[1])) {
          lastPos[trackIdx] = [point[0], point[1]];
          // first sighting: backfill earlier frames so no spurious jump
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
    if (byFrame.has(f)) series.set(f, out[f]);
  }
  return series;
}

/** Dispatch by graph type. "none"/"instance-count" are handled in the UI. */
export function computeStatisticSeries(
  labels: Labels,
  video: Video,
  graph: StatisticGraphType,
  reduction: Reduction,
): Map<number, number> {
  switch (graph) {
    case "point-count": return pointCountSeries(labels, video);
    case "point-score": return pointScoreSeries(labels, video, reduction);
    case "instance-score": return instanceScoreSeries(labels, video, reduction);
    case "point-displacement": return pointDisplacementSeries(labels, video, reduction);
    case "primary-point-displacement": return primaryPointDisplacementSeries(labels, video, reduction);
    case "min-centroid-proximity": return minCentroidProximitySeries(labels, video);
    case "tracking-score": return trackingScoreSeries(labels, video, reduction);
    default: return new Map();
  }
}
