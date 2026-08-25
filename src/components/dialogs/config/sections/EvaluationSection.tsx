import { Input } from "@/components/ui/input";
import { Field, Toggle } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";

/**
 * Evaluation section: run epoch-end pose evaluation on validation frames and,
 * when enabled, how often to run it. The frequency field is disabled and dimmed
 * until evaluation is turned on, mirroring the legacy dialog.
 */
export function EvaluationSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      <Toggle label="Run evaluation during training" checked={hp.evalEnabled}
        onChange={(v) => onUpdate({ evalEnabled: v })}
        hint="Run inference on validation frames at epoch intervals and compute pose metrics (mOKS, mAP, PCK). Useful for monitoring training quality beyond loss." />

      <div className={!hp.evalEnabled ? "opacity-50" : ""}>
        <Field label="Frequency (epochs)" hint="How often to run full evaluation. Every 1 epoch is most informative but slower. Every 5–10 epochs is a good balance.">
          <Input type="number" value={hp.evalFrequency} min={1} step={1} disabled={!hp.evalEnabled}
            className="h-9 text-sm w-28"
            onChange={(e) => onUpdate({ evalFrequency: Math.max(1, Number(e.target.value)) })} />
        </Field>
      </div>
    </div>
  );
}
