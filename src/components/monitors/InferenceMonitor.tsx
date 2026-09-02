/**
 * InferenceMonitor — shows inference progress as a full dialog or compact bar.
 *
 * Components:
 *  - InferenceProgressDialog: full dialog view while inference is running/done/errored
 *  - InferenceCompactBar: minimized status bar shown while inference is running
 *  - InferenceMonitor (default export): wrapper that renders both
 */

import { useRef, useEffect, useState } from "react";
import { useInferenceStore } from "@/stores/inferenceStore";
import { ErrorOutput } from "@/components/monitors/ErrorOutput";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Minimize2,
  Maximize2,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Download,
} from "lucide-react";

// ── helpers ─────────────────────────────────────────────────────────────────

function formatEta(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Thin Tailwind progress bar — avoids needing a shadcn Progress component. */
function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
      <div
        className="h-full bg-primary transition-all duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── InferenceProgressDialog ──────────────────────────────────────────────────

function InferenceProgressDialog() {
  const status = useInferenceStore((s) => s.status);
  const progress = useInferenceStore((s) => s.progress);
  const log = useInferenceStore((s) => s.log);
  const error = useInferenceStore((s) => s.error);
  const stderrTail = useInferenceStore((s) => s.stderrTail);
  const minimized = useInferenceStore((s) => s.minimized);
  const setMinimized = useInferenceStore((s) => s.setMinimized);
  const reset = useInferenceStore((s) => s.reset);
  const cancelInference = useInferenceStore((s) => s.cancelInference);
  const loadAndMergeResults = useInferenceStore((s) => s.loadAndMergeResults);
  const outputPath = useInferenceStore((s) => s.outputPath);

  const [logExpanded, setLogExpanded] = useState(false);
  const [merging, setMerging] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Auto-scroll log to bottom when new lines arrive
  useEffect(() => {
    if (logExpanded && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, logExpanded]);

  const isRunning = status === "running";
  const isDone = status === "completed" || status === "error" || status === "cancelled";

  const open = status !== "idle" && !minimized;

  const pct =
    progress && progress.nTotal > 0
      ? (progress.nProcessed / progress.nTotal) * 100
      : 0;

  // Status icon + title text
  let StatusIcon: React.ElementType = Loader2;
  let iconClass = "animate-spin text-primary";
  let titleText = "Running Inference";
  if (status === "completed") {
    StatusIcon = CheckCircle2;
    iconClass = "text-green-500";
    titleText = "Inference Complete";
  } else if (status === "error") {
    StatusIcon = XCircle;
    iconClass = "text-destructive";
    titleText = "Inference Failed";
  } else if (status === "cancelled") {
    StatusIcon = AlertCircle;
    iconClass = "text-yellow-500";
    titleText = "Inference Cancelled";
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      if (isRunning) {
        // minimize instead of dismiss while running
        setMinimized(true);
      } else {
        reset();
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StatusIcon className={`h-5 w-5 ${iconClass}`} />
            {titleText}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Progress bar + frame counts */}
          <div className="space-y-1.5">
            <ProgressBar value={pct} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {progress
                  ? `${progress.nProcessed} / ${progress.nTotal} frames`
                  : "Waiting…"}
              </span>
              <span>{pct > 0 ? `${pct.toFixed(1)}%` : ""}</span>
            </div>
          </div>

          {/* Stats row */}
          {progress && progress.rate > 0 && (
            <p className="text-sm text-muted-foreground">
              {progress.rate.toFixed(1)} fps — ETA:{" "}
              {formatEta(progress.eta)}
            </p>
          )}

          {/* Error message + forwarded sleap-nn error output */}
          {error && (
            <div className="rounded-md bg-destructive/15 border border-destructive/30 px-3 py-2 text-sm text-destructive select-text">
              {error}
            </div>
          )}
          {status === "error" && stderrTail.length > 0 && (
            <ErrorOutput lines={stderrTail} title="Error output (sleap-nn)" />
          )}

          {/* Expandable stderr/stdout log */}
          {log.length > 0 && (
            <div>
              <button
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                onClick={() => setLogExpanded((v) => !v)}
              >
                {logExpanded ? "Hide" : "Show"} log ({log.length} lines)
              </button>
              {logExpanded && (
                <pre
                  ref={logRef}
                  className="mt-1 max-h-48 overflow-auto rounded border bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all"
                >
                  {log.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex justify-end gap-2">
          {isRunning && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMinimized(true)}
              >
                <Minimize2 className="h-4 w-4 mr-1" />
                Minimize
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => cancelInference()}
              >
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </>
          )}
          {isDone && (
            <>
              {status === "completed" && outputPath && (
                <Button
                  size="sm"
                  onClick={async () => {
                    setMerging(true);
                    await loadAndMergeResults();
                    setMerging(false);
                  }}
                  disabled={merging}
                >
                  {merging ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-1" />
                  )}
                  {merging ? "Loading…" : "Load Results"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => reset()}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── InferenceCompactBar ──────────────────────────────────────────────────────

function InferenceCompactBar() {
  const status = useInferenceStore((s) => s.status);
  const progress = useInferenceStore((s) => s.progress);
  const minimized = useInferenceStore((s) => s.minimized);
  const setMinimized = useInferenceStore((s) => s.setMinimized);
  const cancelInference = useInferenceStore((s) => s.cancelInference);

  if (status !== "running" || !minimized) return null;

  const pct =
    progress && progress.nTotal > 0
      ? (progress.nProcessed / progress.nTotal) * 100
      : 0;

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-t bg-muted/50 cursor-pointer select-none"
      onClick={() => setMinimized(false)}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />

      <div className="flex-1 min-w-0">
        <ProgressBar value={pct} />
      </div>

      <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
        Inference:{" "}
        {progress
          ? `${progress.nProcessed}/${progress.nTotal} frames${progress.rate > 0 ? ` (${progress.rate.toFixed(1)} fps)` : ""}`
          : "starting…"}
      </span>

      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          setMinimized(false);
        }}
        title="Expand"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          cancelInference();
        }}
        title="Cancel inference"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── InferenceMonitor (exported wrapper) ─────────────────────────────────────

export function InferenceMonitor() {
  return (
    <>
      <InferenceProgressDialog />
      <InferenceCompactBar />
    </>
  );
}
