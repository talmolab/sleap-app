/**
 * Field-level search for the config shell. Mirrors the legacy dialog's
 * SEARCHABLE_FIELDS: each field is indexed by its visible label plus keyword
 * synonyms (e.g. "lr" → Initial Learning Rate, "ohkm" → the mining fields), and
 * a query navigates to the section that owns the matching field.
 */
export interface SearchEntry {
  /** Section the field lives in (matches a TRAINING_SECTIONS id). */
  sectionId: string;
  /** The field's visible label. */
  label: string;
  /** Extra search synonyms, space-separated. */
  keywords?: string;
}

/**
 * Return the index entries whose label+keywords contain EVERY whitespace-token
 * of the query (case-insensitive AND). Empty query → no matches.
 */
export function matchConfigSearch(query: string, index: SearchEntry[]): SearchEntry[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return index.filter((e) => {
    const hay = `${e.label} ${e.keywords ?? ""}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

export const TRAINING_SEARCH_INDEX: SearchEntry[] = [
  // Model
  { sectionId: "model", label: "Backbone", keywords: "unet convnext swin transformer architecture" },
  { sectionId: "model", label: "Stem Stride", keywords: "downsampling stride" },
  { sectionId: "model", label: "Max Stride", keywords: "downsampling receptive field stride" },
  { sectionId: "model", label: "Filters", keywords: "channels" },
  { sectionId: "model", label: "Filters Rate", keywords: "channels scale" },
  { sectionId: "model", label: "Middle Block", keywords: "" },
  { sectionId: "model", label: "Up Interpolate", keywords: "bilinear upsampling" },
  { sectionId: "model", label: "Sigma", keywords: "confidence map spread gaussian" },
  { sectionId: "model", label: "Output Stride", keywords: "resolution downsample stride" },
  { sectionId: "model", label: "Confmaps Loss Weight", keywords: "loss weight confidence maps" },
  { sectionId: "model", label: "PAFs Loss Weight", keywords: "loss weight part affinity fields" },
  { sectionId: "model", label: "Class Loss Weight", keywords: "loss weight identity classification vectors maps" },
  // Data
  { sectionId: "data", label: "Validation Fraction", keywords: "val fraction split" },
  { sectionId: "data", label: "Overfit Mode", keywords: "overfit train val" },
  { sectionId: "data", label: "Random Seed", keywords: "seed reproducible split" },
  { sectionId: "data", label: "Input Scaling", keywords: "scale rescale downsample input" },
  { sectionId: "data", label: "Crop Size", keywords: "crop bounding box" },
  // Augmentation
  { sectionId: "augmentation", label: "Rotation", keywords: "augmentation angle rotate" },
  { sectionId: "augmentation", label: "Scale", keywords: "augmentation" },
  { sectionId: "augmentation", label: "Uniform Noise", keywords: "augmentation noise" },
  { sectionId: "augmentation", label: "Gaussian Noise", keywords: "augmentation noise" },
  { sectionId: "augmentation", label: "Contrast", keywords: "augmentation gamma" },
  { sectionId: "augmentation", label: "Brightness", keywords: "augmentation" },
  // Optimization
  { sectionId: "optimization", label: "Batch Size", keywords: "" },
  { sectionId: "optimization", label: "Epochs", keywords: "max epochs" },
  { sectionId: "optimization", label: "Initial Learning Rate", keywords: "lr learning rate" },
  { sectionId: "optimization", label: "Stop Training on Plateau", keywords: "early stopping plateau" },
  { sectionId: "optimization", label: "Plateau Min. Delta", keywords: "plateau min delta" },
  { sectionId: "optimization", label: "Plateau Patience", keywords: "early stopping patience plateau" },
  { sectionId: "optimization", label: "Online Mining", keywords: "ohkm hard keypoint mining" },
  { sectionId: "optimization", label: "Min Hard Keypoints", keywords: "ohkm mining online" },
  { sectionId: "optimization", label: "Max Hard Keypoints", keywords: "ohkm mining online" },
  { sectionId: "optimization", label: "Hard/Easy Ratio", keywords: "ohkm mining online ratio hard easy" },
  { sectionId: "optimization", label: "Loss Scale", keywords: "ohkm mining online loss scale" },
  // Pre/Post-processing
  { sectionId: "preprocessing", label: "Convert Colors", keywords: "ensure channels grayscale rgb color" },
  // Performance
  { sectionId: "performance", label: "Data Pipeline", keywords: "cache memory stream disk" },
  { sectionId: "performance", label: "Dataloader Workers", keywords: "" },
  { sectionId: "performance", label: "Accelerator", keywords: "gpu cuda mps cpu device hardware" },
  { sectionId: "performance", label: "Number of Devices", keywords: "gpu devices" },
  // WandB
  { sectionId: "wandb", label: "Enable WandB for logging", keywords: "wandb w&b weights and biases logging" },
  { sectionId: "wandb", label: "Offline Mode", keywords: "wandb w&b offline mode local sync network airgap" },
  { sectionId: "wandb", label: "API Key", keywords: "wandb w&b api key token auth login" },
  { sectionId: "wandb", label: "Upload Viz", keywords: "wandb w&b visualization" },
  { sectionId: "wandb", label: "Entity Name", keywords: "wandb w&b entity" },
  { sectionId: "wandb", label: "Project Name", keywords: "wandb w&b project" },
  { sectionId: "wandb", label: "Previous Run ID", keywords: "wandb w&b resume run id" },
  { sectionId: "wandb", label: "Group Name", keywords: "wandb w&b group" },
  // Evaluation
  { sectionId: "evaluation", label: "Run evaluation during training", keywords: "evaluation metrics moks map pck" },
  { sectionId: "evaluation", label: "Frequency (epochs)", keywords: "evaluation frequency epochs" },
  // Output
  { sectionId: "output", label: "Run Name", keywords: "" },
  { sectionId: "output", label: "Best Model", keywords: "save best model checkpoint" },
  { sectionId: "output", label: "Latest Model", keywords: "save last latest model checkpoint" },
  { sectionId: "output", label: "Visualize Predictions", keywords: "visualization viz predictions" },
  { sectionId: "output", label: "Keep Viz Images", keywords: "visualization viz images" },
];
