import { useState, useEffect, useMemo, useRef } from "react";
import type uPlot from "uplot";
import type { ModelProgress, TrainingStatus } from "@/stores/trainingStore";
import { UPlotChart } from "@/components/charts/UPlotChart";
import { buildLossPlotData, computeYRange, formatRuntimeTitle } from "@/lib/trainingMetrics";

export function LossPlot({
  model, startedAt, status,
}: { model: ModelProgress; startedAt: number | null; status: TrainingStatus }) {
  const [logScale, setLogScale] = useState(true);       // PyQt opens in log
  const [ignoreOutliers, setIgnoreOutliers] = useState(false);

  // ~1s ticker so the runtime title updates live while running.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const series = useMemo<uPlot.Series[]>(() => [
    {},                                                   // x
    { label: "train", stroke: "#60a5fa", width: 2 },
    { label: "val", stroke: "#f59e0b", width: 2 },
    { label: "best val", stroke: "#22c55e", points: { show: true, size: 8 }, paths: () => null },
  ], []);

  const data = useMemo<uPlot.AlignedData>(() => {
    const { x, train, val } = buildLossPlotData(model.epochSamples);
    const bestEpoch = model.metrics.bestValEpoch;
    const best = x.map((xi) =>
      bestEpoch != null && xi === bestEpoch + 1 ? model.bestValLoss : null,
    );
    return [x, train, val, best];
  }, [model.epochSamples, model.metrics.bestValEpoch, model.bestValLoss]);

  // PERF: the y-range must track new epochs WITHOUT producing a new `scales`
  // object each epoch (a new `scales` recreates the whole uPlot instance every
  // epoch and bypasses UPlotChart's setData throttle). So we keep the latest
  // y-values in a ref and let uPlot's `range` callback read it on each redraw.
  const latestYsRef = useRef<number[]>([]);
  latestYsRef.current = model.epochSamples.flatMap((s) =>
    [s.trainLoss, s.valLoss].filter((v): v is number => v != null),
  );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [logScale, ignoreOutliers]);

  if (model.epochSamples.length === 0) return null;

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
      <UPlotChart data={data} series={series} scales={scales} height={200} className="w-full" />
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
          Log scale
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={ignoreOutliers} onChange={(e) => setIgnoreOutliers(e.target.checked)} />
          Ignore outliers
        </label>
      </div>
    </div>
  );
}
