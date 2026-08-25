import type { ConfigHyperparams } from "@/stores/trainingStore";
import type { ConfigSectionFields } from "@/lib/configDiff";

/** Whether a section is shared across heads (pipeline) or per-head (head). */
export type SectionScope = "pipeline" | "head";

/**
 * A section in the config shell's rail: a label, its scope, and the
 * hyperparameter fields it owns. `fields` is what the diff is computed over, so
 * every hyperparameter must live in exactly one section (enforced by
 * configSections.test.ts). Pipeline-scope sections are edited once and applied
 * to every config slot; head-scope sections are per-slot.
 */
export interface ConfigSection extends ConfigSectionFields {
  id: string;
  label: string;
  scope: SectionScope;
  fields: (keyof ConfigHyperparams)[];
}

/**
 * Training section taxonomy. Order within each scope is the rail display order.
 * Pipeline (shared across heads): Pre/Post-processing, Performance, WandB,
 * Evaluation, Output. Head (per-head): Data, Augmentation, Optimization, Model.
 */
export const TRAINING_SECTIONS: ConfigSection[] = [
  // ── Pipeline (shared across all heads) ──
  {
    id: "preprocessing",
    label: "Pre/Post-processing",
    scope: "pipeline",
    fields: ["colorMode"],
  },
  {
    id: "performance",
    label: "Performance",
    scope: "pipeline",
    fields: ["dataPipeline", "dataloaderWorkers", "accelerator", "numDevices"],
  },
  {
    id: "wandb",
    label: "WandB",
    scope: "pipeline",
    fields: [
      "useWandb",
      "wandbMode",
      "wandbApiKey",
      "wandbUploadViz",
      "wandbEntity",
      "wandbProject",
      "wandbPrevRunId",
      "wandbGroup",
    ],
  },
  {
    id: "evaluation",
    label: "Evaluation",
    scope: "pipeline",
    fields: ["evalEnabled", "evalFrequency"],
  },
  {
    id: "output",
    label: "Output",
    scope: "pipeline",
    fields: ["runName", "saveBestModel", "saveLastModel", "visualizePredictions", "keepVizImages"],
  },
  // ── Head (per-head) — Model first so the RF preview leads, as before ──
  {
    id: "model",
    label: "Model",
    scope: "head",
    fields: [
      "backbone",
      "trainingMode",
      "stemStride",
      "maxStride",
      "filters",
      "filtersRate",
      "middleBlock",
      "upInterpolate",
      "sigma",
      "outputStride",
      "anchorPart",
      "confmapsLossWeight",
      "pafsLossWeight",
      "classLossWeight",
    ],
  },
  {
    id: "data",
    label: "Data",
    scope: "head",
    fields: ["validationFraction", "overfitMode", "randomSeed", "scale", "cropSize"],
  },
  {
    id: "augmentation",
    label: "Augmentation",
    scope: "head",
    fields: [
      "rotationPreset",
      "rotationCustomAngle",
      "scaleEnabled",
      "scaleMin",
      "scaleMax",
      "uniformNoiseEnabled",
      "uniformNoiseMin",
      "uniformNoiseMax",
      "gaussianNoiseEnabled",
      "gaussianNoiseMean",
      "gaussianNoiseStd",
      "contrastEnabled",
      "contrastMin",
      "contrastMax",
      "brightnessEnabled",
      "brightnessMin",
      "brightnessMax",
    ],
  },
  {
    id: "optimization",
    label: "Optimization",
    scope: "head",
    fields: [
      "batchSize",
      "maxEpochs",
      "learningRate",
      "stopOnPlateau",
      "plateauMinDelta",
      "earlyStoppingPatience",
      "onlineMining",
      "minHardKeypoints",
      "maxHardKeypoints",
      "hardToEasyRatio",
      "lossScale",
    ],
  },
];
