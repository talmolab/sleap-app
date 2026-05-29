import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface UPlotChartProps {
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  scales?: uPlot.Scales;
  height?: number;
  className?: string;
}

/**
 * Thin, chart-domain-agnostic React wrapper around a uPlot instance.
 * - Instance created once on mount, held in a ref.
 * - ResizeObserver drives width; height comes from the `height` prop.
 * - Data updates go through setData on a trailing ~500ms throttle so
 *   high-frequency (e.g. per-batch) updates do not thrash the canvas.
 * - Series/scales changes recreate the instance (they change rarely).
 */
export function UPlotChart({ data, series, scales, height = 240, className }: UPlotChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
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
      legend: { show: true },
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
  }, [series, scales, height]);

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
}
