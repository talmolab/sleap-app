import { Input } from "@/components/ui/input";
import { Field, Toggle } from "@/components/dialogs/config/primitives";
import type { SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";

/**
 * WandB section: opt-in Weights & Biases experiment logging plus its run
 * metadata. The offline toggle logs to local disk only; API-key and viz-upload
 * are network-only, so they disable in offline mode, and every field disables
 * entirely when logging is off — mirroring the legacy dialog's enable/disable
 * logic.
 */
export function WandBSection({ hp, onUpdate }: SectionRenderCtx) {
  return (
    <div className="max-w-xl">
      <Toggle label="Enable WandB for logging" checked={hp.useWandb}
        onChange={(v) => onUpdate({ useWandb: v })}
        hint="Log training metrics, loss curves, and visualizations to Weights & Biases for experiment tracking." />

      <Toggle label="Offline Mode" checked={hp.wandbMode === "offline"}
        onChange={(v) => onUpdate({ wandbMode: v ? "offline" : "online" })}
        disabled={!hp.useWandb}
        hint="Log to local disk only — no network or W&B login required. Upload later with `wandb sync`." />

      <Toggle label="Upload Viz" checked={hp.wandbUploadViz}
        onChange={(v) => onUpdate({ wandbUploadViz: v })}
        disabled={!hp.useWandb || hp.wandbMode === "offline"}
        hint="Upload prediction visualization images to W&B for remote viewing." />

      <Field label="API Key" hint="W&B API key from wandb.ai/authorize. Optional — leave blank if you've run 'wandb login' or set the WANDB_API_KEY environment variable.">
        <Input type="password" autoComplete="off" value={hp.wandbApiKey}
          disabled={!hp.useWandb || hp.wandbMode === "offline"}
          className="h-9 text-sm w-64"
          onChange={(e) => onUpdate({ wandbApiKey: e.target.value })} />
      </Field>
      {hp.wandbMode === "offline" && (
        <p className="text-xs text-muted-foreground -mt-1 pb-1">
          Logged locally — run <span className="font-mono">wandb sync</span> to upload later.
        </p>
      )}

      <Field label="Entity Name" hint="Your W&B username or team name that owns the project this run logs to. Leave blank to use your default W&B entity.">
        <Input type="text" value={hp.wandbEntity} disabled={!hp.useWandb}
          className="h-9 text-sm w-48"
          onChange={(e) => onUpdate({ wandbEntity: e.target.value })} />
      </Field>

      <Field label="Project Name" hint="The W&B project this run's metrics and visualizations are logged under. Created automatically if it doesn't already exist.">
        <Input type="text" value={hp.wandbProject} disabled={!hp.useWandb}
          className="h-9 text-sm w-48"
          onChange={(e) => onUpdate({ wandbProject: e.target.value })} />
      </Field>

      <Field label="Previous Run ID" hint="ID of a previous W&B run to resume logging into instead of starting a new one. Pair this with Resume Training so training metrics continue on the same run's timeline.">
        <Input type="text" value={hp.wandbPrevRunId} disabled={!hp.useWandb}
          className="h-9 text-sm w-48"
          onChange={(e) => onUpdate({ wandbPrevRunId: e.target.value })} />
      </Field>

      <Field label="Group Name" hint="Optional label to cluster related runs together in the W&B UI, e.g. runs from the same experiment or hyperparameter sweep.">
        <Input type="text" value={hp.wandbGroup} disabled={!hp.useWandb}
          className="h-9 text-sm w-48"
          onChange={(e) => onUpdate({ wandbGroup: e.target.value })} />
      </Field>
    </div>
  );
}
