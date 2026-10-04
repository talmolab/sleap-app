/**
 * Connect window §4b.6 — JobViewerDialog: a per-job replay + live viewer for
 * ANY job on a paired worker (not just one this app window submitted),
 * independent of the Training panel. Reuses the existing Training Monitor's
 * `LossPlot` for the Monitor view and `LogTerminalDialog`'s terminal styling
 * (embedded rather than nested — it's its own top-level `Dialog`, which
 * can't render inline inside another) for the Logs view.
 */
import { useMemo, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LossPlot } from "@/components/monitors/LossPlot";
import { isErrorLine, logLineClassName } from "@/lib/processLog";
import type { JobStreamStatus } from "@/lib/jobStream";
import { toast } from "@/lib/notify";
import { useJobStream } from "@/hooks/useJobStream";
import { useConnectStore } from "@/stores/connectStore";
import { confirmDialog } from "@/stores/confirmStore";
import type { TrainingStatus } from "@/stores/trainingStore";

export interface JobViewerDialogProps {
  workerId: string;
  jobId: string;
  label: string;
  initialView: "monitor" | "logs";
  onClose: () => void;
}

/** Maps the job stream's worker-facing status onto LossPlot's TrainingStatus vocabulary. */
function toTrainingStatus(status: JobStreamStatus): TrainingStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "canceled":
      return "stopped";
    default:
      return "idle";
  }
}

export function JobViewerDialog({ workerId, jobId, label, initialView, onClose }: JobViewerDialogProps) {
  const [view, setView] = useState<"monitor" | "logs">(initialView);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [wrap, setWrap] = useState(true);
  const cancelJobOn = useConnectStore((s) => s.cancelJobOn);
  const preRef = useRef<HTMLPreElement>(null);

  const stream = useJobStream(workerId, jobId, label);

  const lines = useMemo(
    () => (errorsOnly ? stream.log.filter(isErrorLine) : stream.log),
    [stream.log, errorsOnly],
  );

  const handleStop = async () => {
    const ok = await confirmDialog({
      title: "Stop job?",
      message: `Stop "${label}" on this worker?`,
      confirmLabel: "Stop",
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancelJobOn(workerId, jobId, "stop");
    } catch (err) {
      toast.error("Failed to stop job", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center justify-between pr-6">
            <span className="truncate">{label}</span>
            <span className="text-[10px] font-normal text-muted-foreground capitalize">
              {stream.status}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            Replayed from the worker&apos;s history; per-epoch timing for earlier epochs isn&apos;t
            available.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant={view === "monitor" ? "default" : "outline"}
            className="h-6 text-[10px]"
            onClick={() => setView("monitor")}
          >
            Monitor
          </Button>
          <Button
            size="xs"
            variant={view === "logs" ? "default" : "outline"}
            className="h-6 text-[10px]"
            onClick={() => setView("logs")}
          >
            Logs
          </Button>
          {stream.status === "running" && (
            <Button
              size="xs"
              variant="outline"
              className="ml-auto h-6 text-[10px]"
              onClick={handleStop}
            >
              Stop
            </Button>
          )}
        </div>

        {stream.detail && (stream.status === "failed" || stream.status === "canceled") && (
          <p className="text-[11px] text-red-400">{stream.detail}</p>
        )}

        {view === "monitor" ? (
          <LossPlot
            model={stream.model}
            startedAt={null}
            status={toTrainingStatus(stream.status)}
            height={200}
          />
        ) : (
          <>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => navigator.clipboard.writeText(lines.join("\n"))}
              >
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy
              </Button>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(e) => setErrorsOnly(e.target.checked)}
                />
                Errors only
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
                Wrap
              </label>
            </div>
            <pre
              ref={preRef}
              className={`h-[40vh] overflow-auto rounded border bg-muted p-2 text-[11px] font-mono ${
                wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
              }`}
            >
              {lines.length === 0 ? (
                <span className="text-muted-foreground">
                  {errorsOnly ? "No error lines." : "No log output."}
                </span>
              ) : (
                lines.map((line, i) => (
                  <div key={i} className={logLineClassName(line)}>
                    {line}
                  </div>
                ))
              )}
            </pre>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
