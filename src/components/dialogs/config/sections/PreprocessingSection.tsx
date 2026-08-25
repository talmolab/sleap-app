import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";
import type { ColorMode } from "@/stores/trainingStore";

/**
 * Pre/Post-processing section: image channel-format conversion. Mirrors the
 * legacy dialog's "Convert Colors" control (the section's inference-time
 * post-processing controls — max instances, overlap filtering — have no
 * sleap-nn training key and are intentionally omitted here).
 */
export function PrePostprocessingSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      <Field label="Convert Colors" hint="Convert input images to a specific channel format. Use RGB for pretrained backbones or Grayscale for single-channel videos.">
        <Select
          value={hp.colorMode}
          onValueChange={(v) => onUpdate({ colorMode: v as ColorMode })}
        >
          <SelectTrigger className="h-9 text-sm w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="rgb">RGB</SelectItem>
            <SelectItem value="grayscale">Grayscale</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
