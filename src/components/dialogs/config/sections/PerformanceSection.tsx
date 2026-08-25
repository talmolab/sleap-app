import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Field } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";
import type { DataPipeline } from "@/stores/trainingStore";

/**
 * Performance section: data-loading pipeline, dataloader worker count, and
 * training accelerator/device selection. The Number of Devices input is
 * disabled (and reads 1) while "Auto" is checked, mirroring the legacy dialog.
 */
export function PerformanceSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      <Field label="Data Pipeline" hint="How training data is loaded. 'Cache in Memory' is fastest but uses more RAM. 'Stream' reads from disk each epoch. 'Cache to Disk' saves processed data to disk.">
        <Select value={hp.dataPipeline} onValueChange={(v) => onUpdate({ dataPipeline: v as DataPipeline })}>
          <SelectTrigger className="h-9 text-sm w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="stream">Stream (no caching)</SelectItem>
            <SelectItem value="memory">Cache in Memory</SelectItem>
            <SelectItem value="disk">Cache to Disk</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Dataloader Workers" hint="Number of parallel workers for loading training data. More workers = faster data loading but more CPU/memory usage. 0 = main thread only. Only takes effect with a caching pipeline (Cache in Memory / Cache to Disk); the Stream pipeline forces 0.">
        <Input type="number" value={hp.dataloaderWorkers} min={0} max={16} className="h-9 text-sm w-16"
          onChange={(e) => onUpdate({ dataloaderWorkers: Number(e.target.value) })} />
      </Field>

      <Field label="Accelerator" hint="Hardware to use for training. 'Auto' detects available hardware. Use 'cuda' for NVIDIA GPUs, 'mps' for Apple Silicon, or 'cpu' for CPU-only (slow).">
        <Select value={hp.accelerator} onValueChange={(v) => onUpdate({ accelerator: v as "auto" | "cuda" | "mps" | "cpu" })}>
          <SelectTrigger className="h-9 text-sm w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">auto</SelectItem>
            <SelectItem value="cuda">cuda</SelectItem>
            <SelectItem value="mps">mps</SelectItem>
            <SelectItem value="cpu">cpu</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Number of Devices" hint="Number of GPUs/devices to use for training. Set to 1 for single-GPU training.">
        <div className="flex items-center gap-2">
          <Input type="number" value={hp.numDevices === "auto" ? 1 : hp.numDevices} min={1} max={8}
            disabled={hp.numDevices === "auto"} className="h-9 text-sm w-16"
            onChange={(e) => onUpdate({ numDevices: Math.max(1, Number(e.target.value)) })} />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={hp.numDevices === "auto"} className="accent-primary"
              onChange={(e) => onUpdate({ numDevices: e.target.checked ? "auto" : 1 })} />
            Auto
          </label>
        </div>
      </Field>
    </div>
  );
}
