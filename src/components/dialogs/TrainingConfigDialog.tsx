import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LogNumberInput } from "@/components/LogNumberInput";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, HelpCircle, Crosshair } from "lucide-react";
import type { ConfigFile, ConfigHyperparams, Backbone, ModelType, DataPipeline, ColorMode } from "@/stores/trainingStore";
import { getSlotLabel, getConfigSlots, useTrainingStore } from "@/stores/trainingStore";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { ModelStatsPreview } from "@/components/dialogs/ModelStatsPreview";
import { getBaselineProfilesForHead, getDefaultProfileForHead, slotToHeadType } from "@/lib/trainingProfiles";
import { computeNodeVisibility, visibilityTier, type NodeVisibility } from "@/lib/anchorVisibility";

/** Tailwind text color per visibility tier, matching the Training panel's log coloring. */
const VISIBILITY_COLOR: Record<ReturnType<typeof visibilityTier>, string> = {
  high: "text-green-600 dark:text-green-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-destructive",
};

// ── Props ──────────────────────────────────────────────────────────

interface TrainingConfigDialogProps {
  open: boolean;
  onClose: () => void;
  modelType: ModelType;
  configs: ConfigFile[];
  onUpdateSlot: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  inferenceTarget: string;
  onInferenceTargetChange: (target: string) => void;
  remoteEnabled: boolean;
  onRemoteEnabledChange: (enabled: boolean) => void;
  skeletonNodes?: string[];
  sampleCount: number;
  onSampleCountChange: (v: number) => void;
  skipUserLabeled: boolean;
  onSkipUserLabeledChange: (v: boolean) => void;
  existingPredictions: "clear_all" | "replace" | "keep";
  onExistingPredictionsChange: (v: "clear_all" | "replace" | "keep") => void;
  /** Client-side only — no sleap-nn schema field for this, see trainingStore.ts. */
  autoOpenWandb: boolean;
  onAutoOpenWandbChange: (v: boolean) => void;
}

// ── Constants ──────────────────────────────────────────────────────

const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  single_animal: "Single Animal",
  top_down: "Top-Down",
  bottom_up: "Bottom-Up",
  top_down_id: "Top-Down + ID",
  bottom_up_id: "Bottom-Up + ID",
};

const MODEL_TYPE_DESCRIPTIONS: Record<ModelType, string> = {
  single_animal: 'This pipeline uses a single "confidence map" model to predict node locations for a single animal in the frame.',
  top_down: 'This pipeline uses two models: a "centroid" model to locate and crop around each animal in the frame, and a "centered-instance confidence map" model for predicted node locations for each individual animal predicted by the centroid model.',
  bottom_up: 'This pipeline uses a single "bottom-up" model that predicts confidence maps for all body parts and part affinity fields to group them into individual animals.',
  top_down_id: 'This pipeline uses two models: a "centroid" model to locate and crop around each animal in the frame, and a "top-down identity" model that predicts node locations and classifies identity for each individual animal.',
  bottom_up_id: 'This pipeline uses a single "bottom-up identity" model that predicts confidence maps, part affinity fields for grouping, and identity classification maps.',
};

const PIPELINE_NAV = [
  { id: "pipeline-type", label: "Pipeline Type" },
  { id: "pipeline-inference", label: "Inference Target" },
  { id: "pipeline-preprocessing", label: "Pre/Post-proc." },
  { id: "pipeline-performance", label: "Performance" },
  { id: "pipeline-wandb", label: "W&B" },
  { id: "pipeline-evaluation", label: "Evaluation" },
  { id: "pipeline-output", label: "Output" },
  { id: "pipeline-remote", label: "Remote Training" },
] as const;

const HEAD_NAV = [
  { id: "head-data", label: "Data" },
  { id: "head-augmentation", label: "Augmentation" },
  { id: "head-optimization", label: "Optimization" },
  { id: "head-model", label: "Model" },
] as const;

const BACKBONE_OPTIONS: { value: Backbone; label: string }[] = [
  { value: "unet", label: "UNet" },
  { value: "convnext", label: "ConvNeXt" },
  { value: "swint", label: "Swin Transformer" },
];

// ── Searchable field registry ──────────────────────────────────────
// Single source of truth for the search bar. Each entry's `id`, `label`
// (and `hint`, where the field renders one) is the SAME metadata rendered
// by the field below — Field/Toggle/SectionHeading rows spread the entry
// ({...DEF}); custom multi-input rows attach `id={DEF.id}` to the row and
// render `{DEF.label}` — so the index cannot silently drift from the UI.
// A field is searchable iff it appears here AND its id is wired into the
// JSX (rows carry `data-search-field` so tests can enforce both directions).
// `keywords` add search synonyms; `conditional` marks fields that only
// render for some model/head types. See tests/unit/trainingConfigSearch.test.tsx.
export type SearchField = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  conditional?: boolean;
};

const PIPELINE_FIELD_DEFS = {
  secType: { id: "pipeline-type", label: "Pipeline Type" },
  anchorPart: { id: "field-anchorpart", label: "Anchor Part", hint: "The body part used to center the crop around each animal. Choose one that is consistently visible and near the center of the animal.", conditional: true },
  sigmaCentroids: { id: "field-sigma-centroid", label: "Sigma for Centroids", hint: "Gaussian spread for centroid confidence maps. Controls how wide the target peak is around each animal's center point.", keywords: "sigma", conditional: true },
  sigmaNodes: { id: "field-sigma-nodes", label: "Sigma for Nodes", hint: "Gaussian spread for node confidence maps. Controls how wide the target peak is around each keypoint location.", keywords: "sigma" },
  secInference: { id: "pipeline-inference", label: "Inference Target" },
  inferenceTarget: { id: "field-inferencetarget", label: "Post-Training Inference Target", hint: "Which frames to run inference on after training completes. Predictions will be merged back into the project.", keywords: "inference target frames" },
  skipUserLabeled: { id: "field-skipuserlabeled", label: "Skip user labeled frames", hint: "Exclude frames that already have user-created labels from the inference target." },
  existingPredictions: { id: "field-existingpredictions", label: "Existing predictions", keywords: "clear all replace keep predictions" },
  secPreproc: { id: "pipeline-preprocessing", label: "Pre-processing / Post-processing", keywords: "preprocessing postprocessing" },
  convertColors: { id: "field-ensurechannels", label: "Convert Colors", hint: "Convert input images to a specific channel format. Use RGB for pretrained backbones or Grayscale for single-channel videos.", keywords: "ensure channels grayscale rgb" },
  maxInstances: { id: "field-maxinstances", label: "Max Instances", hint: "Maximum number of animal instances to detect per frame. Leave empty or check 'No max' for no limit." },
  filterOverlapping: { id: "field-filteroverlap", label: "Filter Overlapping Instances", keywords: "iou oks nms overlap" },
  secPerformance: { id: "pipeline-performance", label: "Performance" },
  dataPipeline: { id: "field-datapipeline", label: "Data Pipeline", hint: "How training data is loaded. 'Cache in Memory' is fastest but uses more RAM. 'Stream' reads from disk each epoch. 'Cache to Disk' saves processed data to disk.", keywords: "cache memory stream disk" },
  dataloaderWorkers: { id: "field-dataloaderworkers", label: "Dataloader Workers", hint: "Number of parallel workers for loading training data. More workers = faster data loading but more CPU/memory usage. 0 = main thread only. Only takes effect with a caching pipeline (Cache in Memory / Cache to Disk); the Stream pipeline forces 0." },
  accelerator: { id: "field-accelerator", label: "Accelerator", hint: "Hardware to use for training. 'Auto' detects available hardware. Use 'cuda' for NVIDIA GPUs, 'mps' for Apple Silicon, or 'cpu' for CPU-only (slow).", keywords: "gpu cuda mps cpu device hardware" },
  numDevices: { id: "field-numdevices", label: "Number of Devices", hint: "Number of GPUs/devices to use for training. Set to 1 for single-GPU training.", keywords: "gpu devices" },
  secWandb: { id: "pipeline-wandb", label: "WandB", keywords: "weights and biases w&b logging" },
  wandbEnable: { id: "field-wandb-enable", label: "Enable WandB for logging", hint: "Log training metrics, loss curves, and visualizations to Weights & Biases for experiment tracking.", keywords: "wandb w&b weights and biases" },
  wandbOffline: { id: "field-wandb-offline", label: "Offline Mode", hint: "Log to local disk only — no network or W&B login required. Upload later with `wandb sync`.", keywords: "wandb w&b offline mode local sync network airgap" },
  wandbApiKey: { id: "field-wandb-apikey", label: "API Key", hint: "W&B API key from wandb.ai/authorize. Optional — leave blank if you've run 'wandb login' or set the WANDB_API_KEY environment variable.", keywords: "wandb w&b api key token auth login" },
  wandbUploadViz: { id: "field-wandb-uploadviz", label: "Upload Viz", hint: "Upload prediction visualization images to W&B for remote viewing.", keywords: "wandb w&b" },
  wandbOpenBrowser: { id: "field-wandb-openbrowser", label: "Open in browser", hint: "Automatically open the W&B run page in your browser when training starts.", keywords: "wandb w&b" },
  wandbEntity: { id: "field-wandb-entity", label: "Entity Name", keywords: "wandb w&b entity" },
  wandbProject: { id: "field-wandb-project", label: "Project Name", keywords: "wandb w&b project" },
  wandbRunId: { id: "field-wandb-runid", label: "Previous Run ID", keywords: "wandb w&b resume" },
  wandbGroup: { id: "field-wandb-group", label: "Group Name", keywords: "wandb w&b" },
  secEvaluation: { id: "pipeline-evaluation", label: "Evaluation" },
  evalEnable: { id: "field-eval-enable", label: "Run evaluation during training", hint: "Run inference on validation frames at epoch intervals and compute pose metrics (mOKS, mAP, PCK). Useful for monitoring training quality beyond loss.", keywords: "evaluation metrics moks map pck" },
  evalFrequency: { id: "field-eval-frequency", label: "Frequency (epochs)", keywords: "evaluation frequency epochs" },
  secOutput: { id: "pipeline-output", label: "Output" },
  runName: { id: "field-runname", label: "Run Name", hint: "Name for this training run. Leave empty to auto-generate from timestamp and head type." },
  runsFolder: { id: "field-runsfolder", label: "Runs Folder", hint: "Directory where the run folder and checkpoints will be created." },
  checkpoint: { id: "field-checkpoint", label: "Checkpoint", hint: "Best Model saves the highest-scoring checkpoint (by validation loss). Latest Model also saves a last.ckpt after every checkpoint, useful for resuming training.", keywords: "best model latest model save" },
  visualization: { id: "field-visualization", label: "Visualization", hint: "Visualize Predictions saves sample prediction images each epoch (used by this app's epoch scrubber to review training progress). Keep Viz Images keeps that folder after training instead of deleting it; only has an effect when Visualize Predictions is on.", keywords: "visualize predictions keep viz images" },
  secRemote: { id: "pipeline-remote", label: "Remote Training" },
  remoteEnable: { id: "field-remoteenable", label: "Enable Remote Training", hint: "Send training jobs to a remote worker via sleap-connect instead of running locally.", keywords: "remote worker sleap-connect" },
} satisfies Record<string, SearchField>;

const HEAD_FIELD_DEFS = {
  secData: { id: "head-data", label: "Data" },
  validationFraction: { id: "field-validationfraction", label: "Validation Fraction", hint: 'Fraction of labeled frames to use as a validation set. Ignored if "Overfit Mode" is enabled.', keywords: "val fraction split" },
  overfitMode: { id: "field-overfitmode", label: "Overfit Mode (train=val)", hint: "If enabled, the same data will be used for both training and validation. This is useful for intentional overfitting on small datasets (fewer than 10 labeled frames) to test model capacity.", keywords: "overfit" },
  randomSeed: { id: "field-randomseed", label: "Random Seed", keywords: "seed reproducible split" },
  inputScaling: { id: "field-inputscaling", label: "Input Scaling", keywords: "scale rescale downsample input scale" },
  cropSize: { id: "field-cropsize", label: "Crop Size", keywords: "crop bounding box", conditional: true },
  secAugmentation: { id: "head-augmentation", label: "Augmentation" },
  rotation: { id: "field-rotation", label: "Rotation", keywords: "augmentation angle rotate" },
  scaleAug: { id: "field-scaleaug", label: "Scale", keywords: "scale augmentation" },
  uniformNoise: { id: "field-uniformnoise", label: "Uniform Noise", keywords: "augmentation noise" },
  gaussianNoise: { id: "field-gaussiannoise", label: "Gaussian Noise", keywords: "augmentation noise" },
  contrast: { id: "field-contrast", label: "Contrast", keywords: "augmentation gamma" },
  brightness: { id: "field-brightness", label: "Brightness", keywords: "augmentation" },
  secOptimization: { id: "head-optimization", label: "Optimization" },
  batchSize: { id: "field-batchsize", label: "Batch Size", hint: "Number of examples per minibatch. Higher numbers can increase generalization by averaging gradient updates over more examples, at the cost of more GPU memory. Lower numbers may lead to overfitting but can help optimization with few varied examples." },
  maxEpochs: { id: "field-maxepochs", label: "Epochs", hint: "Maximum number of epochs to train for. Training can be stopped manually or automatically if early stopping is enabled and a plateau is detected.", keywords: "max epochs" },
  learningRate: { id: "field-learningrate", label: "Initial Learning Rate", hint: "The initial learning rate for the optimizer. Typically 1e-3 or 1e-4. Can be decreased automatically with learning rate reduction on plateau. If too high or too low, training may fail to find good initial local minima.", keywords: "lr learning rate" },
  stopOnPlateau: { id: "field-stoponplateau", label: "Stop Training on Plateau", hint: "If enabled, training will terminate automatically when the validation loss plateaus. This saves time and compute, and prevents training into the overfitting regime.", keywords: "early stopping plateau" },
  plateauMinDelta: { id: "field-plateaumindelta", label: "Plateau Min. Delta", hint: "Minimum absolute decrease in the loss in order to consider an epoch as not in a plateau.", keywords: "plateau min delta" },
  plateauPatience: { id: "field-earlystopping", label: "Plateau Patience", hint: "Number of epochs without an improvement of at least min_delta in order for a plateau to be detected.", keywords: "early stopping patience plateau" },
  onlineMining: { id: "field-onlinemining", label: "Online Mining", hint: "If enabled, online hard keypoint mining (OHKM) will compute loss per keypoint, sort from easy to hard, and scale hard keypoints to have higher weight. This encourages training to focus on tricky body parts. If disabled, all keypoints are weighted equally.", keywords: "ohkm hard keypoint mining" },
  minHardKeypoints: { id: "field-minhardkeypoints", label: "Min Hard Keypoints", keywords: "ohkm mining online" },
  maxHardKeypoints: { id: "field-maxhardkeypoints", label: "Max Hard Keypoints", keywords: "ohkm mining online" },
  secModel: { id: "head-model", label: "Model" },
  backbone: { id: "field-backbone", label: "Backbone", hint: "Select the backbone architecture. UNet is the default and works well for most cases. ConvNeXt and Swin Transformer support pretrained ImageNet weights but require RGB images.", keywords: "unet convnext swin architecture" },
  stemStride: { id: "field-stemstride", label: "Stem Stride", keywords: "downsampling stride" },
  maxStride: { id: "field-maxstride", label: "Max Stride", keywords: "downsampling receptive field stride" },
  filters: { id: "field-filters", label: "Filters", keywords: "channels" },
  filtersRate: { id: "field-filtersrate", label: "Filters Rate", keywords: "channels scale" },
  middleBlock: { id: "field-middleblock", label: "Middle Block" },
  upInterpolate: { id: "field-upinterpolate", label: "Up Interpolate", keywords: "bilinear upsampling" },
  sigma: { id: "field-sigma", label: "Sigma", hint: "Spread of the Gaussian distribution of the confidence maps. Smaller values are more precise but harder to learn. Larger values are easier to learn but less precise. This spread is in units of pixels of the model input image (after any input scaling)." },
  outputStride: { id: "field-outputstride", label: "Output Stride", keywords: "resolution downsample stride" },
  confmapsLossWeight: { id: "field-confmapsweight", label: "Confmaps Loss Weight", keywords: "loss weight", conditional: true },
  pafsLossWeight: { id: "field-pafsweight", label: "PAFs Loss Weight", keywords: "loss weight part affinity fields", conditional: true },
  classVectorsLossWeight: { id: "field-classvectorsweight", label: "Class Vectors Loss Weight", keywords: "loss weight identity classification", conditional: true },
  classMapsLossWeight: { id: "field-classmapsweight", label: "Class Maps Loss Weight", keywords: "loss weight identity classification", conditional: true },
} satisfies Record<string, SearchField>;

export type IndexedField = SearchField & { tab: "pipeline" | "head" };

export const SEARCHABLE_FIELDS: IndexedField[] = [
  ...Object.values(PIPELINE_FIELD_DEFS).map((f) => ({ ...f, tab: "pipeline" as const })),
  ...Object.values(HEAD_FIELD_DEFS).map((f) => ({ ...f, tab: "head" as const })),
];

/**
 * Case-insensitive match against label + hint + keywords. Every whitespace-
 * separated token in the query must appear somewhere in the field's text, so
 * multi-word queries ("wandb entity", "learning rate") match even when the
 * words are not contiguous in the label/keyword list.
 */
export function fieldMatchesQuery(f: SearchField, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const haystack = `${f.label} ${f.hint ?? ""} ${f.keywords ?? ""}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

// ── Shared components ──────────────────────────────────────────────

function HintBubble({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span className="relative">
      <HelpCircle
        className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help"
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPos({ x: rect.left + rect.width / 2, y: rect.top });
        }}
        onMouseLeave={() => setPos(null)}
      />
      {pos && createPortal(
        <span
          className="fixed z-[9999] px-3 py-2 text-xs bg-popover border rounded-md shadow-lg w-64 text-foreground leading-relaxed"
          style={{ left: pos.x, top: pos.y - 8, transform: "translate(-50%, -100%)" }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

function Field({ label, id, hint, children }: { label: string; id?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div id={id} data-search-field={id ? "" : undefined} className="flex items-center gap-6 py-2.5 scroll-mt-4">
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function Toggle({ label, id, hint, checked, onChange, disabled = false }: { label: string; id?: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div id={id} data-search-field={id ? "" : undefined} className={`flex items-center gap-6 py-2.5 scroll-mt-4 ${disabled ? "opacity-50" : ""}`}>
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <button
        disabled={disabled}
        className={`w-10 h-6 rounded-full relative transition-colors ${checked ? "bg-primary" : "bg-zinc-700"} ${disabled ? "cursor-not-allowed" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

/**
 * The top-down anchor-part picker, shown once above the centroid /
 * centered-instance tab split (it's one concept — where to crop around each
 * animal — not a per-head setting). Writes into the `centered_instance`
 * slot's hyperparams, which is what actually gets serialized to
 * `centered_instance.confmaps.anchor_part`.
 */
function PipelineAnchorPartField({
  hp,
  onUpdate,
  skeletonNodes,
  nodeVisibility,
}: {
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  skeletonNodes: string[];
  nodeVisibility: Map<string, NodeVisibility>;
}) {
  const pickedAnchorNode = useAppStore((s) => s.pickedAnchorNode);
  const [myPickRequestId, setMyPickRequestId] = useState<number | null>(null);
  const hasLabeledData = [...nodeVisibility.values()].some((v) => v.total > 0);

  useEffect(() => {
    if (myPickRequestId == null || !pickedAnchorNode) return;
    if (pickedAnchorNode.requestId !== myPickRequestId) return;
    onUpdate({ anchorPart: pickedAnchorNode.nodeName });
    setMyPickRequestId(null);
    useAppStore.getState().clearPickedAnchorNode();
  }, [pickedAnchorNode, myPickRequestId, onUpdate]);

  return (
    <div id={PIPELINE_FIELD_DEFS.anchorPart.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
        {PIPELINE_FIELD_DEFS.anchorPart.label}
        <HintBubble text="The body part used to center the crop around each animal. Choose one that is consistently visible and near the center of the animal." />
      </span>
      <Select value={hp.anchorPart ?? "__auto__"} onValueChange={(v) => onUpdate({ anchorPart: v === "__auto__" ? null : v })}>
        <SelectTrigger className="h-8 text-sm w-40"><SelectValue placeholder="Auto" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__auto__">Auto (bbox center)</SelectItem>
          {skeletonNodes.map((n) => {
            const vis = nodeVisibility.get(n);
            return (
              <SelectItem key={n} value={n}>
                <span className="flex items-center gap-1.5">
                  {n}
                  {vis && vis.total > 0 && (
                    <span className={`text-xs ${VISIBILITY_COLOR[visibilityTier(vis.pct)]}`}>
                      {vis.pct}%
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <button
        className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md border border-input text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:border-input"
        disabled={!hasLabeledData}
        title={hasLabeledData ? "Pick anchor from canvas" : "No labeled frames in this project yet"}
        onClick={() => setMyPickRequestId(useAppStore.getState().startAnchorPick())}
      >
        <Crosshair className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SectionHeading({ id, label }: { id: string; label: string }) {
  return (
    <h3 id={id} data-search-field="" className="text-base font-medium pt-6 pb-3 first:pt-0 scroll-mt-4">
      {label}
    </h3>
  );
}

// ── Per-head tab content ───────────────────────────────────────────

function HeadTabContent({
  slot,
  modelType,
  configFile,
  hp,
  onUpdate,
  scrollRefCallback,
}: {
  slot: string;
  modelType: ModelType;
  configFile: ConfigFile | undefined;
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  scrollRefCallback: (el: HTMLDivElement | null) => void;
}) {
  const headType = slotToHeadType(modelType, slot);
  const baselineProfiles = getBaselineProfilesForHead(headType);
  const showCropSize = slot !== "centroid";
  const trainingMode = (!configFile?.hasTrainedModel && hp.trainingMode !== "reuse_config")
    ? "reuse_config"
    : (hp.trainingMode ?? "reuse_config");
  const modelLocked = trainingMode === "resume" || trainingMode === "reuse_model";
  const allLocked = trainingMode === "reuse_model";
  const { parseYamlConfig, addConfigFile } = useTrainingStore();

  const handleConfigBrowse = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".yaml,.yml";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result as string;
          const parsed = parseYamlConfig(text, file.name, slot);
          if (parsed) {
            if (parsed.modelType !== slot && parsed.modelType !== "unknown") {
              window.alert(
                `The file you selected was a training config for ${parsed.modelType} and cannot be used for ${slot}.`
              );
            }
            addConfigFile(parsed);
          } else {
            window.alert("The file you selected was not a valid training config.");
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  return (
    <div ref={scrollRefCallback} className="h-full overflow-y-auto px-8 py-6 bg-muted/20">
      {/* ── Config file selector (dropdown like PyQt) ── */}
      <div className="mb-5 pb-4 border-b">
        <Select
          value={configFile ? configFile.filename : ""}
          onValueChange={(v) => {
            if (v === "__browse__") {
              handleConfigBrowse();
            } else {
              const baseline = baselineProfiles.find((p) => p.filename === v);
              if (baseline) {
                const parsed = parseYamlConfig(baseline.content, baseline.filename, slot);
                if (parsed) addConfigFile(parsed);
              }
            }
          }}
        >
          <SelectTrigger className="h-10 text-sm font-mono bg-background">
            <SelectValue placeholder="Select training config file..." />
          </SelectTrigger>
          <SelectContent>
            {baselineProfiles.map((p) => (
              <SelectItem key={p.filename} value={p.filename}>
                [{p.filename.replace(".yaml", "")}] ({p.filename})
              </SelectItem>
            ))}
            {configFile && !baselineProfiles.some((p) => p.filename === configFile.filename) && (
              <SelectItem value={configFile.filename}>
                {(() => {
                  const runNameMatch = configFile.content.match(/run_name:\s*(.+)/);
                  const runName = runNameMatch?.[1]?.trim();
                  return runName && runName !== "null"
                    ? `[Trained] ${runName} (${configFile.filename})`
                    : `[${configFile.modelType}] (${configFile.filename})`;
                })()}
              </SelectItem>
            )}
            <SelectItem value="__browse__" className="text-primary font-medium">
              Browse for config file...
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Training mode radios ── */}
      <div className="flex items-center gap-5 mb-5 pb-4 border-b">
        {([
          { value: "reuse_config" as const, label: "Reuse config (train from scratch)", alwaysEnabled: true },
          { value: "resume" as const, label: "Resume training (fine-tune)", alwaysEnabled: false },
          { value: "reuse_model" as const, label: "Reuse model (don't retrain)", alwaysEnabled: false },
        ]).map((opt) => {
          const disabled = !opt.alwaysEnabled && !configFile?.hasTrainedModel;
          return (
            <label key={opt.value} className={`flex items-center gap-1.5 ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
              <input
                type="radio"
                name={`training-mode-${slot}`}
                checked={trainingMode === opt.value}
                onChange={() => onUpdate({ trainingMode: opt.value })}
                className="accent-primary"
                disabled={disabled}
              />
              <span className="text-sm">{opt.label}</span>
            </label>
          );
        })}
      </div>

      {/* ── Model Stats Preview (thumbnail + RF + crop size + params) ── */}
      <ModelStatsPreview hp={hp} maxStride={hp.maxStride} filters={hp.filters} filtersRate={hp.filtersRate} outputStride={hp.outputStride} stemStride={hp.stemStride} backbone={hp.backbone || "unet"} slot={slot} />

      {/* ── 1. Data ── */}
      <div className={allLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading {...HEAD_FIELD_DEFS.secData} />
      <div className="space-y-2">
        <div className={hp.overfitMode ? "opacity-50" : ""}>
          <Field {...HEAD_FIELD_DEFS.validationFraction}>
            <Input type="number" value={hp.validationFraction} onChange={(e) => onUpdate({ validationFraction: Number(e.target.value) })} min={0} max={1} step={0.05} className="h-9 text-sm" disabled={hp.overfitMode} />
          </Field>
        </div>
        <div className="flex items-center gap-6">
          <Toggle {...HEAD_FIELD_DEFS.overfitMode} checked={hp.overfitMode} onChange={(v) => onUpdate({ overfitMode: v })} />
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div id={HEAD_FIELD_DEFS.randomSeed.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.randomSeed.label}
              <HintBubble text="Random seed for reproducible train/validation data splits. Leave empty (Auto) for random seed each run." />
            </span>
            <Input type="number" value={hp.randomSeed ?? ""} onChange={(e) => onUpdate({ randomSeed: e.target.value ? Number(e.target.value) : null })} disabled={hp.randomSeed === null} placeholder="0" className="h-8 text-sm w-20" />
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={hp.randomSeed === null} onChange={(e) => onUpdate({ randomSeed: e.target.checked ? null : 0 })} className="accent-primary" />
            <span className="text-sm">Auto</span>
          </label>
        </div>
        <Field {...HEAD_FIELD_DEFS.inputScaling} hint="Rescaling factor applied to input images before training. Values less than 1.0 downsample the image, which reduces memory usage and speeds up training at the cost of spatial resolution. Note that crop size and sigma values are relative to the scaled image.">
          <Input type="number" value={hp.scale} onChange={(e) => onUpdate({ scale: Number(e.target.value) })} min={0.125} max={1} step={0.125} className="h-9 text-sm" />
        </Field>
        {showCropSize && (
          <div className="flex items-center gap-4">
            <Field {...HEAD_FIELD_DEFS.cropSize} hint="Bounding box crop size around each instance in pixels. Set to 'Auto' to compute from the data (largest instance bounding box, aligned to max_stride).">
              <Input type="number" value={hp.cropSize ?? ""} onChange={(e) => onUpdate({ cropSize: e.target.value ? Number(e.target.value) : null })} disabled={hp.cropSize === null} className="h-9 text-sm" />
            </Field>
            <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
              <input type="checkbox" checked={hp.cropSize === null} onChange={(e) => onUpdate({ cropSize: e.target.checked ? null : 256 })} className="accent-primary" />
              <span className="text-sm">Auto</span>
            </label>
          </div>
        )}
      </div>

      </div>

      <Separator className="my-5" />

      {/* ── 2. Augmentation ── */}
      <div className={allLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading {...HEAD_FIELD_DEFS.secAugmentation} />
      <div className="space-y-2">
        {/* Rotation */}
        <div id={HEAD_FIELD_DEFS.rotation.id} data-search-field="" className="flex items-center gap-2 mb-2 scroll-mt-4">
          <span className="text-sm text-muted-foreground flex items-center gap-1.5">
            {HEAD_FIELD_DEFS.rotation.label}
            <HintBubble text="Rotation augmentation range. Off: disabled. ±15°: for side-view cameras where upside-down would be unnatural. ±180°: for top-view/overhead cameras where all orientations are valid." />
          </span>
          <Select value={hp.rotationPreset} onValueChange={(v) => onUpdate({ rotationPreset: v as "off" | "15" | "180" | "custom" })}>
            <SelectTrigger className="h-8 text-sm w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="15">&plusmn;15&deg;</SelectItem>
              <SelectItem value="180">&plusmn;180&deg;</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {hp.rotationPreset === "custom" && (
          <div className="flex items-center gap-2 pl-6 mb-2">
            <span className="text-sm text-muted-foreground">Angle (&plusmn;&deg;)</span>
            <Input type="number" value={hp.rotationCustomAngle} onChange={(e) => onUpdate({ rotationCustomAngle: Number(e.target.value) })} min={0} max={180} step={1} className="h-8 text-sm w-20" />
          </div>
        )}

        {/* Scale */}
        <div className="space-y-2">
          <label id={HEAD_FIELD_DEFS.scaleAug.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.scaleEnabled} onChange={(e) => onUpdate({ scaleEnabled: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.scaleAug.label} <HintBubble text="Enable random scaling augmentation. Scaling is applied independently with 100% probability when enabled." /></span>
          </label>
          {hp.scaleEnabled && (
            <div className="flex items-center gap-4 pl-6">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Scale Min</span>
                <Input type="number" value={hp.scaleMin} onChange={(e) => onUpdate({ scaleMin: Number(e.target.value) })} min={0.1} max={2} step={0.05} className="h-8 text-sm w-20" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Scale Max</span>
                <Input type="number" value={hp.scaleMax} onChange={(e) => onUpdate({ scaleMax: Number(e.target.value) })} min={0.1} max={2} step={0.05} className="h-8 text-sm w-20" />
              </div>
            </div>
          )}

          {/* Uniform Noise */}
          <label id={HEAD_FIELD_DEFS.uniformNoise.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.uniformNoiseEnabled} onChange={(e) => onUpdate({ uniformNoiseEnabled: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.uniformNoise.label} <HintBubble text="Enable uniformly distributed noise augmentation." /></span>
          </label>
          {hp.uniformNoiseEnabled && (
            <div className="flex items-center gap-4 pl-6">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Min Val</span>
                <Input type="number" value={hp.uniformNoiseMin} onChange={(e) => onUpdate({ uniformNoiseMin: Number(e.target.value) })} min={0} max={1} step={0.01} className="h-8 text-sm w-20" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Max Val</span>
                <Input type="number" value={hp.uniformNoiseMax} onChange={(e) => onUpdate({ uniformNoiseMax: Number(e.target.value) })} min={0} max={1} step={0.01} className="h-8 text-sm w-20" />
              </div>
            </div>
          )}

          {/* Gaussian Noise */}
          <label id={HEAD_FIELD_DEFS.gaussianNoise.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.gaussianNoiseEnabled} onChange={(e) => onUpdate({ gaussianNoiseEnabled: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.gaussianNoise.label} <HintBubble text="Enable normally distributed noise augmentation. This is applied independently to each pixel." /></span>
          </label>
          {hp.gaussianNoiseEnabled && (
            <div className="flex items-center gap-4 pl-6">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Mean</span>
                <Input type="number" value={hp.gaussianNoiseMean} onChange={(e) => onUpdate({ gaussianNoiseMean: Number(e.target.value) })} step={0.01} className="h-8 text-sm w-20" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Std Dev</span>
                <Input type="number" value={hp.gaussianNoiseStd} onChange={(e) => onUpdate({ gaussianNoiseStd: Number(e.target.value) })} step={0.01} className="h-8 text-sm w-20" />
              </div>
            </div>
          )}

          {/* Contrast */}
          <label id={HEAD_FIELD_DEFS.contrast.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.contrastEnabled} onChange={(e) => onUpdate({ contrastEnabled: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.contrast.label} <HintBubble text="Enable gamma contrast adjustment. This scales all pixel values by x^gamma where x is in [0, 1]." /></span>
          </label>
          {hp.contrastEnabled && (
            <div className="flex items-center gap-4 pl-6">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Contrast Min</span>
                <Input type="number" value={hp.contrastMin} onChange={(e) => onUpdate({ contrastMin: Number(e.target.value) })} min={0.5} max={2} step={0.05} className="h-8 text-sm w-20" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Contrast Max</span>
                <Input type="number" value={hp.contrastMax} onChange={(e) => onUpdate({ contrastMax: Number(e.target.value) })} min={0.5} max={2} step={0.05} className="h-8 text-sm w-20" />
              </div>
            </div>
          )}

          {/* Brightness */}
          <label id={HEAD_FIELD_DEFS.brightness.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.brightnessEnabled} onChange={(e) => onUpdate({ brightnessEnabled: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.brightness.label} <HintBubble text="Enable brightness augmentation. This adds the same value to all pixels to simulate illumination change." /></span>
          </label>
          {hp.brightnessEnabled && (
            <div className="flex items-center gap-4 pl-6">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Brightness Min</span>
                <Input type="number" value={hp.brightnessMin} onChange={(e) => onUpdate({ brightnessMin: Number(e.target.value) })} step={0.01} className="h-8 text-sm w-20" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Brightness Max</span>
                <Input type="number" value={hp.brightnessMax} onChange={(e) => onUpdate({ brightnessMax: Number(e.target.value) })} step={0.01} className="h-8 text-sm w-20" />
              </div>
            </div>
          )}
        </div>
      </div>
      </div>

      <Separator className="my-5" />

      {/* ── 3. Optimization ── */}
      <div className={allLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading {...HEAD_FIELD_DEFS.secOptimization} />
      <div className="space-y-2">
        <Field {...HEAD_FIELD_DEFS.batchSize}>
          <Input type="number" value={hp.batchSize} onChange={(e) => onUpdate({ batchSize: Number(e.target.value) })} min={1} max={128} className="h-9 text-sm" />
        </Field>
        <Field {...HEAD_FIELD_DEFS.maxEpochs}>
          <Input type="number" value={hp.maxEpochs} onChange={(e) => onUpdate({ maxEpochs: Number(e.target.value) })} min={1} className="h-9 text-sm" />
        </Field>
        <Field {...HEAD_FIELD_DEFS.learningRate}>
          <Input type="number" value={hp.learningRate} onChange={(e) => onUpdate({ learningRate: Number(e.target.value) })} step={0.0001} className="h-9 text-sm" />
        </Field>
        <Toggle {...HEAD_FIELD_DEFS.stopOnPlateau} checked={hp.stopOnPlateau} onChange={(v) => onUpdate({ stopOnPlateau: v })} />
        <Field {...HEAD_FIELD_DEFS.plateauMinDelta}>
          <Input type="text" value={hp.plateauMinDelta} onChange={(e) => onUpdate({ plateauMinDelta: Number(e.target.value) })} disabled={!hp.stopOnPlateau} className="h-9 text-sm" />
        </Field>
        <Field {...HEAD_FIELD_DEFS.plateauPatience}>
          <Input type="number" value={hp.earlyStoppingPatience} onChange={(e) => onUpdate({ earlyStoppingPatience: Number(e.target.value) })} min={1} max={100} disabled={!hp.stopOnPlateau} className="h-9 text-sm" />
        </Field>
        <Toggle {...HEAD_FIELD_DEFS.onlineMining} checked={hp.onlineMining} onChange={(v) => onUpdate({ onlineMining: v })} />
        <div className={`flex items-center gap-4 flex-wrap ${!hp.onlineMining ? "opacity-50" : ""}`}>
          <div id={HEAD_FIELD_DEFS.minHardKeypoints.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.minHardKeypoints.label}
              <HintBubble text="The minimum number of keypoints that will be considered as 'hard', even if they are not below the hard_to_easy_ratio." />
            </span>
            <Input type="number" value={hp.minHardKeypoints} onChange={(e) => onUpdate({ minHardKeypoints: Number(e.target.value) })} disabled={!hp.onlineMining} className="h-8 text-sm w-16" />
          </div>
          <div id={HEAD_FIELD_DEFS.maxHardKeypoints.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.maxHardKeypoints.label}
              <HintBubble text="The maximum number of hard keypoints to apply scaling to. This can help when there are few very easy keypoints which may skew the ratio." />
            </span>
            <Input type="number" value={hp.maxHardKeypoints ?? ""} onChange={(e) => onUpdate({ maxHardKeypoints: e.target.value ? Number(e.target.value) : null })} disabled={!hp.onlineMining} placeholder="None" className="h-8 text-sm w-16" />
          </div>
        </div>
      </div>
      </div>

      <Separator className="my-5" />

      {/* ── 4. Model ── */}
      <div className={modelLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading {...HEAD_FIELD_DEFS.secModel} />
      <div className="space-y-2">
        <Field {...HEAD_FIELD_DEFS.backbone}>
          <Select value={hp.backbone || ""} onValueChange={(v) => onUpdate({ backbone: v as Backbone })}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="From config..." /></SelectTrigger>
            <SelectContent>
              {BACKBONE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Separator className="my-3" />
        <div className="flex items-center gap-6 flex-wrap">
          <div id={HEAD_FIELD_DEFS.stemStride.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.stemStride.label}
              <HintBubble text="If not None, controls how many stem blocks to use for initial downsampling. These are useful for learned downsampling that retains spatial information while reducing large input image sizes." />
            </span>
            <Input type="number" value={hp.stemStride ?? ""} onChange={(e) => onUpdate({ stemStride: e.target.value ? Number(e.target.value) : null })} disabled={hp.stemStride === null} placeholder="0" className="h-8 text-sm w-16" />
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={hp.stemStride === null} onChange={(e) => onUpdate({ stemStride: e.target.checked ? null : 0 })} className="accent-primary" />
              <span className="text-sm">None</span>
            </label>
          </div>
        </div>
        <div className="flex items-center gap-6 flex-wrap">
          <div id={HEAD_FIELD_DEFS.maxStride.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.maxStride.label}
              <HintBubble text="Determines the number of downsampling blocks in the network, increasing receptive field size at the cost of network size." />
            </span>
            <Select value={String(hp.maxStride)} onValueChange={(v) => onUpdate({ maxStride: Number(v) })}>
              <SelectTrigger className="h-8 text-sm w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[2, 4, 8, 16, 32, 64, 128].map((v) => <SelectItem key={v} value={String(v)}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div id={HEAD_FIELD_DEFS.filters.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.filters.label}
              <HintBubble text="Base number of filters in the network." />
            </span>
            <Input type="number" value={hp.filters} onChange={(e) => onUpdate({ filters: Number(e.target.value) })} className="h-8 text-sm w-16" />
          </div>
        </div>
        <div className="flex items-center gap-6 flex-wrap">
          <div id={HEAD_FIELD_DEFS.filtersRate.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {HEAD_FIELD_DEFS.filtersRate.label}
              <HintBubble text="Factor to scale the number of filters by at each block." />
            </span>
            <Input type="number" value={hp.filtersRate} onChange={(e) => onUpdate({ filtersRate: Number(e.target.value) })} step={0.1} className="h-8 text-sm w-20" />
          </div>
          <label id={HEAD_FIELD_DEFS.middleBlock.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.middleBlock} onChange={(e) => onUpdate({ middleBlock: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.middleBlock.label} <HintBubble text="If enabled, adds an intermediate block between the downsampling and upsampling branch for additional processing at the largest receptive field size." /></span>
          </label>
          <label id={HEAD_FIELD_DEFS.upInterpolate.id} data-search-field="" className="flex items-center gap-1.5 cursor-pointer scroll-mt-4">
            <input type="checkbox" checked={hp.upInterpolate} onChange={(e) => onUpdate({ upInterpolate: e.target.checked })} className="accent-primary" />
            <span className="text-sm flex items-center gap-1">{HEAD_FIELD_DEFS.upInterpolate.label} <HintBubble text="If enabled, use bilinear upsampling instead of transposed convolutions. This can save computations but may lower overall accuracy." /></span>
          </label>
        </div>
        <Separator className="my-3" />
        <h4 className="text-sm font-medium text-muted-foreground mb-2">Head</h4>
        <Field {...HEAD_FIELD_DEFS.sigma}>
          <Input type="number" value={hp.sigma} onChange={(e) => onUpdate({ sigma: Number(e.target.value) })} min={0.5} max={30} step={0.5} className="h-9 text-sm" />
        </Field>
        <div id={HEAD_FIELD_DEFS.outputStride.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
          <span className="text-sm text-muted-foreground flex items-center gap-1.5">
            {HEAD_FIELD_DEFS.outputStride.label}
            <HintBubble text="The stride of the output confidence maps relative to the input image. This is the reciprocal of the resolution (e.g., stride 2 = 0.5x size). Increasing this value speeds up performance and decreases memory, at the cost of spatial resolution." />
          </span>
          <Select value={String(hp.outputStride)} onValueChange={(v) => onUpdate({ outputStride: Number(v) })}>
            <SelectTrigger className="h-8 text-sm w-20"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1, 2, 4, 8, 16, 32, 64].map((v) => <SelectItem key={v} value={String(v)}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {headType === "bottomup" && (
          <>
            <Field {...HEAD_FIELD_DEFS.confmapsLossWeight} hint="Loss weight for the confidence maps head. Increase to prioritize this head during multi-head training.">
              <LogNumberInput value={hp.confmapsLossWeight} onChange={(v) => onUpdate({ confmapsLossWeight: v })} className="h-9 text-sm" />
            </Field>
            <Field {...HEAD_FIELD_DEFS.pafsLossWeight} hint="Loss weight for the part affinity fields head. Increase to prioritize this head during multi-head training.">
              <LogNumberInput value={hp.pafsLossWeight} onChange={(v) => onUpdate({ pafsLossWeight: v })} className="h-9 text-sm" />
            </Field>
          </>
        )}
        {headType === "multi_class_topdown" && (
          <>
            <Field {...HEAD_FIELD_DEFS.confmapsLossWeight} hint="Loss weight for the confidence maps head. Increase to prioritize this head during multi-head training.">
              <LogNumberInput value={hp.confmapsLossWeight} onChange={(v) => onUpdate({ confmapsLossWeight: v })} className="h-9 text-sm" />
            </Field>
            <Field {...HEAD_FIELD_DEFS.classVectorsLossWeight} hint="Loss weight for the classification head. Increase to prioritize this head during multi-head training.">
              <LogNumberInput value={hp.classLossWeight} onChange={(v) => onUpdate({ classLossWeight: v })} className="h-9 text-sm" />
            </Field>
          </>
        )}
        {headType === "multi_class_bottomup" && (
          <>
            <Field {...HEAD_FIELD_DEFS.confmapsLossWeight} hint="Loss weight for the confidence maps head. Increase to prioritize this head during multi-head training.">
              <LogNumberInput value={hp.confmapsLossWeight} onChange={(v) => onUpdate({ confmapsLossWeight: v })} className="h-9 text-sm" />
            </Field>
            <Field {...HEAD_FIELD_DEFS.classMapsLossWeight} hint="Loss weight for the classification maps head. Increase to prioritize this head during multi-head training.">
              <LogNumberInput value={hp.classLossWeight} onChange={(v) => onUpdate({ classLossWeight: v })} className="h-9 text-sm" />
            </Field>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

// ── Main dialog ────────────────────────────────────────────────────

export function TrainingConfigDialog({
  open,
  onClose,
  modelType,
  configs,
  onUpdateSlot,
  inferenceTarget,
  onInferenceTargetChange,
  remoteEnabled,
  onRemoteEnabledChange,
  skeletonNodes = [],
  sampleCount,
  onSampleCountChange,
  skipUserLabeled,
  onSkipUserLabeledChange,
  existingPredictions,
  onExistingPredictionsChange,
  autoOpenWandb,
  onAutoOpenWandbChange,
}: TrainingConfigDialogProps) {
  const pipelineScrollRef = useRef<HTMLDivElement>(null);
  const headScrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeTab, setActiveTab] = useState("pipeline");
  const [searchQuery, setSearchQuery] = useState("");

  // App store for suggestions count
  const labels = useAppStore((s) => s.labels);
  const suggestionsCount = labels?.suggestions?.length ?? 0;
  const skeleton = useAppStore((s) => s.skeleton);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const nodeVisibility = useMemo(
    () => computeNodeVisibility(labels, skeleton),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, skeleton, overlayVersion]
  );

  // Auto-load baseline configs for empty slots when dialog opens
  const { parseYamlConfig, addConfigFile } = useTrainingStore();
  useEffect(() => {
    if (!open) return;
    const slots = getConfigSlots(modelType);
    for (const slot of slots) {
      const existing = configs.find((c) => c.slot === slot);
      if (existing) continue;
      const headType = slotToHeadType(modelType, slot);
      const baseline = getDefaultProfileForHead(headType);
      if (baseline) {
        const parsed = parseYamlConfig(baseline.content, baseline.filename, slot);
        if (parsed) addConfigFile(parsed);
      }
    }
  }, [open, modelType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sort configs to match canonical slot order (centroid first for top-down)
  const slotOrder = getConfigSlots(modelType);
  const sortedConfigs = [...configs].sort((a, b) => {
    const ai = slotOrder.indexOf(a.slot);
    const bi = slotOrder.indexOf(b.slot);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  // Connect store for remote training section
  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const workers = useConnectStore((s) => s.workers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const selectWorker = useConnectStore((s) => s.selectWorker);
  const availableRooms = useConnectStore((s) => s.availableRooms);
  const roomId = useConnectStore((s) => s.roomId);

  const scrollTo = useCallback((id: string) => {
    const activeRef = activeTab === "pipeline"
      ? pipelineScrollRef.current
      : headScrollRefs.current[activeTab];
    const el = activeRef?.querySelector(`#${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeTab]);

  const searchResults = searchQuery.trim()
    ? SEARCHABLE_FIELDS.filter((f) => fieldMatchesQuery(f, searchQuery))
    : [];

  const handleSearchSelect = (field: IndexedField) => {
    setSearchQuery("");
    // Per-head fields render identically in every head tab. Keep the user on
    // the head tab they're already viewing; otherwise jump to the first head
    // tab (never leave a head result stranded on the pipeline tab).
    const headSlots = sortedConfigs.map((c) => c.slot);
    const targetTab = field.tab === "pipeline"
      ? "pipeline"
      : headSlots.includes(activeTab)
        ? activeTab
        : headSlots[0] ?? "pipeline";
    setActiveTab(targetTab);
    setTimeout(() => {
      const ref = targetTab === "pipeline" ? pipelineScrollRef.current : headScrollRefs.current[targetTab];
      const el = ref?.querySelector(`#${CSS.escape(field.id)}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-primary", "rounded");
        setTimeout(() => el.classList.remove("ring-2", "ring-primary", "rounded"), 1500);
      }
    }, 100);
  };

  const navItems = activeTab === "pipeline" ? PIPELINE_NAV : HEAD_NAV;
  const firstConfig = sortedConfigs[0];
  const firstHp = firstConfig?.hyperparams;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) { onClose(); setSearchQuery(""); } }}>
      <DialogContent className="w-full sm:max-w-[1000px] h-[70vh] p-0 overflow-hidden inset-0 translate-x-0 translate-y-0 m-auto flex flex-col" onKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader className="px-6 pt-5 pb-3 shrink-0">
          <DialogTitle className="text-lg">Training Configuration</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
          <div className="flex justify-center mx-6 shrink-0">
            <TabsList className="h-9">
              <TabsTrigger value="pipeline" className="text-sm">Training Pipeline</TabsTrigger>
              {sortedConfigs.map((cf) => (
                <TabsTrigger key={cf.slot} value={cf.slot} className="text-sm">
                  {getSlotLabel(cf.slot).replace(" Config", "")} Model Configuration
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="relative mx-6 mt-2 mb-2 shrink-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search parameters..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 text-sm pl-9"
            />
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg z-10 max-h-48 overflow-y-auto">
                {searchResults.map((r) => (
                  <button
                    key={`${r.tab}:${r.id}`}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent/50 flex items-center justify-between"
                    onClick={() => handleSearchSelect(r)}
                  >
                    <span>{r.label}</span>
                    <span className="text-xs text-muted-foreground">{r.tab === "pipeline" ? "Training Pipeline" : "Per-Head"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-1 min-h-0 border-t mt-2">
            <nav className="w-[180px] border-r bg-muted/30 py-3 shrink-0">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  className="w-full text-left px-5 py-2.5 text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  onClick={() => scrollTo(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {/* ── Training Pipeline tab ── */}
            <TabsContent value="pipeline" className="flex-1 min-h-0 mt-0 overflow-hidden">
              <div ref={pipelineScrollRef} className="h-full overflow-y-auto px-8 py-6 bg-muted/20">

                {/* 1. Pipeline Type */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secType} />
                <div className="space-y-3">
                  <Field label="Type">
                    <span className="text-sm font-medium">{MODEL_TYPE_LABELS[modelType]}</span>
                  </Field>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {MODEL_TYPE_DESCRIPTIONS[modelType]}
                  </p>
                  {(modelType === "top_down" || modelType === "top_down_id") && (
                    <div className="flex items-center gap-4 flex-wrap pt-1">
                      {(() => {
                        const ciConfig = configs.find((c) => c.slot === "centered_instance");
                        return ciConfig ? (
                          <PipelineAnchorPartField
                            hp={ciConfig.hyperparams}
                            onUpdate={(updates) => onUpdateSlot("centered_instance", updates)}
                            skeletonNodes={skeletonNodes}
                            nodeVisibility={nodeVisibility}
                          />
                        ) : null;
                      })()}
                      <div id={PIPELINE_FIELD_DEFS.sigmaCentroids.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          {PIPELINE_FIELD_DEFS.sigmaCentroids.label}
                          <HintBubble text="Gaussian spread for centroid confidence maps. Controls how wide the target peak is around each animal's center point." />
                        </span>
                        <Input
                          type="number"
                          value={configs.find((c) => c.slot === "centroid")?.hyperparams.sigma ?? 5.0}
                          onChange={(e) => { const slot = configs.find((c) => c.slot === "centroid")?.slot; if (slot) onUpdateSlot(slot, { sigma: Number(e.target.value) }); }}
                          min={0.5} max={30} step={0.5}
                          className="h-8 text-sm w-20"
                        />
                      </div>
                      <div id={PIPELINE_FIELD_DEFS.sigmaNodes.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          {PIPELINE_FIELD_DEFS.sigmaNodes.label}
                          <HintBubble text="Gaussian spread for node confidence maps. Controls how wide the target peak is around each keypoint location." />
                        </span>
                        <Input
                          type="number"
                          value={configs.find((c) => c.slot === "centered_instance")?.hyperparams.sigma ?? 5.0}
                          onChange={(e) => { const slot = configs.find((c) => c.slot === "centered_instance")?.slot; if (slot) onUpdateSlot(slot, { sigma: Number(e.target.value) }); }}
                          min={0.5} max={30} step={0.5}
                          className="h-8 text-sm w-20"
                        />
                      </div>
                    </div>
                  )}
                  {modelType === "single_animal" && firstHp && (
                    <div className="flex items-center gap-4 pt-1">
                      <div id={PIPELINE_FIELD_DEFS.sigmaNodes.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Sigma
                          <HintBubble text="Gaussian spread for keypoint heatmaps. Smaller = more precise but harder to train. Larger = easier to train but less spatially precise." />
                        </span>
                        <Input
                          type="number"
                          value={firstHp.sigma}
                          onChange={(e) => onUpdateSlot(firstConfig!.slot, { sigma: Number(e.target.value) })}
                          min={0.5} max={30} step={0.5}
                          className="h-8 text-sm w-20"
                        />
                      </div>
                    </div>
                  )}
                  {(modelType === "bottom_up" || modelType === "bottom_up_id") && firstHp && (
                    <div className="flex items-center gap-4 pt-1">
                      <div id={PIPELINE_FIELD_DEFS.sigmaNodes.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Sigma
                          <HintBubble text="Gaussian spread for confidence maps. Controls how wide the target peak is around each keypoint." />
                        </span>
                        <Input
                          type="number"
                          value={firstHp.sigma}
                          onChange={(e) => onUpdateSlot(firstConfig!.slot, { sigma: Number(e.target.value) })}
                          min={0.5} max={30} step={0.5}
                          className="h-8 text-sm w-20"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <Separator className="my-5" />

                {/* 2. Inference Target */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secInference} />
                <div className="space-y-3">
                  <div className="flex items-center gap-4 flex-wrap">
                    <div id={PIPELINE_FIELD_DEFS.inferenceTarget.id} data-search-field="" className="flex items-center gap-2 flex-1 min-w-0 scroll-mt-4">
                      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.inferenceTarget.label}
                        <HintBubble text="Which frames to run inference on after training completes. Predictions will be merged back into the project." />
                      </span>
                      <Select value={inferenceTarget} onValueChange={onInferenceTargetChange}>
                        <SelectTrigger className="h-9 text-sm w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="nothing">Nothing (skip inference)</SelectItem>
                          <SelectItem value="suggestions">Suggested frames</SelectItem>
                          <SelectItem value="user_labeled">User labeled frames</SelectItem>
                          <SelectItem value="predicted">Frames with predictions</SelectItem>
                          <SelectItem value="video">Entire current video</SelectItem>
                          <SelectItem value="all_videos">All videos</SelectItem>
                          <SelectItem value="random_video">Random sample (current video)</SelectItem>
                          <SelectItem value="random">Random sample (all videos)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {inferenceTarget === "suggestions" && (
                      <span className="text-sm text-muted-foreground">
                        Frames in the Labeling Suggestions list ({suggestionsCount} frames)
                      </span>
                    )}
                    {(inferenceTarget === "random_video" || inferenceTarget === "random") && (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Sample count:</span>
                        <Input type="number" min={1} value={sampleCount}
                          onChange={(e) => onSampleCountChange(Math.max(1, Number(e.target.value)))}
                          className="h-8 text-sm w-24" />
                      </div>
                    )}
                  </div>
                  <Toggle
                    {...PIPELINE_FIELD_DEFS.skipUserLabeled}
                    checked={skipUserLabeled}
                    onChange={onSkipUserLabeledChange}
                  />
                  <div id={PIPELINE_FIELD_DEFS.existingPredictions.id} data-search-field="" className="flex items-center gap-4 scroll-mt-4">
                    <span className="text-sm text-muted-foreground">Existing predictions:</span>
                    {(["clear_all", "replace", "keep"] as const).map((option) => (
                      <label key={option} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name="existing-predictions"
                          checked={existingPredictions === option}
                          onChange={() => onExistingPredictionsChange(option)}
                          className="accent-primary"
                        />
                        <span className="text-sm">{option === "clear_all" ? "Clear all" : option === "replace" ? "Replace" : "Keep"}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <Separator className="my-5" />

                {/* 3. Pre-processing / Post-processing */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secPreproc} />
                {firstHp ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-6 flex-wrap">
                      <div id={PIPELINE_FIELD_DEFS.convertColors.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          {PIPELINE_FIELD_DEFS.convertColors.label}
                          <HintBubble text="Convert input images to a specific channel format. Use RGB for pretrained backbones or Grayscale for single-channel videos." />
                        </span>
                        <Select
                          value={firstHp.colorMode}
                          onValueChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { colorMode: v as ColorMode }))}
                        >
                          <SelectTrigger className="h-8 text-sm w-32"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="rgb">RGB</SelectItem>
                            <SelectItem value="grayscale">Grayscale</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {/* Max Instances and Filter Overlapping Instances are inference-time
                          post-processing concepts (max detections per frame, NMS/IOU/OKS
                          overlap filtering) with no sleap-nn training key — disabled here so
                          the training dialog doesn't imply they affect training. */}
                      <div id={PIPELINE_FIELD_DEFS.maxInstances.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4 opacity-50">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          {PIPELINE_FIELD_DEFS.maxInstances.label}
                          <HintBubble text="Maximum number of animal instances to detect per frame. Leave empty or check 'No max' for no limit." />
                        </span>
                        <Input type="number" placeholder="1" disabled className="h-8 text-sm w-16" />
                      </div>
                      <label className="flex items-center gap-1.5 opacity-50">
                        <input type="checkbox" defaultChecked disabled className="accent-primary" />
                        <span className="text-sm">No max</span>
                      </label>
                    </div>
                    <div className="flex items-center gap-4">
                      <label id={PIPELINE_FIELD_DEFS.filterOverlapping.id} data-search-field="" className="flex items-center gap-1.5 scroll-mt-4 opacity-50">
                        <input type="checkbox" disabled className="accent-primary" />
                        <span className="text-sm">{PIPELINE_FIELD_DEFS.filterOverlapping.label}</span>
                      </label>
                      <div className="flex items-center gap-2 opacity-50">
                        <span className="text-sm text-muted-foreground">Method:</span>
                        <Select value="iou" disabled>
                          <SelectTrigger className="h-8 text-sm w-36"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="iou">IOU (bounding box)</SelectItem>
                            <SelectItem value="oks">OKS</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2 opacity-50">
                        <span className="text-sm text-muted-foreground">Threshold:</span>
                        <Input type="number" value={0.80} disabled step={0.05} className="h-8 text-sm w-16" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure preprocessing.</p>
                )}

                <Separator className="my-5" />

                {/* 4. Performance */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secPerformance} />
                <div className="space-y-3">
                  <div className="flex items-center gap-6 flex-wrap">
                    <div id={PIPELINE_FIELD_DEFS.dataPipeline.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.dataPipeline.label}
                        <HintBubble text="How training data is loaded. 'Cache in Memory' is fastest but uses more RAM. 'Stream' reads from disk each epoch. 'Cache to Disk' saves processed data to disk." />
                      </span>
                      <Select value={firstHp?.dataPipeline ?? "memory"} onValueChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { dataPipeline: v as DataPipeline }))}>
                        <SelectTrigger className="h-8 text-sm w-40"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stream">Stream (no caching)</SelectItem>
                          <SelectItem value="memory">Cache in Memory</SelectItem>
                          <SelectItem value="disk">Cache to Disk</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div id={PIPELINE_FIELD_DEFS.dataloaderWorkers.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.dataloaderWorkers.label}
                        <HintBubble text="Number of parallel workers for loading training data. More workers = faster data loading but more CPU/memory usage. 0 = main thread only. Only takes effect with a caching pipeline (Cache in Memory / Cache to Disk); the Stream pipeline forces 0." />
                      </span>
                      <Input type="number" value={firstHp?.dataloaderWorkers ?? 0} min={0} max={16} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { dataloaderWorkers: Number(e.target.value) }))} className="h-8 text-sm w-16" />
                    </div>
                  </div>
                  <div className="flex items-center gap-6 flex-wrap">
                    <div id={PIPELINE_FIELD_DEFS.accelerator.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.accelerator.label}
                        <HintBubble text="Hardware to use for training. 'Auto' detects available hardware. Use 'cuda' for NVIDIA GPUs, 'mps' for Apple Silicon, or 'cpu' for CPU-only (slow)." />
                      </span>
                      <Select value={firstHp?.accelerator ?? "auto"} onValueChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { accelerator: v as "auto" | "cuda" | "mps" | "cpu" }))}>
                        <SelectTrigger className="h-8 text-sm w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">auto</SelectItem>
                          <SelectItem value="cuda">cuda</SelectItem>
                          <SelectItem value="mps">mps</SelectItem>
                          <SelectItem value="cpu">cpu</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div id={PIPELINE_FIELD_DEFS.numDevices.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.numDevices.label}
                        <HintBubble text="Number of GPUs/devices to use for training. Set to 1 for single-GPU training." />
                      </span>
                      <Input type="number" value={firstHp?.numDevices === "auto" ? 1 : (firstHp?.numDevices ?? 1)} min={1} max={8} disabled={(firstHp?.numDevices ?? "auto") === "auto"} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { numDevices: Math.max(1, Number(e.target.value)) }))} className="h-8 text-sm w-16" />
                    </div>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={(firstHp?.numDevices ?? "auto") === "auto"} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { numDevices: e.target.checked ? "auto" : 1 }))} className="accent-primary" />
                      <span className="text-sm">Auto</span>
                    </label>
                  </div>
                </div>

                <Separator className="my-5" />

                {/* 5. W&B */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secWandb} />
                {firstHp ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Status:</span>
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                      <span className="text-sm text-red-400">Not logged in</span>
                    </div>
                    <div className="flex items-center gap-4 flex-wrap">
                      <Toggle {...PIPELINE_FIELD_DEFS.wandbEnable} checked={firstHp.useWandb} onChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { useWandb: v }))} />
                      <Toggle {...PIPELINE_FIELD_DEFS.wandbOffline} checked={firstHp.wandbMode === "offline"} onChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbMode: v ? "offline" : "online" }))} disabled={!firstHp.useWandb} />
                      <Toggle {...PIPELINE_FIELD_DEFS.wandbUploadViz} checked={firstHp.wandbUploadViz} onChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbUploadViz: v }))} disabled={!firstHp.useWandb || firstHp.wandbMode === "offline"} />
                      <Toggle {...PIPELINE_FIELD_DEFS.wandbOpenBrowser} checked={autoOpenWandb} onChange={onAutoOpenWandbChange} disabled={!firstHp.useWandb || firstHp.wandbMode === "offline"} />
                    </div>
                    <div className="flex items-center gap-6 flex-wrap">
                      <div id={PIPELINE_FIELD_DEFS.wandbApiKey.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          {PIPELINE_FIELD_DEFS.wandbApiKey.label}:
                          <HintBubble text="W&B API key from wandb.ai/authorize. Optional — leave blank if you've run 'wandb login' or set the WANDB_API_KEY environment variable." />
                        </span>
                        <Input type="password" autoComplete="off" value={firstHp.wandbApiKey} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbApiKey: e.target.value }))} placeholder="" className="h-8 text-sm w-52" disabled={!firstHp.useWandb || firstHp.wandbMode === "offline"} />
                      </div>
                      {firstHp.wandbMode === "offline" && (
                        <span className="text-xs text-muted-foreground">Logged locally — run <span className="font-mono">wandb sync</span> to upload later.</span>
                      )}
                    </div>
                    <div className="flex items-center gap-6 flex-wrap">
                      <div id={PIPELINE_FIELD_DEFS.wandbEntity.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground">{PIPELINE_FIELD_DEFS.wandbEntity.label}:</span>
                        <Input type="text" value={firstHp.wandbEntity} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbEntity: e.target.value }))} placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                      <div id={PIPELINE_FIELD_DEFS.wandbProject.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground">{PIPELINE_FIELD_DEFS.wandbProject.label}:</span>
                        <Input type="text" value={firstHp.wandbProject} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbProject: e.target.value }))} placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                    </div>
                    <div className="flex items-center gap-6 flex-wrap">
                      <div id={PIPELINE_FIELD_DEFS.wandbRunId.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground">{PIPELINE_FIELD_DEFS.wandbRunId.label}:</span>
                        <Input type="text" value={firstHp.wandbPrevRunId} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbPrevRunId: e.target.value }))} placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                      <div id={PIPELINE_FIELD_DEFS.wandbGroup.id} data-search-field="" className="flex items-center gap-2 scroll-mt-4">
                        <span className="text-sm text-muted-foreground">{PIPELINE_FIELD_DEFS.wandbGroup.label}:</span>
                        <Input type="text" value={firstHp.wandbGroup} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbGroup: e.target.value }))} placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure W&B.</p>
                )}

                <Separator className="my-5" />

                {/* 6. Evaluation */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secEvaluation} />
                <div className="space-y-3">
                  <div className="flex items-center gap-6">
                    <Toggle
                      {...PIPELINE_FIELD_DEFS.evalEnable}
                      checked={firstHp?.evalEnabled ?? false}
                      onChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { evalEnabled: v }))}
                    />
                    <div id={PIPELINE_FIELD_DEFS.evalFrequency.id} data-search-field="" className={`flex items-center gap-2 scroll-mt-4 ${!firstHp?.evalEnabled ? "opacity-50" : ""}`}>
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.evalFrequency.label}:
                        <HintBubble text="How often to run full evaluation. Every 1 epoch is most informative but slower. Every 5–10 epochs is a good balance." />
                      </span>
                      <Input
                        type="number"
                        value={firstHp?.evalFrequency ?? 1}
                        min={1}
                        disabled={!firstHp?.evalEnabled}
                        onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { evalFrequency: Math.max(1, Number(e.target.value)) }))}
                        className="h-8 text-sm w-16"
                      />
                    </div>
                  </div>
                </div>

                <Separator className="my-5" />

                {/* 7. Output */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secOutput} />
                {firstHp ? (
                  <div className="space-y-3">
                    <Field {...PIPELINE_FIELD_DEFS.runName}>
                      <Input type="text" value={firstHp.runName} onChange={(e) => onUpdateSlot(firstConfig!.slot, { runName: e.target.value })} placeholder="Auto-generated" className="h-9 text-sm" />
                    </Field>
                    <Field {...PIPELINE_FIELD_DEFS.runsFolder}>
                      <Input type="text" value="models" disabled className="h-9 text-sm" />
                    </Field>
                    <div id={PIPELINE_FIELD_DEFS.checkpoint.id} data-search-field="" className="flex items-center gap-6 scroll-mt-4">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.checkpoint.label}:
                        <HintBubble text={PIPELINE_FIELD_DEFS.checkpoint.hint} />
                      </span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={firstHp.saveBestModel}
                          onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { saveBestModel: e.target.checked }))}
                          className="accent-primary"
                        />
                        <span className="text-sm">Best Model</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={firstHp.saveLastModel}
                          onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { saveLastModel: e.target.checked }))}
                          className="accent-primary"
                        />
                        <span className="text-sm">Latest Model</span>
                      </label>
                    </div>
                    <div id={PIPELINE_FIELD_DEFS.visualization.id} data-search-field="" className="flex items-center gap-6 scroll-mt-4">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        {PIPELINE_FIELD_DEFS.visualization.label}:
                        <HintBubble text={PIPELINE_FIELD_DEFS.visualization.hint} />
                      </span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={firstHp.visualizePredictions}
                          onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { visualizePredictions: e.target.checked }))}
                          className="accent-primary"
                        />
                        <span className="text-sm">Visualize Predictions</span>
                      </label>
                      <label className={`flex items-center gap-1.5 ${firstHp.visualizePredictions ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
                        <input
                          type="checkbox"
                          checked={firstHp.keepVizImages}
                          disabled={!firstHp.visualizePredictions}
                          onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { keepVizImages: e.target.checked }))}
                          className="accent-primary"
                        />
                        <span className="text-sm">Keep Viz Images</span>
                      </label>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure output.</p>
                )}

                <Separator className="my-5" />

                {/* 8. Remote Training */}
                <SectionHeading {...PIPELINE_FIELD_DEFS.secRemote} />
                <div className="space-y-3">
                  <Toggle {...PIPELINE_FIELD_DEFS.remoteEnable} checked={remoteEnabled} onChange={onRemoteEnabledChange} />
                  {remoteEnabled && connectionStatus !== "connected" && (
                    <div className="bg-orange-500/10 border border-orange-500/30 rounded-md px-3 py-2 text-sm text-orange-400">
                      Not connected. Go to the Connect tab to join a room before enabling remote training.
                    </div>
                  )}
                  {remoteEnabled && connectionStatus === "connected" && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                        <span className="text-sm text-green-400">
                          Connected ({workers.filter((w) => w.status === "available").length} worker{workers.filter((w) => w.status === "available").length !== 1 ? "s" : ""} available)
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Room:
                          <HintBubble text="The sleap-connect room to use for remote training. Rooms group workers and clients together." />
                        </span>
                        <Select value={roomId || ""} disabled>
                          <SelectTrigger className="h-8 text-sm w-64"><SelectValue placeholder="Select a room" /></SelectTrigger>
                          <SelectContent>
                            {availableRooms.map((r) => (
                              <SelectItem key={r.roomId} value={r.roomId}>{r.name || r.roomId}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Worker:
                          <HintBubble text="Select which worker will run the training job. Workers with GPUs are preferred for faster training." />
                        </span>
                        <Select value={selectedWorkerId || ""} onValueChange={selectWorker}>
                          <SelectTrigger className="h-8 text-sm w-64"><SelectValue placeholder="Select a worker" /></SelectTrigger>
                          <SelectContent>
                            {workers.map((w) => (
                              <SelectItem key={w.peerId} value={w.peerId} disabled={w.status !== "available"}>
                                {w.name}{w.gpu ? ` (${w.gpu.model})` : ""}{w.status !== "available" ? ` — ${w.status}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* ── Per-head tabs ── */}
            {sortedConfigs.map((cf) => (
              <TabsContent key={cf.slot} value={cf.slot} className="flex-1 min-h-0 mt-0 overflow-hidden h-full">
                <HeadTabContent
                  slot={cf.slot}
                  modelType={modelType}
                  configFile={cf}
                  hp={cf.hyperparams}
                  onUpdate={(updates) => onUpdateSlot(cf.slot, updates)}
                  scrollRefCallback={(el) => { headScrollRefs.current[cf.slot] = el; }}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
