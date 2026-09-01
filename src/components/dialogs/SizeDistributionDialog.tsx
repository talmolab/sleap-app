/**
 * Instance Size Distribution (Analyze menu, Tier 1).
 *
 * Histogram + summary stats of every labeled instance's bounding-box size
 * (max of width/height). Clicking a bar jumps to an example instance of that
 * size bucket and closes the dialog. Pure math lives in instanceSizeCore.ts;
 * the Labels walk in instanceSize.ts — this component is the thin view.
 */
import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/stores/appStore";
import { collectSizedInstances } from "@/lib/analyze/instanceSize";
import { summarizeSizes, binSizes, binIndexOf } from "@/lib/analyze/instanceSizeCore";

export interface SizeDistributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const BIN_COUNT = 24;
const W = 560;
const H = 200;
const AXIS = 24; // bottom axis band

const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : "—");

export function SizeDistributionDialog({ open, onOpenChange }: SizeDistributionDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const setInstance = useAppStore((s) => s.setInstance);

  const { sized, summary, hist } = useMemo(() => {
    if (!open || !labels) {
      return { sized: [], summary: summarizeSizes([]), hist: binSizes([], BIN_COUNT) };
    }
    const s = collectSizedInstances(labels);
    return { sized: s, summary: summarizeSizes(s.map((x) => x.size)), hist: binSizes(s.map((x) => x.size), BIN_COUNT) };
  }, [open, labels]);

  const maxCount = Math.max(1, ...hist.counts);
  const barW = hist.binCount > 0 ? W / hist.binCount : 0;
  const plotH = H - AXIS;

  const navigateToBin = (binIdx: number) => {
    if (!labels) return;
    const target = sized.find((si) => binIndexOf(hist, si.size) === binIdx);
    if (!target) return;
    setVideo(target.video);
    setFrameIdx(target.frameIdx);
    const lf = labels.find({ video: target.video }).find((f) => f.frameIdx === target.frameIdx);
    setInstance(lf?.instances[target.instanceIdx] ?? null);
    onOpenChange(false);
  };

  const stats: [string, string][] = [
    ["Instances", String(summary.count)],
    ["Min", fmt(summary.min)],
    ["Max", fmt(summary.max)],
    ["Mean ± SD", `${fmt(summary.mean)} ± ${fmt(summary.std)}`],
    ["Median", fmt(summary.median)],
    ["p90 / p95 / p99", `${fmt(summary.p90)} / ${fmt(summary.p95)} / ${fmt(summary.p99)}`],
    ["Outliers (>2σ)", String(summary.outlierCount)],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Instance Size Distribution</DialogTitle>
          <DialogDescription>
            Bounding-box size (max of width, height) of every labeled instance. Click a bar to
            jump to an example instance of that size.
          </DialogDescription>
        </DialogHeader>

        {summary.count === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No labeled instances to analyze.
          </p>
        ) : (
          <div className="space-y-4">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="w-full"
              role="img"
              aria-label="Instance size histogram"
            >
              {hist.counts.map((c, i) => {
                const barH = (c / maxCount) * plotH;
                return (
                  <rect
                    key={i}
                    x={i * barW + 1}
                    y={plotH - barH}
                    width={Math.max(0, barW - 2)}
                    height={barH}
                    fill="currentColor"
                    className="cursor-pointer text-primary/70 hover:text-primary"
                    onClick={() => navigateToBin(i)}
                  >
                    <title>{`${fmt(hist.edges[i])}–${fmt(hist.edges[i + 1])} px: ${c}`}</title>
                  </rect>
                );
              })}
              <line
                x1={0}
                y1={plotH}
                x2={W}
                y2={plotH}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
              />
              <text x={0} y={H - 6} fill="currentColor" className="text-muted-foreground text-[10px]">
                {fmt(hist.min)}
              </text>
              <text
                x={W}
                y={H - 6}
                textAnchor="end"
                fill="currentColor"
                className="text-muted-foreground text-[10px]"
              >
                {fmt(hist.max)}
              </text>
            </svg>

            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
              {stats.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
