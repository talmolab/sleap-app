/**
 * A small static SVG line chart for the metrics dialogs (box AP vs. IoU
 * threshold, precision–recall, mAP per epoch). uPlot is built for live,
 * zoomable series; these are a handful of points, so plain SVG keeps them
 * crisp, theme-aware (currentColor) and easy to test.
 */
import { useMemo } from "react";

export interface MiniSeries {
  label: string;
  /** CSS color. */
  color: string;
  x: number[];
  /** null / NaN values break the line. */
  y: (number | null)[];
  /** Draw a dot at each point (for sparse series). */
  dots?: boolean;
}

export interface MiniLineChartProps {
  series: MiniSeries[];
  xLabel: string;
  yLabel: string;
  /** Fixed y range; defaults to [0, 1] (scores, AP, precision…). */
  yDomain?: [number, number];
  /** Fixed x range; defaults to the data's extent. */
  xDomain?: [number, number];
  /** Explicit x tick positions (default: 5 evenly spaced). */
  xTicks?: number[];
  /** Tick formatter for the x axis. */
  formatX?: (v: number) => string;
  width?: number;
  height?: number;
  ariaLabel: string;
}

const PAD = { left: 40, right: 12, top: 10, bottom: 30 };

function ticks(lo: number, hi: number, n: number): number[] {
  if (!(hi > lo)) return [lo];
  return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
}

/** Split a series into runs of finite points (null/NaN ends a run). */
export function finiteRuns(x: number[], y: (number | null)[]): [number, number][][] {
  const runs: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const yi = y[i];
    if (typeof yi === "number" && Number.isFinite(yi) && Number.isFinite(x[i])) {
      cur.push([x[i], yi]);
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

export function MiniLineChart({
  series,
  xLabel,
  yLabel,
  yDomain = [0, 1],
  xDomain,
  xTicks,
  formatX = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2)),
  width = 330,
  height = 190,
  ariaLabel,
}: MiniLineChartProps) {
  const [x0, x1] = useMemo<[number, number]>(() => {
    if (xDomain) return xDomain;
    const xs = series.flatMap((s) => s.x).filter(Number.isFinite);
    return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
  }, [series, xDomain]);
  const [y0, y1] = yDomain;
  const w = width - PAD.left - PAD.right;
  const h = height - PAD.top - PAD.bottom;
  const sx = (v: number) => PAD.left + (x1 > x0 ? ((v - x0) / (x1 - x0)) * w : w / 2);
  const sy = (v: number) => PAD.top + h - ((Math.min(Math.max(v, y0), y1) - y0) / (y1 - y0)) * h;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
        className="text-muted-foreground"
      >
        {ticks(y0, y1, 4).map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.left} x2={PAD.left + w} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={0.15} />
            <text x={PAD.left - 5} y={sy(t)} fontSize={9} textAnchor="end" dominantBaseline="middle" fill="currentColor">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        {(xTicks ?? ticks(x0, x1, 4)).map((t) => (
          <text key={`x${t}`} x={sx(t)} y={PAD.top + h + 12} fontSize={9} textAnchor="middle" fill="currentColor">
            {formatX(t)}
          </text>
        ))}
        <line x1={PAD.left} x2={PAD.left + w} y1={PAD.top + h} y2={PAD.top + h} stroke="currentColor" strokeOpacity={0.4} />
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + h} stroke="currentColor" strokeOpacity={0.4} />
        <text x={PAD.left + w / 2} y={height - 3} fontSize={10} textAnchor="middle" fill="currentColor">
          {xLabel}
        </text>
        <text
          x={10}
          y={PAD.top + h / 2}
          fontSize={10}
          textAnchor="middle"
          fill="currentColor"
          transform={`rotate(-90 10 ${PAD.top + h / 2})`}
        >
          {yLabel}
        </text>
        {series.map((s) =>
          finiteRuns(s.x, s.y).map((run, ri) => (
            <g key={`${s.label}-${ri}`}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={1.75}
                points={run.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")}
              />
              {(s.dots || run.length === 1) &&
                run.map(([x, y], pi) => <circle key={pi} cx={sx(x)} cy={sy(y)} r={2.5} fill={s.color} />)}
            </g>
          )),
        )}
      </svg>
      {series.length > 1 && (
        <figcaption className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
