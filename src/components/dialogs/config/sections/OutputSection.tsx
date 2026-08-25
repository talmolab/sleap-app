import { Input } from "@/components/ui/input";
import { Field } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";

/**
 * Output section: run name, checkpoint saving (best/latest), and prediction
 * visualization. "Keep Viz Images" only has an effect when "Visualize
 * Predictions" is on, so it's disabled and dimmed until then — mirroring the
 * legacy dialog's Output section.
 */
export function OutputSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      <Field label="Run Name" hint="Name for this training run. Leave empty to auto-generate from timestamp and head type.">
        <Input type="text" value={hp.runName} placeholder="Auto-generated" className="h-9 text-sm"
          onChange={(e) => onUpdate({ runName: e.target.value })} />
      </Field>

      <Field label="Checkpoint" hint="Best Model saves the highest-scoring checkpoint (by validation loss). Latest Model also saves a last.ckpt after every checkpoint, useful for resuming training.">
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={hp.saveBestModel} className="accent-primary"
              onChange={(e) => onUpdate({ saveBestModel: e.target.checked })} />
            <span className="text-sm">Best Model</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={hp.saveLastModel} className="accent-primary"
              onChange={(e) => onUpdate({ saveLastModel: e.target.checked })} />
            <span className="text-sm">Latest Model</span>
          </label>
        </div>
      </Field>

      <Field label="Visualization" hint="Visualize Predictions saves sample prediction images each epoch (used by this app's epoch scrubber to review training progress). Keep Viz Images keeps that folder after training instead of deleting it; only has an effect when Visualize Predictions is on.">
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={hp.visualizePredictions} className="accent-primary"
              onChange={(e) => onUpdate({ visualizePredictions: e.target.checked })} />
            <span className="text-sm">Visualize Predictions</span>
          </label>
          <label className={`flex items-center gap-1.5 ${hp.visualizePredictions ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
            <input type="checkbox" checked={hp.keepVizImages} disabled={!hp.visualizePredictions} className="accent-primary"
              onChange={(e) => onUpdate({ keepVizImages: e.target.checked })} />
            <span className="text-sm">Keep Viz Images</span>
          </label>
        </div>
      </Field>
    </div>
  );
}
