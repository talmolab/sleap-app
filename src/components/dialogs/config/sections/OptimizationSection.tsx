import { Input } from "@/components/ui/input";
import { Field, Toggle } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";

/**
 * Optimization section: batch/epochs/LR, plateau early-stopping, and online hard
 * keypoint mining (OHKM). Sub-fields reveal when their toggle is on, mirroring
 * the legacy dialog.
 */
export function OptimizationSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      <Field label="Batch Size" hint="Number of examples per minibatch. Higher can improve generalization at the cost of more GPU memory; lower may overfit but helps optimization with few varied examples.">
        <Input type="number" value={hp.batchSize} min={1} step={1} className="h-9 text-sm w-28"
          onChange={(e) => onUpdate({ batchSize: Number(e.target.value) })} />
      </Field>

      <Field label="Epochs" hint="Maximum number of epochs to train for. Training can stop early if plateau detection is enabled.">
        <Input type="number" value={hp.maxEpochs} min={1} step={1} className="h-9 text-sm w-28"
          onChange={(e) => onUpdate({ maxEpochs: Number(e.target.value) })} />
      </Field>

      <Field label="Initial Learning Rate" hint="Initial optimizer learning rate, typically 1e-3 or 1e-4. Reduced automatically on plateau. Too high or low can prevent finding good minima.">
        <Input type="number" value={hp.learningRate} min={0} step={0.0001} className="h-9 text-sm w-32"
          onChange={(e) => onUpdate({ learningRate: Number(e.target.value) })} />
      </Field>

      <Toggle label="Stop Training on Plateau" checked={hp.stopOnPlateau}
        onChange={(v) => onUpdate({ stopOnPlateau: v })}
        hint="Terminate training automatically when validation loss plateaus — saves compute and prevents overfitting." />
      {hp.stopOnPlateau && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Plateau Min. Delta" hint="Minimum absolute loss decrease for an epoch to count as improvement (not a plateau).">
            <Input type="number" value={hp.plateauMinDelta} min={0} step={1e-8} className="h-9 text-sm w-32"
              onChange={(e) => onUpdate({ plateauMinDelta: Number(e.target.value) })} />
          </Field>
          <Field label="Plateau Patience" hint="Number of epochs without improvement of at least min-delta before a plateau is detected.">
            <Input type="number" value={hp.earlyStoppingPatience} min={1} step={1} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ earlyStoppingPatience: Number(e.target.value) })} />
          </Field>
        </div>
      )}

      <Toggle label="Online Mining" checked={hp.onlineMining}
        onChange={(v) => onUpdate({ onlineMining: v })}
        hint="Online hard keypoint mining (OHKM): compute loss per keypoint, sort easy→hard, and up-weight hard keypoints so training focuses on tricky body parts." />
      {hp.onlineMining && (
        <div className="pl-4 border-l border-border/60 ml-1">
          <Field label="Min Hard Keypoints">
            <Input type="number" value={hp.minHardKeypoints} min={0} step={1} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ minHardKeypoints: Number(e.target.value) })} />
          </Field>
          <Field label="Max Hard Keypoints">
            <div className="flex items-center gap-2">
              <Input type="number" value={hp.maxHardKeypoints ?? ""} min={0} step={1} disabled={hp.maxHardKeypoints === null}
                placeholder="—" className="h-9 text-sm w-28"
                onChange={(e) => onUpdate({ maxHardKeypoints: e.target.value ? Number(e.target.value) : null })} />
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={hp.maxHardKeypoints === null} className="accent-primary"
                  onChange={(e) => onUpdate({ maxHardKeypoints: e.target.checked ? null : 5 })} />
                No max
              </label>
            </div>
          </Field>
          <Field label="Hard/Easy Ratio">
            <Input type="number" value={hp.hardToEasyRatio} min={0} step={0.5} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ hardToEasyRatio: Number(e.target.value) })} />
          </Field>
          <Field label="Loss Scale">
            <Input type="number" value={hp.lossScale} min={0} step={0.5} className="h-9 text-sm w-28"
              onChange={(e) => onUpdate({ lossScale: Number(e.target.value) })} />
          </Field>
        </div>
      )}
    </div>
  );
}
