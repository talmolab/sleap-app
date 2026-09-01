/**
 * Instance Size Distribution (Analyze menu, Tier 1).
 *
 * Histogram OR clickable scatter of every labeled instance's bounding-box size
 * (max of width/height), with a rotation-augmentation preview (raw vs rotated
 * size), median / mean / max reference lines, and configurable bins / x-range.
 * Clicking a bar or point selects an example instance — its details fill the
 * "Selected Instance" box and the main window navigates to it (revealed on
 * close). A faithful port of the PyQt `SizeDistributionWidget`.
 *
 * Pure math lives in instanceSizeCore.ts; the Labels walk in instanceSize.ts —
 * this component is the thin view.
 */
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/stores/appStore";
import { collectSizedInstances, type SizedInstance } from "@/lib/analyze/instanceSize";
import {
  summarizeSizes,
  binSizes,
  binIndexOf,
  rotatedSize,
  niceTicks,
} from "@/lib/analyze/instanceSizeCore";

export interface SizeDistributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ViewMode = "scatter" | "histogram";
type RotationPreset = "Off" | "±15" | "±180" | "Custom";

// Plot geometry (SVG user units; the <svg> scales to its container width). Kept
// wide-and-short so the whole dialog fits an ~820px-tall viewport.
const VB_W = 720;
const VB_H = 300;
const M = { top: 24, right: 108, bottom: 40, left: 54 };
const PX0 = M.left;
const PX1 = VB_W - M.right;
const PY0 = M.top;
const PY1 = VB_H - M.bottom;
const PLOT_W = PX1 - PX0;
const PLOT_H = PY1 - PY0;

const C = {
  axis: "#475569", // slate-600
  grid: "#e2e8f0", // slate-200
  bar: "#4682b4", // steelblue
  median: "#16a34a", // green-600
  mean: "#2563eb", // blue-600
  max: "#ef4444", // red-500
  title: "#334155", // slate-700
};

const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : "—");
const fmt0 = (v: number): string => (Number.isFinite(v) ? Math.round(v).toString() : "—");

const presetAngle = (preset: RotationPreset, custom: number): number =>
  preset === "Off" ? 0 : preset === "±15" ? 15 : preset === "±180" ? 180 : custom;

const parseAuto = (s: string): number | null => {
  const t = s.trim();
  if (t === "" || t.toLowerCase() === "auto") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/** Blue → yellow → red ramp keyed on size/median (clamped to [0.5, 1.5]). */
function sizeColor(ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio - 0.5));
  const lerp = (a: number, b: number, u: number) => Math.round(a + (b - a) * u);
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const u = t / 0.5;
    r = lerp(59, 250, u);
    g = lerp(130, 204, u);
    b = lerp(246, 21, u);
  } else {
    const u = (t - 0.5) / 0.5;
    r = lerp(250, 239, u);
    g = lerp(204, 68, u);
    b = lerp(21, 68, u);
  }
  return `rgb(${r},${g},${b})`;
}

const numInput =
  "h-7 w-[70px] rounded border border-input bg-background px-2 text-xs tabular-nums disabled:opacity-40";

export function SizeDistributionDialog({ open, onOpenChange }: SizeDistributionDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const setInstance = useAppStore((s) => s.setInstance);

  const [view, setView] = useState<ViewMode>("histogram");
  const [preset, setPreset] = useState<RotationPreset>("Off");
  const [customAngle, setCustomAngle] = useState(45);
  const [bins, setBins] = useState(30);
  const [xMinInput, setXMinInput] = useState("");
  const [xMaxInput, setXMaxInput] = useState("");
  const [selected, setSelected] = useState<SizedInstance | null>(null);

  const angle = presetAngle(preset, customAngle);

  // Instance list is stable across rotation/bin changes (only labels affect it).
  const sized = useMemo<SizedInstance[]>(
    () => (open && labels ? collectSizedInstances(labels) : []),
    [open, labels],
  );

  // Rotated size per instance, aligned with `sized`.
  const rotated = useMemo(
    () => sized.map((si) => rotatedSize(si.rawWidth, si.rawHeight, angle)),
    [sized, angle],
  );

  const summary = useMemo(() => summarizeSizes(rotated), [rotated]);

  // Reset selection when the dialog opens fresh or the dataset changes.
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);
  useEffect(() => {
    setSelected(null);
  }, [labels]);

  const xMinNum = parseAuto(xMinInput);
  const xMaxNum = parseAuto(xMaxInput);
  const histRange =
    xMinNum != null || xMaxNum != null
      ? { min: xMinNum ?? summary.min, max: xMaxNum ?? summary.max }
      : undefined;

  const hist = useMemo(
    () => binSizes(rotated, bins, histRange),
    [rotated, bins, histRange?.min, histRange?.max],
  );

  const n = rotated.length;
  const navigate = (si: SizedInstance) => {
    if (!labels) return;
    setSelected(si);
    setVideo(si.video);
    setFrameIdx(si.frameIdx);
    const lf = labels.find({ video: si.video }).find((f) => f.frameIdx === si.frameIdx);
    setInstance(lf?.instances[si.instanceIdx] ?? null);
  };

  const navigateToBin = (binIdx: number) => {
    const i = rotated.findIndex((sz) => binIndexOf(hist, sz) === binIdx);
    if (i >= 0) navigate(sized[i]);
  };

  const onScatterClick = (e: MouseEvent<SVGGElement>) => {
    const idx = (e.target as SVGElement).getAttribute?.("data-idx");
    if (idx != null) navigate(sized[Number(idx)]);
  };

  // ---- X domain -------------------------------------------------------------
  const [xDomMin, xDomMax] =
    view === "histogram"
      ? [hist.min, hist.max]
      : (() => {
          const span = summary.max - summary.min;
          const m = span > 0 ? span * 0.1 : 10;
          return [Math.max(0, summary.min - m), summary.max + m];
        })();
  const xSpan = xDomMax - xDomMin || 1;
  const xScale = (v: number) => PX0 + ((v - xDomMin) / xSpan) * PLOT_W;

  // ---- Y domain -------------------------------------------------------------
  const maxCount = Math.max(1, ...hist.counts);
  const yTicks = niceTicks(0, view === "histogram" ? maxCount : Math.max(1, n), 5);
  const yDomMax = Math.max(view === "histogram" ? maxCount : n, yTicks.at(-1) ?? 1) || 1;
  const yScale = (v: number) => PY1 - (v / yDomMax) * PLOT_H;

  const xTicks = niceTicks(xDomMin, xDomMax, 6).filter((t) => t >= xDomMin - 1e-9 && t <= xDomMax + 1e-9);

  // Scatter points are memoized independently of `selected` so a click only
  // re-renders the highlight overlay, not all N points.
  const scatterPoints = useMemo(() => {
    if (view !== "scatter" || n === 0) return null;
    const median = summary.median > 0 ? summary.median : 1;
    return rotated.map((sz, i) => (
      <circle
        key={i}
        data-idx={i}
        cx={xScale(sz)}
        cy={yScale(i)}
        r={3}
        fill={sizeColor(sz / median)}
        fillOpacity={0.6}
        style={{ cursor: "pointer" }}
      />
    ));
    // xScale/yScale are derived from these same deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, rotated, summary.median, xDomMin, xDomMax, yDomMax]);

  const selectedIdx = selected ? sized.indexOf(selected) : -1;
  const selectedRotated =
    selected != null ? rotatedSize(selected.rawWidth, selected.rawHeight, angle) : NaN;

  const refLines: [string, number, string, string][] = [
    ["Median", summary.median, C.median, "6 4"],
    ["Mean", summary.mean, C.mean, "2 3"],
    ["Max", summary.max, C.max, ""],
  ];

  const outlierPct = summary.count > 0 ? (100 * summary.outlierCount) / summary.count : 0;
  const statLines: [string, string][] = [
    ["Count", String(summary.count)],
    ["Range", `${fmt0(summary.min)} – ${fmt0(summary.max)} px`],
    ["Mean ± Std", `${fmt0(summary.mean)} ± ${fmt0(summary.std)} px`],
    ["Median", `${fmt0(summary.median)} px`],
    ["90th / 95th / 99th", `${fmt0(summary.p90)} / ${fmt0(summary.p95)} / ${fmt0(summary.p99)} px`],
    ["Outliers (>2σ)", `${summary.outlierCount} (${outlierPct.toFixed(1)}%)`],
  ];

  const histMode = view === "histogram";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Instance Size Distribution</DialogTitle>
          <DialogDescription>
            Bounding-box size (max of width, height) of every labeled instance. Click a{" "}
            {histMode ? "bar" : "point"} to select an example and jump to it.
          </DialogDescription>
        </DialogHeader>

        {summary.count === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No labeled instances to analyze.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Rotation augmentation */}
            <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 px-3 py-2 text-xs">
              <span className="font-medium text-muted-foreground">Rotation augmentation</span>
              <select
                aria-label="Rotation preset"
                className="h-7 rounded border border-input bg-background px-2 text-xs"
                value={preset}
                onChange={(e) => setPreset(e.target.value as RotationPreset)}
              >
                <option value="Off">Off</option>
                <option value="±15">±15°</option>
                <option value="±180">±180°</option>
                <option value="Custom">Custom</option>
              </select>
              <label className="flex items-center gap-1 text-muted-foreground">
                Custom
                <input
                  type="number"
                  aria-label="Custom rotation angle (degrees)"
                  className={numInput}
                  min={0}
                  max={180}
                  value={customAngle}
                  disabled={preset !== "Custom"}
                  onChange={(e) => setCustomAngle(Math.max(0, Math.min(180, Number(e.target.value) || 0)))}
                />
                <span className={preset === "Custom" ? "" : "opacity-40"}>deg</span>
              </label>
            </div>

            {/* View mode + histogram controls */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="size-view"
                  checked={view === "scatter"}
                  onChange={() => setView("scatter")}
                />
                Scatter (clickable)
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="size-view"
                  checked={view === "histogram"}
                  onChange={() => setView("histogram")}
                />
                Histogram
              </label>
              <span className="mx-1 h-4 w-px bg-border" />
              <label className="flex items-center gap-1 text-muted-foreground">
                Bins
                <input
                  type="number"
                  aria-label="Histogram bins"
                  className={numInput}
                  min={5}
                  max={100}
                  value={bins}
                  disabled={!histMode}
                  onChange={(e) => setBins(Math.max(5, Math.min(100, Number(e.target.value) || 30)))}
                />
              </label>
              <label className="flex items-center gap-1 text-muted-foreground">
                X-min
                <input
                  aria-label="Histogram X minimum"
                  className={numInput}
                  placeholder="Auto"
                  value={xMinInput}
                  disabled={!histMode}
                  onChange={(e) => setXMinInput(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-1 text-muted-foreground">
                X-max
                <input
                  aria-label="Histogram X maximum"
                  className={numInput}
                  placeholder="Auto"
                  value={xMaxInput}
                  disabled={!histMode}
                  onChange={(e) => setXMaxInput(e.target.value)}
                />
              </label>
            </div>

            {/* Plot (white background, like the training config window) */}
            <div className="rounded border border-border/60 bg-white">
              <svg
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                className="w-full"
                role="img"
                aria-label={`Instance size ${view}`}
              >
                <title>{`Size ${view} (n=${n})`}</title>
                {/* Title */}
                <text x={VB_W / 2} y={16} textAnchor="middle" fill={C.title} fontSize={12} fontWeight={600}>
                  {histMode ? "Size Histogram" : "Size Distribution"} (n={n})
                </text>

                {/* Y grid + ticks */}
                {yTicks.map((t) => (
                  <g key={`y${t}`}>
                    <line x1={PX0} y1={yScale(t)} x2={PX1} y2={yScale(t)} stroke={C.grid} strokeWidth={1} />
                    <text x={PX0 - 6} y={yScale(t) + 3} textAnchor="end" fill={C.axis} fontSize={9}>
                      {fmt0(t)}
                    </text>
                  </g>
                ))}
                {/* X ticks */}
                {xTicks.map((t) => (
                  <g key={`x${t}`}>
                    <line x1={xScale(t)} y1={PY1} x2={xScale(t)} y2={PY1 + 4} stroke={C.axis} strokeWidth={1} />
                    <text x={xScale(t)} y={PY1 + 15} textAnchor="middle" fill={C.axis} fontSize={9}>
                      {fmt0(t)}
                    </text>
                  </g>
                ))}

                {/* Axis frame */}
                <line x1={PX0} y1={PY0} x2={PX0} y2={PY1} stroke={C.axis} strokeWidth={1} />
                <line x1={PX0} y1={PY1} x2={PX1} y2={PY1} stroke={C.axis} strokeWidth={1} />

                {/* Axis labels */}
                <text x={(PX0 + PX1) / 2} y={VB_H - 4} textAnchor="middle" fill={C.axis} fontSize={10}>
                  Size (pixels)
                </text>
                <text
                  x={14}
                  y={(PY0 + PY1) / 2}
                  textAnchor="middle"
                  fill={C.axis}
                  fontSize={10}
                  transform={`rotate(-90 14 ${(PY0 + PY1) / 2})`}
                >
                  {histMode ? "Count" : "Instance Index"}
                </text>

                {/* Data */}
                {histMode
                  ? hist.counts.map((c, i) => {
                      const x0 = xScale(hist.edges[i]);
                      const x1 = xScale(hist.edges[i + 1]);
                      const y = yScale(c);
                      return (
                        <rect
                          key={i}
                          x={x0}
                          y={y}
                          width={Math.max(0, x1 - x0 - 1)}
                          height={PY1 - y}
                          fill={C.bar}
                          fillOpacity={0.75}
                          stroke="#fff"
                          strokeWidth={0.5}
                          style={{ cursor: "pointer" }}
                          onClick={() => navigateToBin(i)}
                        >
                          <title>{`${fmt(hist.edges[i])}–${fmt(hist.edges[i + 1])} px: ${c}`}</title>
                        </rect>
                      );
                    })
                  : (
                    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
                    <g onClick={onScatterClick}>{scatterPoints}</g>
                  )}

                {/* Selected-point highlight (scatter only) */}
                {!histMode && selectedIdx >= 0 && (
                  <circle
                    cx={xScale(rotated[selectedIdx])}
                    cy={yScale(selectedIdx)}
                    r={6}
                    fill="none"
                    stroke={C.max}
                    strokeWidth={2}
                  />
                )}

                {/* Median / Mean / Max reference lines */}
                {refLines.map(([, v, color, dash]) =>
                  Number.isFinite(v) && v >= xDomMin && v <= xDomMax ? (
                    <line
                      key={color}
                      x1={xScale(v)}
                      y1={PY0}
                      x2={xScale(v)}
                      y2={PY1}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeDasharray={dash || undefined}
                      strokeOpacity={0.8}
                    />
                  ) : null,
                )}

                {/* Legend (top-right) */}
                {refLines.map(([label, v, color, dash], i) => {
                  const ly = PY0 + 8 + i * 15;
                  return (
                    <g key={`leg${color}`}>
                      <line
                        x1={PX1 + 8}
                        y1={ly}
                        x2={PX1 + 24}
                        y2={ly}
                        stroke={color}
                        strokeWidth={1.5}
                        strokeDasharray={dash || undefined}
                      />
                      <text x={PX1 + 28} y={ly + 3} fill={C.axis} fontSize={9}>
                        {label}: {fmt0(v)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Selected instance + statistics */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded border border-border/60 p-3 text-xs">
                <div className="mb-1.5 font-medium text-muted-foreground">Selected instance</div>
                {selected ? (
                  <div className="space-y-0.5 font-mono tabular-nums">
                    <div>Frame: {selected.frameIdx}</div>
                    <div>Instance: {selected.instanceIdx}</div>
                    <div>Video: {selected.videoIdx}</div>
                    <div>
                      Raw size: {fmt(selected.size)} px ({fmt(selected.rawWidth)} × {fmt(selected.rawHeight)})
                    </div>
                    <div>Rotated size: {fmt(selectedRotated)} px</div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">
                    Click a {histMode ? "bar" : "point"} to select and navigate to an instance.
                  </div>
                )}
              </div>

              <div className="rounded border border-border/60 p-3 text-xs">
                <div className="mb-1.5 font-medium text-muted-foreground">Statistics</div>
                <div className="space-y-0.5">
                  {statLines.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-mono tabular-nums">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
