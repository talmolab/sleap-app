/**
 * Overlay and motion-trail options for exported clips (all clips), as in
 * PyQt's render dialog: marker shape and size, line width, opacity, which
 * parts to draw, and the Motion Trails group.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/NumberInput";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MarkerShape } from "@/canvas/SkeletonRenderer";
import {
  CLIP_MARKER_SHAPES,
  CLIP_TRAIL_COLORS,
  type ClipOverlayStyle,
} from "@/lib/videoExport";

interface ClipOverlaySettingsProps {
  style: ClipOverlayStyle;
  /** Skeleton node names, for the trail node picker. */
  nodeNames: string[];
  /** Trails follow tracks, so they are unavailable in an untracked project. */
  hasTracks: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<ClipOverlayStyle>) => void;
}

const MATCH_POSES = "__match__";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Check({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

export function ClipOverlaySettings({ style, nodeNames, hasTracks, disabled, onChange }: ClipOverlaySettingsProps) {
  const trailsOff = disabled || !style.showTrails || !hasTracks;
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <p className="text-sm font-medium">Overlay (all clips)</p>
      <div className="grid grid-cols-2 gap-3">
        <Field id="clip-marker-shape" label="Marker">
          <Select
            value={style.markerShape}
            onValueChange={(v) => onChange({ markerShape: v as MarkerShape })}
            disabled={disabled}
          >
            <SelectTrigger id="clip-marker-shape" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLIP_MARKER_SHAPES.map((s) => (
                <SelectItem key={s} value={s}>
                  {capitalize(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="clip-marker-size" label="Marker size (px)">
          <NumberInput
            id="clip-marker-size"
            min={1}
            max={30}
            step={0.5}
            value={style.markerSize}
            onCommit={(markerSize) => onChange({ markerSize })}
            disabled={disabled}
          />
        </Field>
        <Field id="clip-line-width" label="Line width (px)">
          <NumberInput
            id="clip-line-width"
            min={0.5}
            max={15}
            step={0.5}
            value={style.lineWidth}
            onCommit={(lineWidth) => onChange({ lineWidth })}
            disabled={disabled}
          />
        </Field>
        <Field id="clip-pose-opacity" label="Opacity (0.1–1)">
          <NumberInput
            id="clip-pose-opacity"
            min={0.1}
            max={1}
            step={0.1}
            value={style.poseOpacity}
            onCommit={(poseOpacity) => onChange({ poseOpacity })}
            disabled={disabled}
          />
        </Field>
        <div className="col-span-2 flex items-center gap-4">
          <span className="text-sm">Show:</span>
          <Check
            id="clip-show-nodes"
            label="Nodes"
            checked={style.showNodes}
            disabled={disabled}
            onChange={(showNodes) => onChange({ showNodes })}
          />
          <Check
            id="clip-show-edges"
            label="Edges"
            checked={style.showEdges}
            disabled={disabled}
            onChange={(showEdges) => onChange({ showEdges })}
          />
        </div>
      </div>

      <p className="text-sm font-medium">Motion trails</p>
      <Check
        id="clip-show-trails"
        label="Show motion trails"
        checked={style.showTrails && hasTracks}
        disabled={disabled || !hasTracks}
        onChange={(showTrails) => onChange({ showTrails })}
      />
      {!hasTracks && (
        <p className="text-xs text-muted-foreground">Trails follow tracks; this project has none.</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field id="clip-trail-length" label="Length (frames)">
          <NumberInput
            id="clip-trail-length"
            min={1}
            max={1000}
            integer
            value={style.trailLength}
            onCommit={(trailLength) => onChange({ trailLength })}
            disabled={trailsOff}
          />
        </Field>
        <Field id="clip-trail-node" label="Node">
          <Select
            value={style.trailNode === "centroid" || nodeNames.includes(style.trailNode) ? style.trailNode : "centroid"}
            onValueChange={(trailNode) => onChange({ trailNode })}
            disabled={trailsOff}
          >
            <SelectTrigger id="clip-trail-node" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="centroid">Centroid</SelectItem>
              {nodeNames.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="clip-trail-width" label="Width (px)">
          <NumberInput
            id="clip-trail-width"
            min={0.5}
            max={15}
            step={0.5}
            value={style.trailWidth}
            onCommit={(trailWidth) => onChange({ trailWidth })}
            disabled={trailsOff}
          />
        </Field>
        <Field id="clip-trail-opacity" label="Opacity (0–1)">
          <NumberInput
            id="clip-trail-opacity"
            min={0}
            max={1}
            step={0.1}
            value={style.trailAlpha}
            onCommit={(trailAlpha) => onChange({ trailAlpha })}
            disabled={trailsOff}
          />
        </Field>
        <Field id="clip-trail-color" label="Color">
          <Select
            value={style.trailColor ?? MATCH_POSES}
            onValueChange={(v) => onChange({ trailColor: v === MATCH_POSES ? null : v })}
            disabled={trailsOff}
          >
            <SelectTrigger id="clip-trail-color" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MATCH_POSES}>Match poses</SelectItem>
              {Object.keys(CLIP_TRAIL_COLORS).map((c) => (
                <SelectItem key={c} value={c}>
                  {capitalize(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-end pb-2">
          <Check
            id="clip-trail-fade"
            label="Fade older segments"
            checked={style.trailFade}
            disabled={trailsOff}
            onChange={(trailFade) => onChange({ trailFade })}
          />
        </div>
      </div>
    </div>
  );
}
