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

const PIPELINE_TAB = "pipeline";

/**
 * Flat top tabs like the legacy top-down "Full Configuration": Pipeline, then one
 * tab per head slot (Centroid, Centered Instance). The Pipeline tab shows the
 * shared sections (displayed from the first config, written to ALL slots); each
 * head tab shows that slot's per-head sections. Owns the active tab so search can
 * jump across tabs; the ConfigShell renders each tab as one long scroll.
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
  const firstConfig = configs[0];
  // activeTab is PIPELINE_TAB or a head slot id. headSlot remembers the last head
  // tab, so a search jump from Pipeline into a head field returns you to it.
  const [activeTab, setActiveTab] = useState<string>(PIPELINE_TAB);
  const [headSlot, setHeadSlot] = useState(firstConfig?.slot ?? "");

  if (!firstConfig) return null;
  const isPipeline = activeTab === PIPELINE_TAB;
  const headConfig = configs.find((c) => c.slot === (isPipeline ? headSlot : activeTab)) ?? firstConfig;

  const sections: ShellSection[] = allSections.filter((s) => s.scope === (isPipeline ? "pipeline" : "head"));

  // Pipeline: display the first config, write/reset ALL slots. Head: the tab's slot.
  const hp = isPipeline ? firstConfig.hyperparams : headConfig.hyperparams;
  const onUpdate = isPipeline
    ? (patch: Partial<ConfigHyperparams>) => configs.forEach((c) => onUpdateSlot(c.slot, patch))
    : (patch: Partial<ConfigHyperparams>) => onUpdateSlot(headConfig.slot, patch);
  const onResetAll = isPipeline
    ? () => configs.forEach((c) => onResetSlot(c.slot))
    : () => onResetSlot(headConfig.slot);

  const tabs = [
    { id: PIPELINE_TAB, label: "Pipeline" },
    ...configs.map((c) => ({ id: c.slot, label: getSlotLabel(c.slot).replace(" Config", "") })),
  ];

  function selectTab(id: string) {
    setActiveTab(id);
    if (id !== PIPELINE_TAB) setHeadSlot(id);
  }

  // A search result may live in the other scope — switch tabs so it's rendered.
  function onSearchNavigate(sectionId: string) {
    const scope = SCOPE_BY_SECTION[sectionId] ?? "pipeline";
    if (scope === "pipeline") setActiveTab(PIPELINE_TAB);
    else if (isPipeline) setActiveTab(headSlot);
  }

  return (
    <ConfigShell
      title="Training Configuration"
      sections={sections}
      searchIndex={TRAINING_SEARCH_INDEX}
      hp={hp}
      onUpdate={onUpdate}
      onResetAll={onResetAll}
      onDone={onDone}
      slot={isPipeline ? undefined : headConfig.slot}
      modelType={modelType}
      headerAccessory={<SlotSwitcher slots={tabs} active={activeTab} onChange={selectTab} size="lg" />}
      onSearchNavigate={onSearchNavigate}
    />
  );
}
