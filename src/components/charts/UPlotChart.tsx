import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { formatCompactNumber } from "@/lib/formatNumber";

export interface UPlotChartProps {
  data: uPlot.AlignedData;
  series: uPlot.Series[];
  scales?: uPlot.Scales;
  axes?: uPlot.Axis[];
  height?: number;
  showLegend?: boolean;
  className?: string;
  /** Show a value-readout tooltip at the cursor (x + each series' value). */
  tooltip?: boolean;
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
  { data, series, scales, axes, height = 240, showLegend = true, className, tooltip = false },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
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

    // Imperative cursor tooltip: read the nearest data index + each series'
    // value and paint a small readout at the cursor. Done in the hook (not React
    // state) so mouse-move doesn't re-render.
    const updateTooltip = (u: uPlot) => {
      const tt = tooltipRef.current;
      if (!tt) return;
      const { idx, left, top } = u.cursor;
      if (idx == null || left == null || left < 0) {
        tt.style.display = "none";
        return;
      }
      let html = `<div style="opacity:.6;margin-bottom:2px">batch ${u.data[0][idx]}</div>`;
      let any = false;
      for (let si = 1; si < u.series.length; si++) {
        const s = u.series[si];
        const val = u.data[si]?.[idx];
        if (val == null || !Number.isFinite(val as number)) continue;
        any = true;
        const color = typeof s.stroke === "string" ? s.stroke : "currentColor";
        html +=
          `<div style="display:flex;gap:8px;justify-content:space-between">` +
          `<span style="color:${color}">${s.label ?? ""}</span>` +
          `<span>${formatCompactNumber(val as number)}</span></div>`;
      }
      if (!any) {
        tt.style.display = "none";
        return;
      }
      tt.innerHTML = html;
      tt.style.display = "block";
      const overRect = u.over.getBoundingClientRect();
      const pRect = (tt.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      tt.style.left = `${overRect.left - (pRect?.left ?? 0) + left + 12}px`;
      tt.style.top = `${overRect.top - (pRect?.top ?? 0) + (top ?? 0) + 12}px`;
    };

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

    // Update the tooltip on REAL pointer moves only. Do NOT use uPlot's setCursor
    // hook: it also fires on every redraw (i.e. on every streamed training data
    // update), and forcing a layout (getBoundingClientRect) there thrashed the
    // main thread into a freeze during training. A plain mousemove listener does
    // zero work when the mouse isn't over the plot.
    const onMove = tooltip ? () => updateTooltip(u) : null;
    const onLeave = tooltip
      ? () => {
          if (tooltipRef.current) tooltipRef.current.style.display = "none";
        }
      : null;
    if (onMove) u.over.addEventListener("mousemove", onMove);
    if (onLeave) u.over.addEventListener("mouseleave", onLeave);

    const ro = new ResizeObserver(() => {
      if (plotRef.current) plotRef.current.setSize({ width: el.clientWidth || 320, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      if (onMove) u.over.removeEventListener("mousemove", onMove);
      if (onLeave) u.over.removeEventListener("mouseleave", onLeave);
      if (throttleTimer.current) clearTimeout(throttleTimer.current);
      u.destroy();
      plotRef.current = null;
    };
    // Recreate only when the chart shape changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, scales, axes, height, showLegend, tooltip]);

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

  return (
    <div className={className} style={{ position: "relative" }}>
      <div ref={containerRef} />
      {tooltip && (
        <div
          ref={tooltipRef}
          style={{
            display: "none",
            position: "absolute",
            pointerEvents: "none",
            zIndex: 20,
            background: "#0f172a",
            color: "#e5e7eb",
            border: "1px solid #334155",
            borderRadius: 4,
            padding: "3px 6px",
            fontSize: 10,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,.4)",
          }}
        />
      )}
    </div>
  );
});
