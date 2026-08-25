import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TrainingConfigView } from "@/components/dialogs/config/TrainingConfigView";
import type { ConfigFile, ConfigHyperparams } from "@/stores/trainingStore";

/**
 * Modal host for the training config shell. Wraps TrainingConfigView (which owns
 * the Pipeline | Head tabs, head-slot switcher, and shared-vs-per-head data) in a
 * Dialog. Edits auto-save through onUpdateSlot; reset restores as-loaded values.
 */
export function ConfigModal({
  open,
  onClose,
  modelType,
  configs,
  onUpdateSlot,
  onResetSlot,
}: {
  open: boolean;
  onClose: () => void;
  modelType: string;
  configs: ConfigFile[];
  onUpdateSlot: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  onResetSlot: (slot: string) => void;
}) {
  if (!configs[0]) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-full sm:max-w-[1040px] h-[76vh] p-0 overflow-hidden inset-0 translate-x-0 translate-y-0 m-auto flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>Training Configuration</DialogTitle>
        </DialogHeader>
        <TrainingConfigView
          modelType={modelType}
          configs={configs}
          onUpdateSlot={onUpdateSlot}
          onResetSlot={onResetSlot}
          onDone={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
