import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfigShell } from "@/components/dialogs/config/ConfigShell";
import { SlotSwitcher } from "@/components/dialogs/config/SlotSwitcher";
import { buildTrainingSections } from "@/components/dialogs/config/trainingSections";
import { TRAINING_SEARCH_INDEX } from "@/lib/configSearch";
import { getSlotLabel } from "@/stores/trainingStore";
import type { ConfigFile, ConfigHyperparams } from "@/stores/trainingStore";

/**
 * Modal host for the training config shell. Owns the active-slot selection and
 * feeds the shell the selected config's live hyperparameters. Edits auto-save
 * through onUpdateSlot; "Reset to profile defaults" restores that slot's
 * as-loaded values via onResetSlot.
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
  const [activeSlot, setActiveSlot] = useState(configs[0]?.slot ?? "");
  const active = configs.find((c) => c.slot === activeSlot) ?? configs[0];

  if (!active) return null;

  const slotTabs = configs.map((c) => ({ id: c.slot, label: getSlotLabel(c.slot).replace(" Config", "") }));
  const sections = buildTrainingSections();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-full sm:max-w-[1040px] h-[76vh] p-0 overflow-hidden inset-0 translate-x-0 translate-y-0 m-auto flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>Training Configuration</DialogTitle>
        </DialogHeader>
        <ConfigShell
          title="Training Configuration"
          sections={sections}
          searchIndex={TRAINING_SEARCH_INDEX}
          hp={active.hyperparams}
          onUpdate={(patch) => onUpdateSlot(active.slot, patch)}
          onResetAll={() => onResetSlot(active.slot)}
          onDone={onClose}
          slot={active.slot}
          modelType={modelType}
          headerAccessory={
            <SlotSwitcher slots={slotTabs} active={active.slot} onChange={setActiveSlot} />
          }
        />
      </DialogContent>
    </Dialog>
  );
}
