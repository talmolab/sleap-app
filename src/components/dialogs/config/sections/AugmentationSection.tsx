import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, Toggle } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";

/**
 * Augmentation section: rotation preset (with a custom-angle reveal) plus the
 * scale / uniform-noise / gaussian-noise / contrast / brightness augmentations,
 * each gated behind an enable toggle whose sub-fields reveal when it's on —
 * mirroring the legacy dialog's per-augmentation controls.
 */
export function AugmentationSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      {/* Rotation */}
      <Field label="Rotation" hint="Rotation augmentation range. Off: disabled. ±15°: for side-view cameras where upside-down would be unnatural. ±180°: for top-view/overhead cameras where all orientations are valid.">
        <Select value={hp.rotationPreset} onValueChange={(v) => onUpdate({ rotationPreset: v as "off" | "15" | "180" | "custom" })}>
          <SelectTrigger className="h-9 text-sm w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="15">&plusmn;15&deg;</SelectItem>
            <SelectItem value="180">&plusmn;180&deg;</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {hp.rotationPreset === "custom" && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Angle (±°)">
            <Input type="number" value={hp.rotationCustomAngle} min={0} max={180} step={1} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ rotationCustomAngle: Number(e.target.value) })} />
          </Field>
        </div>
      )}

      {/* Scale */}
      <Toggle label="Scale" checked={hp.scaleEnabled}
        onChange={(v) => onUpdate({ scaleEnabled: v })}
        hint="Enable random scaling augmentation. Scaling is applied independently with 100% probability when enabled." />
      {hp.scaleEnabled && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Scale Min">
            <Input type="number" value={hp.scaleMin} min={0.1} max={2} step={0.05} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ scaleMin: Number(e.target.value) })} />
          </Field>
          <Field label="Scale Max">
            <Input type="number" value={hp.scaleMax} min={0.1} max={2} step={0.05} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ scaleMax: Number(e.target.value) })} />
          </Field>
        </div>
      )}

      {/* Uniform Noise */}
      <Toggle label="Uniform Noise" checked={hp.uniformNoiseEnabled}
        onChange={(v) => onUpdate({ uniformNoiseEnabled: v })}
        hint="Enable uniformly distributed noise augmentation." />
      {hp.uniformNoiseEnabled && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Min Val">
            <Input type="number" value={hp.uniformNoiseMin} min={0} max={1} step={0.01} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ uniformNoiseMin: Number(e.target.value) })} />
          </Field>
          <Field label="Max Val">
            <Input type="number" value={hp.uniformNoiseMax} min={0} max={1} step={0.01} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ uniformNoiseMax: Number(e.target.value) })} />
          </Field>
        </div>
      )}

      {/* Gaussian Noise */}
      <Toggle label="Gaussian Noise" checked={hp.gaussianNoiseEnabled}
        onChange={(v) => onUpdate({ gaussianNoiseEnabled: v })}
        hint="Enable normally distributed noise augmentation. This is applied independently to each pixel." />
      {hp.gaussianNoiseEnabled && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Mean">
            <Input type="number" value={hp.gaussianNoiseMean} step={0.01} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ gaussianNoiseMean: Number(e.target.value) })} />
          </Field>
          <Field label="Std Dev">
            <Input type="number" value={hp.gaussianNoiseStd} step={0.01} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ gaussianNoiseStd: Number(e.target.value) })} />
          </Field>
        </div>
      )}

      {/* Contrast */}
      <Toggle label="Contrast" checked={hp.contrastEnabled}
        onChange={(v) => onUpdate({ contrastEnabled: v })}
        hint="Enable gamma contrast adjustment. This scales all pixel values by x^gamma where x is in [0, 1]." />
      {hp.contrastEnabled && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Contrast Min">
            <Input type="number" value={hp.contrastMin} min={0.5} max={2} step={0.05} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ contrastMin: Number(e.target.value) })} />
          </Field>
          <Field label="Contrast Max">
            <Input type="number" value={hp.contrastMax} min={0.5} max={2} step={0.05} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ contrastMax: Number(e.target.value) })} />
          </Field>
        </div>
      )}

      {/* Brightness */}
      <Toggle label="Brightness" checked={hp.brightnessEnabled}
        onChange={(v) => onUpdate({ brightnessEnabled: v })}
        hint="Enable brightness augmentation. This adds the same value to all pixels to simulate illumination change." />
      {hp.brightnessEnabled && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Brightness Min">
            <Input type="number" value={hp.brightnessMin} step={0.01} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ brightnessMin: Number(e.target.value) })} />
          </Field>
          <Field label="Brightness Max">
            <Input type="number" value={hp.brightnessMax} step={0.01} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ brightnessMax: Number(e.target.value) })} />
          </Field>
        </div>
      )}
    </div>
  );
}
