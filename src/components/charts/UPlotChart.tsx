import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface UPlotChartProps {
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  scales?: uPlot.Scales;
  axes?: uPlot.Axis[];
  height?: number;
  showLegend?: boolean;
  className?: string;
}

/** Imperative controls exposed to the parent (zoom reset + PNG capture). */
export interface UPlotChartHandle {
  /** Restore the x-axis to the full data range (undo a drag-zoom). */
  resetZoom(): void;
  /** Snapshot the chart as a white-background PNG data URL (null if not ready). */
  toPngDataUrl(): string | null;
}

/**
 * Thin, chart-domain-agnostic React wrapper around a uPlot instance.
 * - Instance created once on mount, held in a ref.
 * - ResizeObserver drives width; height comes from the `height` prop.
 * - Data updates go through setData on a trailing ~500ms throttle so
 *   high-frequency (e.g. per-batch) updates do not thrash the canvas.
 * - Series/scales changes recreate the instance (they change rarely).
 */
export const UPlotChart = forwardRef<UPlotChartHandle, UPlotChartProps>(function UPlotChart(
  { data, series, scales, axes, height = 240, showLegend = true, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useImperativeHandle(ref, () => ({
    resetZoom() {
      const u = plotRef.current;
      if (!u) return;
      const xs = u.data[0];
      if (xs && xs.length) {
        u.setScale("x", { min: xs[0] as number, max: xs[xs.length - 1] as number });
      }
    },
    toPngDataUrl() {
      const u = plotRef.current;
      if (!u) return null;
      const src = u.ctx.canvas;
      const out = document.createElement("canvas");
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      // Composite onto white so the exported PNG isn't transparent.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      return out.toDataURL("image/png");
    },
  }), []);
  const pendingData = useRef<uPlot.AlignedData | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDraw = useRef(0);

  // Create / recreate on series or scales change.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const opts: uPlot.Options = {
      width: el.clientWidth || 320,
      height,
      series,
      scales,
      axes,
      legend: { show: showLegend },
      cursor: { drag: { x: true, y: false } },
    };
    const u = new uPlot(opts, data, el);
    plotRef.current = u;

    const ro = new ResizeObserver(() => {
      if (plotRef.current) plotRef.current.setSize({ width: el.clientWidth || 320, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      if (throttleTimer.current) clearTimeout(throttleTimer.current);
      u.destroy();
      plotRef.current = null;
    };
    // Recreate only when the chart shape changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, scales, axes, height, showLegend]);

  // Throttled data updates (≈500ms trailing edge).
  useEffect(() => {
    pendingData.current = data;
    const flush = () => {
      if (plotRef.current && pendingData.current) {
        plotRef.current.setData(pendingData.current);
        lastDraw.current = Date.now();
      }
      throttleTimer.current = null;
    };
    const since = Date.now() - lastDraw.current;
    if (since >= 500) {
      flush();
    } else if (!throttleTimer.current) {
      throttleTimer.current = setTimeout(flush, 500 - since);
    }
  }, [data]);

  return <div ref={containerRef} className={className} />;
});
