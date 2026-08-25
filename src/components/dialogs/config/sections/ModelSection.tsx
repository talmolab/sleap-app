import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { LogNumberInput } from "@/components/LogNumberInput";
import { ModelStatsPreview } from "@/components/dialogs/ModelStatsPreview";
import { slotToHeadType } from "@/lib/trainingProfiles";
import { Field, Toggle } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";
import type { Backbone, ModelType } from "@/stores/trainingStore";

const BACKBONE_OPTIONS: { value: Backbone; label: string }[] = [
  { value: "unet", label: "UNet" },
  { value: "convnext", label: "ConvNeXt" },
  { value: "swint", label: "Swin Transformer" },
];

/**
 * Model section: backbone architecture + strides/filters, and the head (sigma,
 * output stride) with head-type-conditional loss weights. The loss-weight fields
 * shown depend on slotToHeadType(modelType, slot), mirroring the legacy dialog.
 * (Training-mode lock and the anchor-part picker are supplied by the host, not
 * here, since they need checkpoint/skeleton context.)
 */
export function ModelSection({ hp, onUpdate, slot, modelType }: SectionRenderCtx) {
  const headType = slotToHeadType((modelType ?? "top_down") as ModelType, slot ?? "");

  return (
    <div className="max-w-xl">
      <ModelStatsPreview
        hp={hp}
        maxStride={hp.maxStride}
        filters={hp.filters}
        filtersRate={hp.filtersRate}
        outputStride={hp.outputStride}
        stemStride={hp.stemStride}
        backbone={hp.backbone || "unet"}
        slot={slot ?? ""}
      />

      <Field label="Backbone" hint="Select the backbone architecture. UNet is the default and works well for most cases. ConvNeXt and Swin Transformer support pretrained ImageNet weights but require RGB images.">
        <Select value={hp.backbone || ""} onValueChange={(v) => onUpdate({ backbone: v as Backbone })}>
          <SelectTrigger className="h-9 text-sm w-48"><SelectValue placeholder="From config…" /></SelectTrigger>
          <SelectContent>
            {BACKBONE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      <Separator className="my-3" />

      <Field label="Stem Stride" hint="If not None, controls how many stem blocks to use for initial downsampling. Useful for learned downsampling that retains spatial information while reducing large input sizes.">
        <div className="flex items-center gap-2">
          <Input type="number" value={hp.stemStride ?? ""} disabled={hp.stemStride === null} placeholder="0"
            className="h-9 text-sm w-20"
            onChange={(e) => onUpdate({ stemStride: e.target.value ? Number(e.target.value) : null })} />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={hp.stemStride === null} className="accent-primary"
              onChange={(e) => onUpdate({ stemStride: e.target.checked ? null : 0 })} />
            None
          </label>
        </div>
      </Field>

      <Field label="Max Stride" hint="Determines the number of downsampling blocks in the network, increasing receptive field size at the cost of network size.">
        <Select value={String(hp.maxStride)} onValueChange={(v) => onUpdate({ maxStride: Number(v) })}>
          <SelectTrigger className="h-9 text-sm w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2, 4, 8, 16, 32, 64, 128].map((v) => <SelectItem key={v} value={String(v)}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Filters" hint="Base number of filters in the network.">
        <Input type="number" value={hp.filters} className="h-9 text-sm w-24"
          onChange={(e) => onUpdate({ filters: Number(e.target.value) })} />
      </Field>

      <Field label="Filters Rate" hint="Factor to scale the number of filters by at each block.">
        <Input type="number" value={hp.filtersRate} step={0.1} className="h-9 text-sm w-24"
          onChange={(e) => onUpdate({ filtersRate: Number(e.target.value) })} />
      </Field>

      <Toggle label="Middle Block" checked={hp.middleBlock}
        onChange={(v) => onUpdate({ middleBlock: v })}
        hint="If enabled, adds an intermediate block between the downsampling and upsampling branch for additional processing at the largest receptive field size." />

      <Toggle label="Up Interpolate" checked={hp.upInterpolate}
        onChange={(v) => onUpdate({ upInterpolate: v })}
        hint="If enabled, use bilinear upsampling instead of transposed convolutions. This can save computations but may lower overall accuracy." />

      <Separator className="my-3" />
      <h4 className="text-sm font-medium text-muted-foreground mb-2">Head</h4>

      <Field label="Sigma" hint="Spread of the Gaussian distribution of the confidence maps, in pixels of the (scaled) model input. Smaller is more precise but harder to learn; larger is easier to learn but less precise.">
        <Input type="number" value={hp.sigma} min={0.5} max={30} step={0.5} className="h-9 text-sm w-24"
          onChange={(e) => onUpdate({ sigma: Number(e.target.value) })} />
      </Field>

      <Field label="Output Stride" hint="The stride of the output confidence maps relative to the input image (reciprocal of resolution). Increasing it speeds up performance and decreases memory, at the cost of spatial resolution.">
        <Select value={String(hp.outputStride)} onValueChange={(v) => onUpdate({ outputStride: Number(v) })}>
          <SelectTrigger className="h-9 text-sm w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[1, 2, 4, 8, 16, 32, 64].map((v) => <SelectItem key={v} value={String(v)}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      {headType === "bottomup" && (
        <>
          <Field label="Confmaps Loss Weight" hint="Loss weight for the confidence maps head. Increase to prioritize this head during multi-head training.">
            <LogNumberInput value={hp.confmapsLossWeight} onChange={(v) => onUpdate({ confmapsLossWeight: v })} className="h-9 text-sm" />
          </Field>
          <Field label="PAFs Loss Weight" hint="Loss weight for the part affinity fields head. Increase to prioritize this head during multi-head training.">
            <LogNumberInput value={hp.pafsLossWeight} onChange={(v) => onUpdate({ pafsLossWeight: v })} className="h-9 text-sm" />
          </Field>
        </>
      )}
      {headType === "multi_class_topdown" && (
        <>
          <Field label="Confmaps Loss Weight" hint="Loss weight for the confidence maps head. Increase to prioritize this head during multi-head training.">
            <LogNumberInput value={hp.confmapsLossWeight} onChange={(v) => onUpdate({ confmapsLossWeight: v })} className="h-9 text-sm" />
          </Field>
          <Field label="Class Vectors Loss Weight" hint="Loss weight for the classification head. Increase to prioritize this head during multi-head training.">
            <LogNumberInput value={hp.classLossWeight} onChange={(v) => onUpdate({ classLossWeight: v })} className="h-9 text-sm" />
          </Field>
        </>
      )}
      {headType === "multi_class_bottomup" && (
        <>
          <Field label="Confmaps Loss Weight" hint="Loss weight for the confidence maps head. Increase to prioritize this head during multi-head training.">
            <LogNumberInput value={hp.confmapsLossWeight} onChange={(v) => onUpdate({ confmapsLossWeight: v })} className="h-9 text-sm" />
          </Field>
          <Field label="Class Maps Loss Weight" hint="Loss weight for the classification maps head. Increase to prioritize this head during multi-head training.">
            <LogNumberInput value={hp.classLossWeight} onChange={(v) => onUpdate({ classLossWeight: v })} className="h-9 text-sm" />
          </Field>
        </>
      )}
    </div>
  );
}
