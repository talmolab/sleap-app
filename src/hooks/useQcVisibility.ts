import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { computeQcVisibility, type QcMode } from "@/lib/instanceVisibility";
import type { Instance } from "@/types";

/** Write computed QC-mode flags into the transient per-instance store.
 *  Exported for unit tests; the hook drives it reactively. */
export function applyQcVisibility(
  mode: QcMode,
  selected: Instance | null,
  instances: Instance[],
  globalShowNonVisible: boolean,
): void {
  const flags = computeQcVisibility(mode, selected, instances, globalShowNonVisible);
  if (flags.size === 0) return; // manual sentinel: leave state alone
  const hidden = new Set<Instance>();
  const override = new Map<Instance, boolean>();
  for (const [inst, [visible, showOccluded]] of flags) {
    if (!visible) hidden.add(inst);
    override.set(inst, showOccluded);
  }
  useAppStore.setState({
    hiddenInstances: hidden,
    showNonVisibleOverride: override,
    viewOnlyInstance: null,
  });
}

/** Reactively re-apply the QC display mode when mode / selection / frame /
 *  instance set / global SNV change. Manual mode is a no-op. */
export function useQcVisibility(instances: Instance[]): void {
  const mode = useAppStore((s) => s.qcDisplayMode);
  const selected = useAppStore((s) => s.instance);
  const globalSNV = useAppStore((s) => s.showNonVisibleNodes);
  const frameIdx = useAppStore((s) => s.frameIdx);
  useEffect(() => {
    if (mode === "manual") return;
    applyQcVisibility(mode, selected, instances, globalSNV);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, globalSNV, frameIdx, instances.length]);
}
