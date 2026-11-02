/**
 * The Training panel's dry-run result: one row per config checked with
 * `sleap-nn train --dry-run` (both heads for top-down), each with sleap-nn's
 * summary of the run it would do or the error that stopped it, and the run's
 * log on demand.
 */

import { useMemo, useState } from "react";
import { useTrainingStore, type DryRunState } from "@/stores/trainingStore";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, X, XCircle } from "lucide-react";

const HEADLINE: Record<DryRunState["status"], string> = {
  running: "Dry run: checking setup and one batch...",
  passed: "Dry run passed. Ready to train.",
  failed: "Dry run failed. Fix this before training.",
  unsupported: "This sleap-nn can't do a dry run",
  cancelled: "Dry run cancelled",
};

export function DryRunResult({ dryRun }: { dryRun: DryRunState }) {
  const config = useTrainingStore((s) => s.config);
  const cancelDryRun = useTrainingStore((s) => s.cancelDryRun);
  const clearDryRun = useTrainingStore((s) => s.clearDryRun);
  const [showLog, setShowLog] = useState(false);
  // Every config edit replaces `config`, but some re-set identical values, so
  // compare contents rather than identity.
  const stale = useMemo(
    () => dryRun.status !== "running" && JSON.stringify(dryRun.config) !== JSON.stringify(config),
    [dryRun.status, dryRun.config, config],
  );
  const running = dryRun.status === "running";

  return (
    <div className="rounded border border-border p-2 text-xs space-y-1.5" data-testid="dry-run-result">
      <div className="flex items-center gap-1.5">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
        ) : dryRun.status === "passed" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
        ) : dryRun.status === "cancelled" ? (
          <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
        )}
        <span className="font-medium flex-1">{HEADLINE[dryRun.status]}</span>
        {running ? (
          <Button variant="outline" size="xs" onClick={() => cancelDryRun()}>
            Cancel
          </Button>
        ) : (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss dry run result"
            onClick={() => clearDryRun()}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {stale && (
        <p className="flex items-center gap-1 text-[10px] text-yellow-500">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          The config changed since this check. Run it again to check the current one.
        </p>
      )}

      {dryRun.models.map((m, i) => (
        <div key={i} className="space-y-0.5" data-testid="dry-run-model">
          <div className="flex items-center gap-1.5">
            {m.status === "running" ? (
              <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
            ) : m.status === "passed" ? (
              <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
            ) : m.status === "failed" ? (
              <XCircle className="h-3 w-3 text-destructive shrink-0" />
            ) : (
              <Circle className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium">{m.label}</span>
          </div>
          {m.summary && m.summary.length > 0 && (
            <dl className="ml-[18px] grid grid-cols-[auto_1fr] gap-x-2 text-[10px] leading-snug">
              {m.summary.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="truncate" title={f.value}>
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {m.error && (
            <p className="ml-[18px] text-[10px] leading-snug text-destructive break-words line-clamp-4" title={m.error}>
              {m.error}
            </p>
          )}
        </div>
      ))}

      {dryRun.status === "unsupported" && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Dry runs need a sleap-nn release after 0.3.5. Training itself still works.
        </p>
      )}

      {dryRun.log.length > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowLog((v) => !v)}
          >
            {showLog ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {showLog ? "Hide log" : "Show log"}
          </button>
          {showLog && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[9px] leading-tight whitespace-pre-wrap break-all">
              {dryRun.log.join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
