import type { ModelProgress, TrainingStatus } from "@/stores/trainingStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LossPlot } from "@/components/monitors/LossPlot";

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
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Training Monitor{model ? ` — ${model.label}` : ""}
          </DialogTitle>
        </DialogHeader>

        {model && (
          <LossPlot model={model} startedAt={startedAt} status={status} height={320} />
        )}

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
