/**
 * Compact "not-live" card for a remote training run (PR3b
 * docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3b.4) — shown instead
 * of the full inline monitor (per-model progress bars + log) while
 * `_isRemote && status === "running" && !watching`. The run keeps streaming
 * on the worker regardless of which view is showing; this just avoids
 * presenting a background job as something the user has to sit and watch.
 * "Watch Live" switches TrainingPanel back to the full inline block (which
 * keeps rendering normally once `watching` is true) and opens the loss
 * viewer for the model currently training.
 */
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/timestamp";
import { transportLabel, type TransportKind } from "@/lib/protocolV1/transport";
import type { ConnectionStatus } from "@/stores/connectStore";
import type { ModelProgress, PostTrainingInference } from "@/stores/trainingStore";

export interface RemoteRunCardProps {
  workerLabel: string;
  connectionStatus: ConnectionStatus;
  activeTransport: TransportKind | null;
  startedAt: number | null;
  models: ModelProgress[];
  currentModelIndex: number;
  postTrainingInference: PostTrainingInference | null;
  onWatchLive: () => void;
}

function connectionDotClass(status: ConnectionStatus): string {
  if (status === "connected") return "bg-green-500";
  if (status === "reconnecting") return "bg-amber-500";
  if (status === "connecting") return "bg-yellow-500";
  return "bg-zinc-500";
}

export function RemoteRunCard({
  workerLabel,
  connectionStatus,
  activeTransport,
  startedAt,
  models,
  currentModelIndex,
  postTrainingInference,
  onWatchLive,
}: RemoteRunCardProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connectionDotClass(connectionStatus)}`} />
          <span className="font-medium text-foreground truncate">{workerLabel}</span>
          {connectionStatus === "reconnecting" && (
            <span className="text-amber-400 shrink-0">Reconnecting…</span>
          )}
          {activeTransport && connectionStatus === "connected" && (
            <span className="text-muted-foreground/70 shrink-0">via {transportLabel(activeTransport)}</span>
          )}
        </div>
        {startedAt && (
          <span className="text-[10px] text-muted-foreground shrink-0">{formatDuration(elapsed)}</span>
        )}
      </div>

      <div className="space-y-1">
        {models.map((m, i) => {
          const isCurrent = i === currentModelIndex && m.status === "running";
          return (
            <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex items-center gap-1.5 truncate">
                {m.status === "completed" && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
                {m.status === "failed" && <XCircle className="h-3 w-3 text-destructive shrink-0" />}
                {isCurrent && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                {m.status === "pending" && (
                  <span className="w-3 h-3 rounded-full border border-muted-foreground/30 shrink-0" />
                )}
                <span className="truncate">{m.label}</span>
              </span>
              <span className="text-muted-foreground shrink-0">
                {m.epoch}/{m.maxEpochs}
                {m.loss != null ? ` · loss ${m.loss.toFixed(4)}` : ""}
              </span>
            </div>
          );
        })}
      </div>

      {postTrainingInference && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {postTrainingInference.status === "running" && (
            <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
          )}
          {postTrainingInference.status === "completed" && (
            <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
          )}
          {postTrainingInference.status === "error" && (
            <XCircle className="h-3 w-3 text-destructive shrink-0" />
          )}
          <span>
            {postTrainingInference.status === "running"
              ? "Running inference on the worker..."
              : postTrainingInference.status === "completed"
                ? "Inference complete."
                : postTrainingInference.status === "error"
                  ? "Inference failed."
                  : "Inference skipped."}
          </span>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Runs on {workerLabel} — you can close SLEAP; you&apos;ll be notified when it finishes.
      </p>

      <Button variant="outline" size="xs" className="w-full h-6 text-[10px]" onClick={onWatchLive}>
        Watch Live
      </Button>
    </div>
  );
}
