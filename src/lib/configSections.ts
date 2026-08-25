import type { ConfigHyperparams } from "@/stores/trainingStore";
import type { ConfigSectionFields } from "@/lib/configDiff";

/**
 * A section in the config shell's left rail: a label plus the hyperparameter
 * fields it owns. `fields` is what the diff/"modified" counts are computed over,
 * so every hyperparameter must live in exactly one section (enforced by
 * configSections.test.ts). The shell adds icon/render on top of this.
 */
export interface ConfigSection extends ConfigSectionFields {
  id: string;
  label: string;
  fields: (keyof ConfigHyperparams)[];
}

/**
 * Training section taxonomy — unifies the legacy pipeline/head tab headings into
 * one rail. Order is the display order in the rail.
 */
export const TRAINING_SECTIONS: ConfigSection[] = [
  {
    id: "model",
    label: "Model",
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
    fields: ["validationFraction", "overfitMode", "randomSeed", "scale", "cropSize"],
  },
  {
    id: "augmentation",
    label: "Augmentation",
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
  {
    id: "preprocessing",
    label: "Pre/Post-processing",
    fields: ["colorMode"],
  },
  {
    id: "performance",
    label: "Performance",
    fields: ["dataPipeline", "dataloaderWorkers", "accelerator", "numDevices"],
  },
  {
    id: "wandb",
    label: "WandB",
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
    fields: ["evalEnabled", "evalFrequency"],
  },
  {
    id: "output",
    label: "Output",
    fields: ["runName", "saveBestModel", "saveLastModel", "visualizePredictions", "keepVizImages"],
  },
];
