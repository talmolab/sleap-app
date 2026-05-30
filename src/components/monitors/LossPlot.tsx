import { useState, useEffect, useMemo, useRef } from "react";
import type uPlot from "uplot";
import type { ModelProgress, TrainingStatus } from "@/stores/trainingStore";
import { UPlotChart } from "@/components/charts/UPlotChart";
import { buildLossPlotDataBatched, computeYRange, formatRuntimeTitle } from "@/lib/trainingMetrics";

export function LossPlot({
  model, startedAt, status, height = 200,
}: { model: ModelProgress; startedAt: number | null; status: TrainingStatus; height?: number }) {
  const [logScale, setLogScale] = useState(true);       // PyQt opens in log
  const [ignoreOutliers, setIgnoreOutliers] = useState(false);
  const [batchesToShow, setBatchesToShow] = useState(-1); // PyQt default = All

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
    { label: "train", stroke: "rgb(18,158,220)", width: 2, spanGaps: true, points: { show: false } },   // blue line
    { label: "val",   stroke: "rgb(248,167,52)", width: 2, spanGaps: true, points: { show: false } },    // orange line
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
  latestYsRef.current = [
    ...model.batchSamples.map((b) => b.loss),
    ...model.epochSamples.flatMap((s) =>
      [s.trainLoss, s.valLoss].filter((v): v is number => v != null),
    ),
  ];

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

  // Stable axes: X "Batches", Y "Loss" (PyQt parity), dark-theme friendly.
  const axes = useMemo<uPlot.Axis[]>(() => [
    { label: "Batches", stroke: "#9ca3af", grid: { stroke: "rgba(148,163,184,0.15)", width: 1 }, ticks: { stroke: "rgba(148,163,184,0.15)" } },
    { label: "Loss",    stroke: "#9ca3af", grid: { stroke: "rgba(148,163,184,0.15)", width: 1 }, ticks: { stroke: "rgba(148,163,184,0.15)" } },
  ], []);

  if (model.batchSamples.length === 0 && model.epochSamples.length === 0) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground leading-tight">
          {status === "running" ? "Waiting for first epoch…" : "No loss data"}
        </div>
        <div
          className="flex items-center justify-center rounded border border-dashed border-muted-foreground/30 text-[10px] text-muted-foreground"
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
      <div className="text-[10px] text-muted-foreground leading-tight">
        {titleLines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <UPlotChart data={data} series={series} scales={scales} axes={axes} height={height} className="w-full" />
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
      </div>
    </div>
  );
}
