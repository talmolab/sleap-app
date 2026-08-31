/**
 * On-canvas prompt shown while click-selecting the two instances to
 * transpose, when the current frame has more than 2 instances (so
 * TransposeInstances can't auto-pick a pair — see `requestTranspose` in
 * `trackCommands.ts`). Self-guards to `instanceSequencePick` (mirrors
 * AnchorPickBar's pattern) — always rendered, shows nothing outside the mode.
 *
 * VideoPlayer's own pointer handlers own the actual instance hit-testing and
 * resolve each pick (`pushInstanceSequencePick`); this component is the
 * cancel affordance (button + Escape) plus a separate effect that fires the
 * actual TransposeInstances command once both instances are collected.
 */

import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { Button } from "@/components/ui/button";
import { commandContext } from "@/commands/CommandContext";
import { TransposeInstances } from "@/commands/trackCommands";

export function TransposePickBar() {
  const pick = useAppStore((s) => s.instanceSequencePick);
  const result = useAppStore((s) => s.instanceSequenceResult);

  useEffect(() => {
    if (!pick) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      useAppStore.getState().cancelInstanceSequencePick();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pick]);

  // Fire the command once both instances are collected, then clear the
  // result so a later pick can't accidentally re-trigger it.
  useEffect(() => {
    if (!result || result.instances.length !== 2) return;
    const [first, second] = result.instances;
    commandContext.execute(TransposeInstances, { instances: [first, second] });
    useAppStore.getState().clearInstanceSequenceResult();
  }, [result]);

  if (!pick) return null;

  const word = pick.collected.length === 0 ? "first" : "second";

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1.5 shadow-lg backdrop-blur-sm pointer-events-auto">
      <span className="px-1 text-xs font-medium text-white/90">
        Click the {word} instance to transpose
      </span>
      <Button
        variant="secondary"
        size="xs"
        className="pointer-events-auto bg-white/10 text-white/85 border-none hover:bg-white/20 hover:text-white"
        onClick={() => useAppStore.getState().cancelInstanceSequencePick()}
      >
        Cancel
      </Button>
    </div>
  );
}
