import type { ModelProgress, TrainingStatus } from "@/stores/trainingStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { LossPlot } from "@/components/monitors/LossPlot";
import { VizImageViewer } from "@/components/monitors/VizImageViewer";
import { openVizWindow } from "@/lib/newInstance";

/**
 * Centered modal wrapping the training loss chart (PyQt LossViewer parity).
 *
 * PERF: a Radix Dialog unmounts its content when closed, so while training runs
 * with the viewer closed the chart does ZERO work — no per-flush rebuild/redraw.
 * This keeps the GUI smooth during training.
 */
export function LossViewerDialog({
  open,
  onOpenChange,
  model,
  startedAt,
  status,
  isActive,
  onStopEarly,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ModelProgress | null;
  startedAt: number | null;
  status: TrainingStatus;
  isActive: boolean; // viewed model is the running one → show Stop/Cancel
  onStopEarly: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Training Monitor{model ? ` — ${model.label}` : ""}
          </DialogTitle>
        </DialogHeader>

        {/* Gate the heavy chart on `open` as well as `model`. Radix keeps
            dialog content mounted for its ~200ms exit-fade, so clicking OUTSIDE
            during training would otherwise collide a live loss-plot redraw (a
            full-buffer y-range recompute) with the dismissal's page reflow and
            freeze the GUI. Unmounting on close destroys uPlot immediately. */}
        {open && model && (
          <LossPlot model={model} startedAt={startedAt} status={status} height={360} />
        )}

        {model?.runDir && (
          <div className="flex justify-end -mb-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              title="Open the visualization in a separate, resizable window (zoom + epoch scrubber)"
              onClick={() => openVizWindow(model.runDir!, model.label)}
            >
              <ExternalLink className="h-3 w-3 mr-1" /> Pop out
            </Button>
          </div>
        )}
        {open && model && <VizImageViewer model={model} />}

        {isActive && (
          <div className="flex items-center gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1 h-8 text-xs"
              onClick={onStopEarly}
            >
              Stop Early
            </Button>
            <Button
              variant="destructive"
              className="flex-1 h-8 text-xs"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <span className="sr-only">
              Stop Early saves a checkpoint. Cancel terminates immediately.
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
