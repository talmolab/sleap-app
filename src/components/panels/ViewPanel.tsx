/**
 * View panel: controls for overlay visibility, styling, colors, and trails.
 */

import { useAppStore } from "../../stores/appStore";
import { PALETTES, rgbToCSS } from "../../lib/colorPalettes";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
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
  storeKey: "showInstances" | "showLabels" | "showEdges" | "showNonVisibleNodes" | "colorPredicted";
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

/** Slider row with label and current value. */
function SliderRow({
  label,
  storeKey,
  min,
  max,
  step = 1,
}: {
  label: string;
  storeKey: "markerSize" | "nodeLabelSize" | "trailLength";
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

export function ViewPanel() {
  const edgeStyle = useAppStore((s) => s.edgeStyle);
  const palette = useAppStore((s) => s.palette);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const trailShade = useAppStore((s) => s.trailShade);
  const set = useAppStore((s) => s.set);
  const bumpOverlay = useAppStore((s) => s.bumpOverlayVersion);

  return (
    <div className="flex flex-col">
      {/* Overlay visibility */}
      <Section title="Overlay">
        <Toggle label="Show instances" storeKey="showInstances" />
        <Toggle label="Show labels" storeKey="showLabels" />
        <Toggle label="Show edges" storeKey="showEdges" />
        <Toggle label="Show non-visible nodes" storeKey="showNonVisibleNodes" />
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
