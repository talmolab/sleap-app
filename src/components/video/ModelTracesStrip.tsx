/**
 * Per-node traces for Compare Model Predictions, in a strip under the video
 * (opened from the legend). Two small plots, x and y of the chosen node over
 * time, one line per shown model in its colour; a red line marks the current
 * frame. Click a plot to go to that frame; drag to zoom in, double-click to
 * zoom back out (uPlot's own gestures). Built on the app's UPlotChart.
 */
import { useMemo } from "react";
import { X } from "lucide-react";
import type uPlot from "uplot";
import { UPlotChart } from "@/components/charts/UPlotChart";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { rgbToCSS } from "@/lib/colorPalettes";
import { shownModelsShareTracks } from "@/hooks/useModelOverlayFrame";
import {
  buildAnimalIndex,
  buildTraces,
  traceAnimalCount,
  traceRange,
  traceTrackNames,
  type TraceTarget,
} from "@/lib/modelOverlay/traces";

const PLOT_HEIGHT = 90;

const AXIS_STYLE = {
  stroke: "#9ca3af",
  grid: { stroke: "rgba(156,163,175,0.15)" },
  ticks: { stroke: "rgba(156,163,175,0.3)" },
  font: "10px sans-serif",
  size: 36,
};

function targetKey(t: TraceTarget): string {
  return t.kind === "track" ? `track:${t.name}` : `animal:${t.index}`;
}

export function ModelTracesStrip() {
  const open = useModelOverlayStore((s) => s.tracesOpen);
  const setOpen = useModelOverlayStore((s) => s.setTracesOpen);
  const allModels = useModelOverlayStore((s) => s.models);
  const node = useModelOverlayStore((s) => s.traceNode);
  const setNode = useModelOverlayStore((s) => s.setTraceNode);
  const storedTarget = useModelOverlayStore((s) => s.traceTarget);
  const setTarget = useModelOverlayStore((s) => s.setTraceTarget);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const skeleton = useAppStore((s) => s.skeleton);

  const models = useMemo(
    () => allModels.filter((m) => m.visible && m.video === video),
    [allModels, video]
  );
  const byTrack = useMemo(() => shownModelsShareTracks(allModels, video), [allModels, video]);
  const trackNames = useMemo(() => traceTrackNames(models, byTrack), [models, byTrack]);
  // Linking animals across frames is the slow part: once per set of shown
  // models, not per node or frame.
  const animalIndex = useMemo(
    () => (open && trackNames.length === 0 && models.length > 0 ? buildAnimalIndex(models) : null),
    [open, trackNames, models]
  );
  const animalCount = animalIndex ? traceAnimalCount(animalIndex) : 0;
  const nodeNames = useMemo(() => skeleton?.nodes.map((n) => n.name) ?? [], [skeleton]);
  const safeNode = node < nodeNames.length ? node : 0;

  // The stored choice may not fit these models (tracks vs. none): fall back to the first option.
  const target: TraceTarget = useMemo(() => {
    if (trackNames.length > 0) {
      return storedTarget.kind === "track" && trackNames.includes(storedTarget.name)
        ? storedTarget
        : { kind: "track", name: trackNames[0] };
    }
    return storedTarget.kind === "animal" && storedTarget.index < Math.max(1, animalCount)
      ? storedTarget
      : { kind: "animal", index: 0 };
  }, [storedTarget, trackNames, animalCount]);

  const traces = useMemo(
    () =>
      open && models.length > 0 && (target.kind === "track" || animalIndex)
        ? buildTraces(models, safeNode, target, animalIndex ?? undefined)
        : null,
    [open, models, safeNode, target, animalIndex]
  );

  const series = useMemo<uPlot.Series[]>(
    () => [
      { label: "frame" },
      ...models.map((m) => ({ label: m.name, stroke: rgbToCSS(m.color), width: 1.5, spanGaps: false })),
    ],
    [models]
  );
  const xRange: [number, number] = useMemo(() => {
    const f = traces?.frames ?? [];
    return f.length > 1 ? [f[0], f[f.length - 1]] : f.length === 1 ? [f[0] - 1, f[0] + 1] : [0, 1];
  }, [traces]);
  const scalesX = useMemo(() => {
    const r = traceRange(traces?.x ?? []);
    return { x: { time: false, range: xRange }, y: { range: r } } as uPlot.Scales;
  }, [traces, xRange]);
  const scalesY = useMemo(() => {
    const r = traceRange(traces?.y ?? []);
    return { x: { time: false, range: xRange }, y: { range: r } } as uPlot.Scales;
  }, [traces, xRange]);
  const axes = useMemo<uPlot.Axis[]>(() => [{ ...AXIS_STYLE }, { ...AXIS_STYLE }], []);
  const dataX = useMemo(
    () => (traces ? ([traces.frames, ...traces.x] as uPlot.AlignedData) : null),
    [traces]
  );
  const dataY = useMemo(
    () => (traces ? ([traces.frames, ...traces.y] as uPlot.AlignedData) : null),
    [traces]
  );

  if (!open || models.length === 0) return null;
  const seek = (x: number) => useAppStore.getState().setFrameIdx(Math.max(0, Math.round(x)));

  return (
    <div className="shrink-0 border-t border-border bg-background px-2 pb-1 pt-1 text-xs" data-testid="model-traces-strip">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-muted-foreground">Traces</span>
        <select
          className="rounded border border-border bg-background px-1 py-0.5"
          value={safeNode}
          onChange={(e) => setNode(Number(e.target.value))}
          aria-label="Node"
        >
          {nodeNames.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
        {(trackNames.length > 0 || animalCount > 1) && (
          <select
            className="rounded border border-border bg-background px-1 py-0.5"
            value={targetKey(target)}
            onChange={(e) => {
              const [kind, rest] = e.target.value.split(/:(.*)/s);
              setTarget(kind === "track" ? { kind: "track", name: rest } : { kind: "animal", index: Number(rest) });
            }}
            aria-label="Animal"
          >
            {trackNames.length > 0
              ? trackNames.map((t) => (
                  <option key={t} value={`track:${t}`}>
                    {t}
                  </option>
                ))
              : Array.from({ length: animalCount }, (_, i) => (
                  <option key={i} value={`animal:${i}`}>
                    Animal {i + 1}
                  </option>
                ))}
          </select>
        )}
        {trackNames.length === 0 && animalCount > 1 && (
          <span
            className="text-muted-foreground"
            title="Without shared tracks, each animal is followed from frame to frame by position (closest pose). Animals that cross or vanish for a while can get a new number."
          >
            (untracked: followed by position)
          </span>
        )}
        <span className="flex-1" />
        <span className="text-muted-foreground">Click to go to a frame · drag to zoom · double-click to zoom out</span>
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setOpen(false)}
          aria-label="Close traces"
          title="Close traces"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {dataX && dataY && (
        <div className="grid grid-cols-1 gap-0">
          <div className="flex items-center gap-1">
            <span className="w-3 font-mono text-muted-foreground">x</span>
            <UPlotChart
              className="min-w-0 flex-1"
              data={dataX}
              series={series}
              scales={scalesX}
              axes={axes}
              height={PLOT_HEIGHT}
              showLegend={false}
              tooltip
              xLabel="frame"
              onClickX={seek}
              markerX={frameIdx}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3 font-mono text-muted-foreground">y</span>
            <UPlotChart
              className="min-w-0 flex-1"
              data={dataY}
              series={series}
              scales={scalesY}
              axes={axes}
              height={PLOT_HEIGHT}
              showLegend={false}
              tooltip
              xLabel="frame"
              onClickX={seek}
              markerX={frameIdx}
            />
          </div>
        </div>
      )}
    </div>
  );
}
