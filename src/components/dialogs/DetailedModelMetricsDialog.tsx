/**
 * Detailed metrics for a single trained model (parity with classic SLEAP
 * `DetailedMetricsDialog`, sleap/gui/dialogs/metrics.py:260-338).
 *
 * Left: a labeled key/value list of the scalar metrics (using the same
 * human-readable labels as `METRICS_KEY_LABELS`). Right: a per-node distance
 * boxplot computed from `distance_metrics.dists` — five-number summaries per
 * node (min / Q1 / median / Q3 / p95, ignoring null/NaN) rendered as a small
 * inline SVG (uPlot has no native boxplot).
 */

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { computeNodeBoxplots, distanceAxisMax } from "@/lib/metrics/boxplot";
import { runDirName } from "@/lib/metrics/loadModelMetrics";
import type { ModelMetrics, ModelMetricsRow } from "@/lib/metrics/types";

// Ordered, human-readable labels — mirrors classic SLEAP METRICS_KEY_LABELS.
interface LabeledMetric {
  label: string;
  value: number | null;
}

function fmt(v: number | null | undefined, digits = 5): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function buildLabeledMetrics(m: ModelMetrics): LabeledMetric[] {
  const vis = m.visibility;
  const dist = m.distance;
  const pck = m.pck;
  const voc = m.voc;
  return [
    { label: "Visibility - True Positives", value: vis ? vis.tp : null },
    { label: "Visibility - False Positives", value: vis ? vis.fp : null },
    { label: "Visibility - True Negatives", value: vis ? vis.tn : null },
    { label: "Visibility - False Negatives", value: vis ? vis.fn : null },
    { label: "Visibility - Precision", value: vis?.precision ?? null },
    { label: "Visibility - Recall", value: vis?.recall ?? null },
    { label: "Average Distance (ground truth vs prediction)", value: dist?.avg ?? null },
    { label: "Distance for 50th percentile", value: dist?.p50 ?? null },
    { label: "Distance for 75th percentile", value: dist?.p75 ?? null },
    { label: "Distance for 90th percentile", value: dist?.p90 ?? null },
    { label: "Distance for 95th percentile", value: dist?.p95 ?? null },
    { label: "Distance for 99th percentile", value: dist?.p99 ?? null },
    { label: "Mean Percentage of Correct Keypoints (PCK)", value: pck?.mPCK ?? null },
    { label: "Mean Object Keypoint Similarity (OKS)", value: m.mOKS ?? null },
    { label: "VOC with OKS scores - mean Average Precision (mAP)", value: voc?.["oks_voc.mAP"] ?? null },
    { label: "VOC with OKS scores - mean Average Recall (mAR)", value: voc?.["oks_voc.mAR"] ?? null },
    { label: "VOC with PCK scores - mean Average Precision (mAP)", value: voc?.["pck_voc.mAP"] ?? null },
    { label: "VOC with PCK scores - mean Average Recall (mAR)", value: voc?.["pck_voc.mAR"] ?? null },
  ].filter((row) => row.value !== null && row.value !== undefined);
}

// ── Inline SVG boxplot ───────────────────────────────────────────────────────

const PAD_LEFT = 96;
const PAD_RIGHT = 20;
const PAD_TOP = 30;
const ROW_H = 30;
const AXIS_H = 40;
const WIDTH = 540;

function NodeDistanceBoxplot({
  dists,
  nodeNames,
}: {
  dists: (number | null)[][];
  nodeNames: string[] | null;
}) {
  const stats = useMemo(() => computeNodeBoxplots(dists, nodeNames), [dists, nodeNames]);
  const xmax = useMemo(() => distanceAxisMax(dists), [dists]);

  const height = PAD_TOP + stats.length * ROW_H + AXIS_H;
  const plotLeft = PAD_LEFT;
  const plotRight = WIDTH - PAD_RIGHT;
  const plotW = plotRight - plotLeft;
  const axisY = PAD_TOP + stats.length * ROW_H;

  const xPix = (v: number) => plotLeft + (Math.min(v, xmax) / xmax) * plotW;

  const ticks = [0, xmax / 4, xmax / 2, (3 * xmax) / 4, xmax];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      width="100%"
      role="img"
      aria-label="Node distance boxplot (ground truth vs prediction)"
      className="text-foreground"
      style={{ maxWidth: WIDTH }}
    >
      <text x={plotLeft} y={16} className="fill-foreground" fontSize={12} fontWeight={600}>
        Node distances (px)
      </text>

      {/* vertical grid + axis ticks */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line
            x1={xPix(t)}
            y1={PAD_TOP}
            x2={xPix(t)}
            y2={axisY}
            className="stroke-border"
            strokeWidth={1}
          />
          <text
            x={xPix(t)}
            y={axisY + 16}
            className="fill-muted-foreground"
            fontSize={10}
            textAnchor="middle"
          >
            {t.toFixed(t < 10 ? 1 : 0)}
          </text>
        </g>
      ))}
      <text
        x={(plotLeft + plotRight) / 2}
        y={axisY + 34}
        className="fill-muted-foreground"
        fontSize={11}
        textAnchor="middle"
      >
        Error (px)
      </text>

      {/* per-node rows */}
      {stats.map((s, i) => {
        const cy = PAD_TOP + i * ROW_H + ROW_H / 2;
        const boxTop = cy - 7;
        const boxH = 14;
        return (
          <g key={s.node} data-node={s.node}>
            <text
              x={plotLeft - 8}
              y={cy + 3}
              className="fill-foreground"
              fontSize={11}
              textAnchor="end"
            >
              {s.node}
            </text>
            {s.count === 0 ? (
              <text
                x={plotLeft + 6}
                y={cy + 3}
                className="fill-muted-foreground"
                fontSize={10}
              >
                no data
              </text>
            ) : (
              <>
                {/* whisker min → p95 */}
                <line
                  x1={xPix(s.min)}
                  y1={cy}
                  x2={xPix(s.p95)}
                  y2={cy}
                  className="stroke-muted-foreground"
                  strokeWidth={1}
                />
                <line x1={xPix(s.min)} y1={cy - 4} x2={xPix(s.min)} y2={cy + 4} className="stroke-muted-foreground" strokeWidth={1} />
                <line x1={xPix(s.p95)} y1={cy - 4} x2={xPix(s.p95)} y2={cy + 4} className="stroke-muted-foreground" strokeWidth={1} />
                {/* IQR box */}
                <rect
                  x={xPix(s.q1)}
                  y={boxTop}
                  width={Math.max(1, xPix(s.q3) - xPix(s.q1))}
                  height={boxH}
                  className="fill-primary/40 stroke-primary"
                  strokeWidth={1}
                  rx={2}
                />
                {/* median */}
                <line
                  x1={xPix(s.median)}
                  y1={boxTop}
                  x2={xPix(s.median)}
                  y2={boxTop + boxH}
                  className="stroke-primary"
                  strokeWidth={2}
                />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export interface DetailedModelMetricsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ModelMetricsRow | null;
}

export function DetailedModelMetricsDialog({
  open,
  onOpenChange,
  row,
}: DetailedModelMetricsDialogProps) {
  const metrics = row?.metrics ?? null;
  const labeled = useMemo(
    () => (metrics ? buildLabeledMetrics(metrics) : []),
    [metrics],
  );
  const title = row ? (row.runName ?? runDirName(row.path)) : "Model Metrics";
  const hasDists = !!metrics?.distance && metrics.distance.dists.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-all">{title}</DialogTitle>
          <DialogDescription>
            {row?.path}
            {metrics ? ` • ${metrics.split} split` : ""}
          </DialogDescription>
        </DialogHeader>

        {!metrics ? (
          <p className="text-sm text-muted-foreground py-4">
            {row?.error
              ? `Could not load metrics: ${row.error}`
              : "Metrics have not been generated for this model."}
          </p>
        ) : (
          <ScrollArea className="max-h-[70vh] pr-3">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Scalar metrics */}
              <div className="space-y-1.5">
                {labeled.map((row2) => (
                  <div key={row2.label} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="text-muted-foreground">{row2.label}</span>
                    <span className="font-mono tabular-nums text-foreground shrink-0">
                      {fmt(row2.value)}
                    </span>
                  </div>
                ))}
                {labeled.length === 0 && (
                  <p className="text-sm text-muted-foreground">No scalar metrics available.</p>
                )}
              </div>

              {/* Per-node distance boxplot */}
              <div>
                {hasDists ? (
                  <NodeDistanceBoxplot
                    dists={metrics.distance!.dists}
                    nodeNames={row?.nodeNames ?? null}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No per-node distance data available.
                  </p>
                )}
              </div>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
