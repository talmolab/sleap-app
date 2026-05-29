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
