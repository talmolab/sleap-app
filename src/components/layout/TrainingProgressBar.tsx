/**
 * Top-bar training progress indicator (issue #212).
 *
 * Shows live status for a running locator/pose training run at the top of the
 * video pane — epoch progress, a bar, and an expandable log — plus Stop while
 * running and Dismiss on a terminal state. Errors (e.g. sleap-nn crash) surface
 * here rather than silently. Reads trainingStore; hidden when idle.
 */

import { useState } from "react";
import { useTrainingStore } from "../../stores/trainingStore";
import { Button } from "@/components/ui/button";

export function TrainingProgressBar() {
  const status = useTrainingStore((s) => s.status);
  const models = useTrainingStore((s) => s.models);
  const currentModelIndex = useTrainingStore((s) => s.currentModelIndex);
  const log = useTrainingStore((s) => s.log);
  const error = useTrainingStore((s) => s.error);
  const [showLog, setShowLog] = useState(false);

  if (status === "idle") return null;

  const model = models[currentModelIndex] ?? models[0];
  const pct =
    model && model.maxEpochs > 0
      ? Math.min(100, Math.round((model.epoch / model.maxEpochs) * 100))
      : 0;
  const running = status === "running";
  const isError = status === "error";

  const label = isError
    ? "Training failed"
    : status === "completed"
      ? "Training complete"
      : status === "stopped"
        ? "Training stopped"
        : model
          ? `Training ${model.label} — epoch ${model.epoch}/${model.maxEpochs} (${pct}%)`
          : "Training…";

  return (
    <div className={`border-b border-border ${isError ? "bg-destructive/10" : "bg-muted/40"}`}>
      <div className="flex items-center gap-3 px-3 py-1.5 text-xs">
        <span className={`font-medium ${isError ? "text-destructive" : ""}`}>{label}</span>
        {running && (
          <div className="h-1.5 max-w-xs flex-1 overflow-hidden rounded bg-border">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        {isError && error && (
          <span className="truncate text-destructive/90" title={error}>
            {error}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-6" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide log" : "Log"}
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6"
              onClick={() => void useTrainingStore.getState().stopTraining()}
            >
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6"
              onClick={() => useTrainingStore.getState().reset()}
            >
              Dismiss
            </Button>
          )}
        </div>
      </div>
      {showLog && (
        <div className="max-h-40 overflow-auto border-t border-border bg-background/60 px-3 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap">
          {log.length === 0 ? (
            <span className="text-muted-foreground">No output yet…</span>
          ) : (
            log.slice(-200).join("\n")
          )}
        </div>
      )}
    </div>
  );
}
