/**
 * Top-bar inference progress indicator (issue #212).
 *
 * Mirrors {@link TrainingProgressBar} for the inference/prediction path (e.g. the
 * active-learning "Run locator → predict centroids" step). Shows live status —
 * frames processed, a progress bar, an expandable log — plus Stop while running
 * and Dismiss on a terminal state. Errors (e.g. a sleap-nn predict crash, or a
 * process that never produced output) surface here rather than the run silently
 * sitting greyed-out forever. Reads inferenceStore; hidden when idle.
 */

import { useState } from "react";
import { useInferenceStore } from "../../stores/inferenceStore";
import { Button } from "@/components/ui/button";

export function InferenceProgressBar() {
  const status = useInferenceStore((s) => s.status);
  const progress = useInferenceStore((s) => s.progress);
  const log = useInferenceStore((s) => s.log);
  const error = useInferenceStore((s) => s.error);
  const [showLog, setShowLog] = useState(false);

  if (status === "idle") return null;

  const running = status === "running";
  const isError = status === "error";
  // Determinate only once sleap-nn reports frame counts; until then the run is
  // "starting" (spawning / loading the model) with an indeterminate bar.
  const hasCounts = !!progress && progress.nTotal > 0;
  const pct = hasCounts
    ? Math.min(100, Math.round((progress!.nProcessed / progress!.nTotal) * 100))
    : 0;

  const label = isError
    ? "Inference failed"
    : status === "completed"
      ? "Inference complete"
      : status === "cancelled"
        ? "Inference cancelled"
        : hasCounts
          ? `Predicting — ${progress!.nProcessed}/${progress!.nTotal} frames (${pct}%)`
          : "Starting inference…";

  return (
    <div className={`border-b border-border ${isError ? "bg-destructive/10" : "bg-muted/40"}`}>
      <div className="flex items-center gap-3 px-3 py-1.5 text-xs">
        <span className={`font-medium ${isError ? "text-destructive" : ""}`}>{label}</span>
        {running && (
          <div className="h-1.5 max-w-xs flex-1 overflow-hidden rounded bg-border">
            <div
              className={`h-full bg-primary ${hasCounts ? "transition-all" : "animate-pulse w-1/3"}`}
              style={hasCounts ? { width: `${pct}%` } : undefined}
            />
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
              onClick={() => void useInferenceStore.getState().cancelInference()}
            >
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6"
              onClick={() => useInferenceStore.getState().reset()}
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
