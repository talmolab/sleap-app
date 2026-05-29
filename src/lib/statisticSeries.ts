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
