import { useMemo, useState } from "react";
import { ConfigShell, type ShellSection } from "@/components/dialogs/config/ConfigShell";
import { SlotSwitcher } from "@/components/dialogs/config/SlotSwitcher";
import { buildTrainingSections } from "@/components/dialogs/config/trainingSections";
import { TRAINING_SECTIONS, type SectionScope } from "@/lib/configSections";
import { TRAINING_SEARCH_INDEX } from "@/lib/configSearch";
import { getSlotLabel } from "@/stores/trainingStore";
import type { ConfigFile, ConfigHyperparams } from "@/stores/trainingStore";

const SCOPE_BY_SECTION: Record<string, SectionScope> = Object.fromEntries(
  TRAINING_SECTIONS.map((s) => [s.id, s.scope]),
);

/**
 * Restores the legacy Pipeline | Head split inside the new shell. Pipeline
 * sections are shared across heads (displayed from the first config, written to
 * ALL slots); Head sections are per-slot, with the Centroid | Centered-Instance
 * sub-switcher. Owns tab + active-slot + active-section so search can jump across
 * tabs; hands a fully-resolved view to the (host-agnostic) ConfigShell.
 */
export function TrainingConfigView({
  modelType,
  configs,
  onUpdateSlot,
  onResetSlot,
  onDone,
}: {
  modelType: string;
  configs: ConfigFile[];
  onUpdateSlot: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  onResetSlot: (slot: string) => void;
  onDone?: () => void;
}) {
  const allSections = useMemo(() => buildTrainingSections(), []);
  const [tab, setTab] = useState<SectionScope>("pipeline");
  const [activeSlot, setActiveSlot] = useState(configs[0]?.slot ?? "");
  const [activeSectionId, setActiveSectionId] = useState<string>(
    () => allSections.find((s) => s.scope === "pipeline")?.id ?? allSections[0]?.id ?? "",
  );

  const firstConfig = configs[0];
  const activeConfig = configs.find((c) => c.slot === activeSlot) ?? firstConfig;
  if (!activeConfig || !firstConfig) return null;

  const sections: ShellSection[] = allSections.filter((s) => s.scope === tab);
  const isPipeline = tab === "pipeline";

  // Pipeline scope: display the first config, write/reset ALL slots (shared).
  // Head scope: the active slot only.
  const hp = isPipeline ? firstConfig.hyperparams : activeConfig.hyperparams;
  const onUpdate = isPipeline
    ? (patch: Partial<ConfigHyperparams>) => configs.forEach((c) => onUpdateSlot(c.slot, patch))
    : (patch: Partial<ConfigHyperparams>) => onUpdateSlot(activeConfig.slot, patch);
  const onResetAll = isPipeline
    ? () => configs.forEach((c) => onResetSlot(c.slot))
    : () => onResetSlot(activeConfig.slot);

  // Rail click / search jump — switch tabs when the target lives in the other scope.
  function navigate(sectionId: string) {
    const scope = SCOPE_BY_SECTION[sectionId] ?? "pipeline";
    if (scope !== tab) setTab(scope);
    setActiveSectionId(sectionId);
  }

  function switchTab(next: SectionScope) {
    setTab(next);
    const first = allSections.find((s) => s.scope === next);
    if (first) setActiveSectionId(first.id);
  }

  const headerAccessory = (
    <div className="flex items-center gap-2">
      <SlotSwitcher
        slots={[{ id: "pipeline", label: "Pipeline" }, { id: "head", label: "Head" }]}
        active={tab}
        onChange={(id) => switchTab(id as SectionScope)}
      />
      {tab === "head" && (
        <SlotSwitcher
          slots={configs.map((c) => ({ id: c.slot, label: getSlotLabel(c.slot).replace(" Config", "") }))}
          active={activeConfig.slot}
          onChange={setActiveSlot}
        />
      )}
    </div>
  );

  return (
    <ConfigShell
      title="Training Configuration"
      sections={sections}
      searchIndex={TRAINING_SEARCH_INDEX}
      hp={hp}
      onUpdate={onUpdate}
      onResetAll={onResetAll}
      onDone={onDone}
      slot={isPipeline ? undefined : activeConfig.slot}
      modelType={modelType}
      headerAccessory={headerAccessory}
      activeSectionId={activeSectionId}
      onActiveSectionChange={navigate}
    />
  );
}
