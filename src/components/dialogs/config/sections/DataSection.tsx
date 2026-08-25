import { Input } from "@/components/ui/input";
import { Field, Toggle } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";

/**
 * Data section: validation split, overfit mode (train=val), reproducible-split
 * seed, input rescaling, and per-instance crop size. Validation Fraction dims
 * and disables while Overfit Mode is on; Random Seed and Crop Size are nullable
 * — an "Auto" checkbox clears them (Auto seed = random each run, Auto crop =
 * computed from the data), mirroring the legacy dialog.
 */
export function DataSection({ hp, onUpdate, slot }: SectionRenderCtx) {
  // Crop size is a per-instance crop; it does not apply to the centroid head.
  const showCropSize = slot !== "centroid";
  return (
    <div className="max-w-xl">
      <div className={hp.overfitMode ? "opacity-50" : ""}>
        <Field label="Validation Fraction" hint='Fraction of labeled frames to use as a validation set. Ignored if "Overfit Mode" is enabled.'>
          <Input type="number" value={hp.validationFraction} min={0} max={1} step={0.05} disabled={hp.overfitMode}
            className="h-9 text-sm w-28"
            onChange={(e) => onUpdate({ validationFraction: Number(e.target.value) })} />
        </Field>
      </div>

      <Toggle label="Overfit Mode (train=val)" checked={hp.overfitMode}
        onChange={(v) => onUpdate({ overfitMode: v })}
        hint="If enabled, the same data will be used for both training and validation. This is useful for intentional overfitting on small datasets (fewer than 10 labeled frames) to test model capacity." />

      <Field label="Random Seed" hint="Random seed for reproducible train/validation data splits. Leave empty (Auto) for random seed each run.">
        <div className="flex items-center gap-2">
          <Input type="number" value={hp.randomSeed ?? ""} disabled={hp.randomSeed === null}
            placeholder="0" className="h-9 text-sm w-28"
            onChange={(e) => onUpdate({ randomSeed: e.target.value ? Number(e.target.value) : null })} />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={hp.randomSeed === null} className="accent-primary"
              onChange={(e) => onUpdate({ randomSeed: e.target.checked ? null : 0 })} />
            Auto
          </label>
        </div>
      </Field>

      <Field label="Input Scaling" hint="Rescaling factor applied to input images before training. Values less than 1.0 downsample the image, which reduces memory usage and speeds up training at the cost of spatial resolution. Note that crop size and sigma values are relative to the scaled image.">
        <Input type="number" value={hp.scale} min={0.125} max={1} step={0.125} className="h-9 text-sm w-28"
          onChange={(e) => onUpdate({ scale: Number(e.target.value) })} />
      </Field>

      {showCropSize && (
        <Field label="Crop Size" hint="Bounding box crop size around each instance in pixels. Set to 'Auto' to compute from the data (largest instance bounding box, aligned to max_stride).">
          <div className="flex items-center gap-2">
            <Input type="number" value={hp.cropSize ?? ""} disabled={hp.cropSize === null}
              className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ cropSize: e.target.value ? Number(e.target.value) : null })} />
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={hp.cropSize === null} className="accent-primary"
                onChange={(e) => onUpdate({ cropSize: e.target.checked ? null : 256 })} />
              Auto
            </label>
          </div>
        </Field>
      )}
    </div>
  );
}
