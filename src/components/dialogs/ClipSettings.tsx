/**
 * Per-video export settings for the focused video: start/end/fps/scale/background.
 * All settings are per-video (design); edits dispatch to the dialog's reducer.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CLIP_SCALE_MIN,
  CLIP_SCALE_MAX,
  type ClipBackground,
  type ClipConfig,
} from "@/lib/videoExport";

interface ClipSettingsProps {
  config: ClipConfig;
  disabled?: boolean;
  onRange: (start: number, end: number) => void;
  onFps: (fps: number) => void;
  onScale: (scale: number) => void;
  onBackground: (bg: ClipBackground) => void;
}

export function ClipSettings({
  config,
  disabled,
  onRange,
  onFps,
  onScale,
  onBackground,
}: ClipSettingsProps) {
  const len = config.video.shape?.[0] ?? 0;
  const maxIdx = Math.max(0, len - 1);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label htmlFor="clip-start">Start frame</Label>
        <Input
          id="clip-start"
          type="number"
          min={0}
          max={maxIdx}
          value={config.start}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onRange(v, config.end);
          }}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="clip-end">End frame</Label>
        <Input
          id="clip-end"
          type="number"
          min={0}
          max={maxIdx}
          value={config.end}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onRange(config.start, v);
          }}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="clip-fps">Frame rate (fps)</Label>
        <Input
          id="clip-fps"
          type="number"
          min={1}
          value={config.fps}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onFps(v);
          }}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="clip-scale">Scale factor</Label>
        <Input
          id="clip-scale"
          type="number"
          min={CLIP_SCALE_MIN}
          max={CLIP_SCALE_MAX}
          step={0.1}
          value={config.scale}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onScale(v);
          }}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="clip-background">Background</Label>
        <Select
          value={config.background}
          onValueChange={(v) => onBackground(v as ClipBackground)}
          disabled={disabled}
        >
          <SelectTrigger id="clip-background" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="original">Original video</SelectItem>
            <SelectItem value="black">Black</SelectItem>
            <SelectItem value="white">White</SelectItem>
            <SelectItem value="grey">Grey</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
