import { useState, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type uPlot from "uplot";
import type { ModelProgress, TrainingStatus } from "@/stores/trainingStore";
import { UPlotChart, type UPlotChartHandle } from "@/components/charts/UPlotChart";
import { boundedLossYValues, buildLossPlotDataBatched, computeYRange, formatRuntimeTitle, lossCsv } from "@/lib/trainingMetrics";
import { Button } from "@/components/ui/button";
import { saveBytesFile } from "@/commands/fileCommands";

// Bold numeric tokens (integers, decimals, mm:ss times, scientific notation)
// in the runtime title — PyQt parity.
function renderTitleLine(line: string): ReactNode[] {
  const parts = line.split(/(\d+:\d+|\d+\.\d+e[-+]?\d+|\d+(?:\.\d+)?)/g);
  return parts.map((p, i) =>
    /^(?:\d+:\d+|\d+\.\d+e[-+]?\d+|\d+(?:\.\d+)?)$/.test(p) ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>,
  );
}

export function LossPlot({
  model, startedAt, status, height = 200,
}: { model: ModelProgress; startedAt: number | null; status: TrainingStatus; height?: number }) {
  const [logScale, setLogScale] = useState(true);       // PyQt opens in log
  const [ignoreOutliers, setIgnoreOutliers] = useState(false);
  const [batchesToShow, setBatchesToShow] = useState(-1); // PyQt default = All
  const chartRef = useRef<UPlotChartHandle>(null);

  // Export the loss curve so people can show it without W&B.
  const exportPng = async () => {
    const url = chartRef.current?.toPngDataUrl();
    if (!url) return;
    const b64 = url.split(",")[1] ?? "";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await saveBytesFile(bytes, `${model.label}-loss.png`, { name: "PNG image", ext: "png" });
  };
  const exportCsv = async () => {
    const bytes = new TextEncoder().encode(lossCsv(model.epochSamples));
    await saveBytesFile(bytes, `${model.label}-loss.csv`, { name: "CSV", ext: "csv" });
  };

  // ~1s ticker so the runtime title updates live while running.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const series = useMemo<uPlot.Series[]>(() => [
    {},                                                                                   // x (global batch)
    { label: "batch", stroke: "rgba(18,158,220,0.55)",
      points: { show: true, size: 3, stroke: "rgba(18,158,220,0.55)", fill: "rgba(18,158,220,0.22)" },
      paths: () => null },                                                                // faint blue scatter
    { label: "train", stroke: "rgb(18,158,220)", width: 2, spanGaps: true,
      points: { show: true, size: 6, stroke: "rgb(18,158,220)", fill: "rgb(18,158,220)" } },   // blue line
    { label: "val",   stroke: "rgb(248,167,52)", width: 2, spanGaps: true,
      points: { show: true, size: 6, stroke: "rgb(248,167,52)", fill: "rgb(248,167,52)" } },    // orange line
    { label: "best val", stroke: "rgb(151,204,89)", points: { show: true, size: 9, stroke: "rgb(151,204,89)" }, paths: () => null }, // green marker
  ], []);

  const data = useMemo<uPlot.AlignedData>(() => {
    const { x, batch, train, val, best } = buildLossPlotDataBatched(
      model.batchSamples,
      model.epochSamples,
      model.epochSize,
      model.metrics.bestValEpoch,
      model.bestValLoss,
      batchesToShow,
    );
    return [x, batch, train, val, best];
  }, [
    model.batchSamples,
    model.epochSamples,
    model.epochSize,
    model.metrics.bestValEpoch,
    model.bestValLoss,
    batchesToShow,
  ]);

  // PERF: the y-range must track new epochs WITHOUT producing a new `scales`
  // object each epoch (a new `scales` recreates the whole uPlot instance every
  // epoch and bypasses UPlotChart's setData throttle). So we keep the latest
  // y-values in a ref and let uPlot's `range` callback read it on each redraw.
  const latestYsRef = useRef<number[]>([]);
  // Bounded input (see boundedLossYValues): the full 20k batch buffer would make
  // the per-redraw computeYRange sort escalate into a GUI freeze with the monitor
  // open during a long run. Decimated to the drawn-point cap → no clipping.
  latestYsRef.current = boundedLossYValues(model.batchSamples, model.epochSamples);

  // `scales` is memoized on [logScale, ignoreOutliers] ONLY — NOT on epochSamples.
  // The `range` fn closes over the ref, so it always sees the current data and
  // recomputes the y-range on each uPlot draw (cheap) instead of rebuilding the
  // chart. This keeps the 500ms setData throttle effective for the epoch path.
  const scales = useMemo<uPlot.Scales>(() => ({
    x: { time: false },
    y: {
      distr: logScale ? 3 : 1,
      range: () =>
        computeYRange(latestYsRef.current, { logScale, ignoreOutliers }) ??
        [logScale ? 0.001 : 0, 1],
    },
  }), [logScale, ignoreOutliers]);

  // Stable axes: X "Batches", Y "Loss" (PyQt parity). Dark strokes for contrast
  // on the white plot background (PyQt's LossViewer is white-always).
  const axes = useMemo<uPlot.Axis[]>(() => [
    { label: "Batches", stroke: "#334155", grid: { stroke: "rgba(15,23,42,0.10)", width: 1 }, ticks: { stroke: "rgba(15,23,42,0.10)" } },
    { label: "Loss",    stroke: "#334155", grid: { stroke: "rgba(15,23,42,0.10)", width: 1 }, ticks: { stroke: "rgba(15,23,42,0.10)" } },
  ], []);

  if (model.batchSamples.length === 0 && model.epochSamples.length === 0) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground leading-tight">
          {status === "running" ? "Waiting for first epoch…" : "No loss data"}
        </div>
        <div
          className="flex items-center justify-center rounded border border-dashed border-slate-300 bg-white text-[10px] text-slate-500"
          style={{ height }}
        >
          {status === "running"
            ? "Loss curves will appear after the first epoch completes."
            : "No loss data was recorded for this model."}
        </div>
      </div>
    );
  }

  const lastVal = model.epochSamples[model.epochSamples.length - 1]?.valLoss ?? null;
  const epochStartedAt = model.epochStartedAt;
  const titleLines = formatRuntimeTitle({
    epoch: model.epoch - 1,
    maxEpochs: model.maxEpochs,
    totalRuntimeMs: startedAt ? now - startedAt : 0,
    epochRuntimeMs: epochStartedAt ? now - epochStartedAt : null,
    metrics: model.metrics,
    plateauPatience: model.plateauPatience,
    lastValLoss: lastVal,
    bestValLoss: model.bestValLoss,
    bestValEpoch: model.metrics.bestValEpoch,
  });

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground leading-snug">
        {titleLines.map((l, i) => <div key={i}>{renderTitleLine(l)}</div>)}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {[
          { c: "rgba(18,158,220,0.55)", l: "Batch Training Loss" },
          { c: "rgb(18,158,220)", l: "Epoch Training Loss" },
          { c: "rgb(248,167,52)", l: "Epoch Validation Loss" },
          { c: "rgb(151,204,89)", l: "Best Validation Loss" },
        ].map((s) => (
          <span key={s.l} className="flex items-center gap-1">
            <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: s.c }} />
            {s.l}
          </span>
        ))}
      </div>
      <UPlotChart ref={chartRef} data={data} series={series} scales={scales} axes={axes} height={height} showLegend={false} tooltip className="w-full bg-white rounded" />
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
          Log scale
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={ignoreOutliers} onChange={(e) => setIgnoreOutliers(e.target.checked)} />
          Ignore outliers
        </label>
        <label className="flex items-center gap-1">
          Batches:
          <select
            className="bg-transparent border border-muted-foreground/30 rounded px-1 py-0.5 text-[10px]"
            value={batchesToShow}
            onChange={(e) => setBatchesToShow(Number(e.target.value))}
          >
            <option value={200}>200</option>
            <option value={1000}>1000</option>
            <option value={5000}>5000</option>
            <option value={-1}>All</option>
          </select>
        </label>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            title="Reset zoom (drag on the plot to zoom in; double-click also resets)"
            onClick={() => chartRef.current?.resetZoom()}
          >
            Reset zoom
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" title="Export the plot as a PNG image" onClick={exportPng}>
            PNG
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" title="Export the loss values as CSV" onClick={exportCsv}>
            CSV
          </Button>
        </span>
      </div>
    </div>
  );
}
