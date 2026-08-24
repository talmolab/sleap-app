/**
 * View panel: controls for overlay visibility, styling, colors, trails,
 * and intensity histogram with LUT adjustment.
 */

import { useAppStore } from "../../stores/appStore";
import { PALETTES, rgbToCSS } from "../../lib/colorPalettes";
import { COLORMAPS } from "../../lib/colormaps";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { QC_MODE_CHOICES } from "@/lib/instanceVisibility";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useRef, useEffect, useCallback } from "react";
import type { EdgeStyle, ColorTarget } from "../../types";

/** Collapsible section with chevron indicator. */
function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform",
            open && "rotate-90"
          )}
        />
        {title}
      </button>
      {open && <div className="px-2 pb-2 space-y-2">{children}</div>}
    </div>
  );
}

/** Toggle row with label and checkbox. */
function Toggle({
  label,
  storeKey,
}: {
  label: string;
  storeKey:
    | "showInstances"
    | "showLabels"
    | "showEdges"
    | "showNonVisibleNodes"
    | "colorPredicted"
    | "showInset";
}) {
  const value = useAppStore((s) => s[storeKey]) as boolean;
  const toggle = useAppStore((s) => s.toggle);
  const bumpOverlay = useAppStore((s) => s.bumpOverlayVersion);

  return (
    <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
      <input
        type="checkbox"
        checked={value}
        onChange={() => {
          toggle(storeKey);
          bumpOverlay();
        }}
        className="accent-primary h-3.5 w-3.5"
      />
      {label}
    </label>
  );
}

/** Label-QC display-mode selector. Overwrites the per-instance visibility
 *  columns while a non-manual mode is active (see useQcVisibility). Built from
 *  QC_MODE_CHOICES so it can never drift from the View-menu submenu. */
function DisplayModeSelect() {
  const qcDisplayMode = useAppStore((s) => s.qcDisplayMode);
  const setQcDisplayMode = useAppStore((s) => s.setQcDisplayMode);

  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">Display</span>
      <Select
        value={qcDisplayMode}
        onValueChange={(v) => setQcDisplayMode(v as typeof qcDisplayMode)}
      >
        <SelectTrigger size="sm" className="h-7 text-xs w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {QC_MODE_CHOICES.map(([label, mode]) => (
            <SelectItem key={mode} value={mode}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Slider row with label and current value. */
function SliderRow({
  label,
  storeKey,
  min,
  max,
  step = 1,
}: {
  label: string;
  storeKey: "markerSize" | "nodeLabelSize" | "insetSize" | "insetZoom" | "trailLength";
  min: number;
  max: number;
  step?: number;
}) {
  const value = useAppStore((s) => s[storeKey]) as number;
  const set = useAppStore((s) => s.set);
  const bumpOverlay = useAppStore((s) => s.bumpOverlayVersion);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs tabular-nums text-foreground w-6 text-right">
          {value}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => {
          set(storeKey, v);
          bumpOverlay();
        }}
      />
    </div>
  );
}

const HIST_WIDTH = 200;
const HIST_HEIGHT = 60;

/** Intensity histogram with draggable LUT min/max handles. */
function IntensityHistogram() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const histogram = useAppStore((s) => s.frameHistogram);
  const lutMin = useAppStore((s) => s.lutMin);
  const lutMax = useAppStore((s) => s.lutMax);
  const set = useAppStore((s) => s.set);

  const [dragging, setDragging] = useState<"min" | "max" | null>(null);

  // Draw histogram with LUT range overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, HIST_WIDTH, HIST_HEIGHT);

    if (!histogram) {
      ctx.fillStyle = "rgba(128, 128, 128, 0.3)";
      ctx.fillRect(0, 0, HIST_WIDTH, HIST_HEIGHT);
      return;
    }

    // Find max count for normalization (skip 0 and 255 which are often outliers)
    let maxCount = 0;
    for (let i = 1; i < 255; i++) {
      if (histogram[i] > maxCount) maxCount = histogram[i];
    }
    if (maxCount === 0) maxCount = 1;

    // Draw outside-range shading
    const minX = (lutMin / 255) * HIST_WIDTH;
    const maxX = (lutMax / 255) * HIST_WIDTH;
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, minX, HIST_HEIGHT);
    ctx.fillRect(maxX, 0, HIST_WIDTH - maxX, HIST_HEIGHT);

    // Draw histogram bars
    const barWidth = HIST_WIDTH / 256;
    for (let i = 0; i < 256; i++) {
      const h = Math.min((histogram[i] / maxCount) * HIST_HEIGHT, HIST_HEIGHT);
      const x = (i / 255) * HIST_WIDTH;
      const inRange = i >= lutMin && i <= lutMax;
      ctx.fillStyle = inRange ? "rgba(180, 180, 255, 0.7)" : "rgba(100, 100, 100, 0.5)";
      ctx.fillRect(x, HIST_HEIGHT - h, barWidth + 0.5, h);
    }

    // Draw LUT min/max lines
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(minX, 0);
    ctx.lineTo(minX, HIST_HEIGHT);
    ctx.stroke();

    ctx.strokeStyle = "#4ecdc4";
    ctx.beginPath();
    ctx.moveTo(maxX, 0);
    ctx.lineTo(maxX, HIST_HEIGHT);
    ctx.stroke();
  }, [histogram, lutMin, lutMax]);

  const getIntensityFromX = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.round(Math.max(0, Math.min(255, (x / rect.width) * 255)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const intensity = getIntensityFromX(e.clientX);
    const distToMin = Math.abs(intensity - lutMin);
    const distToMax = Math.abs(intensity - lutMax);
    setDragging(distToMin <= distToMax ? "min" : "max");
  }, [lutMin, lutMax, getIntensityFromX]);

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: MouseEvent) => {
      const intensity = getIntensityFromX(e.clientX);
      if (dragging === "min") {
        set("lutMin", Math.min(intensity, lutMax - 1));
      } else {
        set("lutMax", Math.max(intensity, lutMin + 1));
      }
    };

    const handleUp = () => setDragging(null);

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [dragging, lutMin, lutMax, set, getIntensityFromX]);

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={HIST_WIDTH}
        height={HIST_HEIGHT}
        className="w-full rounded border border-border cursor-ew-resize"
        style={{ height: HIST_HEIGHT }}
        onMouseDown={handleMouseDown}
      />
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Min</span>
          <input
            type="number"
            min={0}
            max={254}
            value={lutMin}
            onChange={(e) => set("lutMin", Math.min(Number(e.target.value) || 0, lutMax - 1))}
            className="w-12 h-6 text-xs tabular-nums bg-background border border-border rounded px-1 text-foreground"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Max</span>
          <input
            type="number"
            min={1}
            max={255}
            value={lutMax}
            onChange={(e) => set("lutMax", Math.max(Number(e.target.value) || 255, lutMin + 1))}
            className="w-12 h-6 text-xs tabular-nums bg-background border border-border rounded px-1 text-foreground"
          />
        </div>
        <Button
          variant="subtle"
          size="xs"
          className="ml-auto text-[10px] h-6"
          onClick={() => {
            set("lutMin", 0);
            set("lutMax", 255);
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

/** Colormap gradient swatch. */
function ColormapSwatch({ name }: { name: string }) {
  const lut = COLORMAPS[name];
  if (!lut) {
    // Grayscale
    return (
      <div
        className="w-16 h-3 rounded-sm border border-border"
        style={{ background: "linear-gradient(to right, #000, #fff)" }}
      />
    );
  }
  // Sample 8 evenly spaced colors
  const stops = Array.from({ length: 8 }, (_, i) => {
    const idx = Math.round((i / 7) * 255);
    const c = lut[idx];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  });
  return (
    <div
      className="w-16 h-3 rounded-sm border border-border"
      style={{ background: `linear-gradient(to right, ${stops.join(", ")})` }}
    />
  );
}

const ROTATIONS = [0, 90, 180, 270] as const;

export function ViewPanel() {
  const edgeStyle = useAppStore((s) => s.edgeStyle);
  const palette = useAppStore((s) => s.palette);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const trailShade = useAppStore((s) => s.trailShade);
  const currentColormap = useAppStore((s) => s.colormap);
  const rotation = useAppStore((s) => s.rotation);
  const set = useAppStore((s) => s.set);
  const bumpOverlay = useAppStore((s) => s.bumpOverlayVersion);

  return (
    <div className="flex flex-col">
      {/* Intensity histogram and LUT */}
      <Section title="Intensity">
        <IntensityHistogram />
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Colormap</span>
          <Select
            value={currentColormap}
            onValueChange={(v) => set("colormap", v)}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(COLORMAPS).map((name) => (
                <SelectItem key={name} value={name}>
                  <div className="flex items-center gap-2">
                    <ColormapSwatch name={name} />
                    <span>{name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Section>

      {/* Rotation */}
      <Section title="Rotation" defaultOpen={false}>
        <div className="flex gap-1">
          {ROTATIONS.map((deg) => (
            <Button
              key={deg}
              variant={rotation === deg ? "default" : "subtle"}
              size="xs"
              className="text-[10px] h-6 flex-1"
              onClick={() => set("rotation", deg)}
            >
              {deg}°
            </Button>
          ))}
        </div>
      </Section>

      {/* Overlay visibility */}
      <Section title="Overlay">
        <Toggle label="Show instances" storeKey="showInstances" />
        <Toggle label="Show labels" storeKey="showLabels" />
        <Toggle label="Show edges" storeKey="showEdges" />
        <Toggle label="Show non-visible nodes" storeKey="showNonVisibleNodes" />
        <DisplayModeSelect />
      </Section>

      {/* Style settings */}
      <Section title="Style">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Edge style</span>
          <Select
            value={edgeStyle}
            onValueChange={(v) => {
              set("edgeStyle", v as EdgeStyle);
              bumpOverlay();
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Line">Line</SelectItem>
              <SelectItem value="Wedge">Wedge</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <SliderRow label="Marker size" storeKey="markerSize" min={1} max={20} />
        <SliderRow label="Label size" storeKey="nodeLabelSize" min={0} max={20} />
        <Toggle label="Show magnifier" storeKey="showInset" />
        <SliderRow label="Inset size" storeKey="insetSize" min={100} max={800} step={10} />
        <SliderRow label="Inset zoom" storeKey="insetZoom" min={1} max={20} />
      </Section>

      {/* Color settings */}
      <Section title="Color">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Palette</span>
          <Select
            value={palette}
            onValueChange={(v) => {
              set("palette", v);
              bumpOverlay();
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PALETTES).map(([name, colors]) => (
                <SelectItem key={name} value={name}>
                  <div className="flex items-center gap-2">
                    <div className="flex gap-0.5">
                      {colors.slice(0, 5).map((c, i) => (
                        <div
                          key={i}
                          className="w-2.5 h-2.5 rounded-sm"
                          style={{ backgroundColor: rgbToCSS(c) }}
                        />
                      ))}
                    </div>
                    <span>{name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Color by</span>
          <Select
            value={distinctlyColor}
            onValueChange={(v) => {
              set("distinctlyColor", v as ColorTarget);
              bumpOverlay();
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (Node / Track)</SelectItem>
              <SelectItem value="instance">Instance</SelectItem>
              <SelectItem value="track">Track</SelectItem>
              <SelectItem value="node">Node</SelectItem>
              <SelectItem value="edge">Edge</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Toggle label="Color predicted instances" storeKey="colorPredicted" />
      </Section>

      {/* Trail settings */}
      <Section title="Trail">
        <SliderRow label="Trail length" storeKey="trailLength" min={0} max={50} />
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Trail shade</span>
          <Select
            value={trailShade}
            onValueChange={(v) => {
              set("trailShade", v);
              bumpOverlay();
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Normal">Normal</SelectItem>
              <SelectItem value="Light">Light</SelectItem>
              <SelectItem value="Dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>
    </div>
  );
}
