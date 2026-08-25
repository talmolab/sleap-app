import { TRAINING_SECTIONS } from "@/lib/configSections";
import type { ShellSection, SectionRenderCtx } from "@/components/dialogs/config/ConfigShell";
import { ModelSection } from "@/components/dialogs/config/sections/ModelSection";
import { DataSection } from "@/components/dialogs/config/sections/DataSection";
import { AugmentationSection } from "@/components/dialogs/config/sections/AugmentationSection";
import { OptimizationSection } from "@/components/dialogs/config/sections/OptimizationSection";
import { PrePostprocessingSection } from "@/components/dialogs/config/sections/PreprocessingSection";
import { PerformanceSection } from "@/components/dialogs/config/sections/PerformanceSection";
import { WandBSection } from "@/components/dialogs/config/sections/WandbSection";
import { EvaluationSection } from "@/components/dialogs/config/sections/EvaluationSection";
import { OutputSection } from "@/components/dialogs/config/sections/OutputSection";

/** Section id → renderer for the training config shell. */
const TRAINING_RENDERERS: Record<string, (ctx: SectionRenderCtx) => React.ReactNode> = {
  model: (ctx) => <ModelSection {...ctx} />,
  data: (ctx) => <DataSection {...ctx} />,
  augmentation: (ctx) => <AugmentationSection {...ctx} />,
  optimization: (ctx) => <OptimizationSection {...ctx} />,
  preprocessing: (ctx) => <PrePostprocessingSection {...ctx} />,
  performance: (ctx) => <PerformanceSection {...ctx} />,
  wandb: (ctx) => <WandBSection {...ctx} />,
  evaluation: (ctx) => <EvaluationSection {...ctx} />,
  output: (ctx) => <OutputSection {...ctx} />,
};

/** The training taxonomy with each section's renderer attached. */
export function buildTrainingSections(): ShellSection[] {
  return TRAINING_SECTIONS.map((s) => ({ ...s, render: TRAINING_RENDERERS[s.id] }));
}
