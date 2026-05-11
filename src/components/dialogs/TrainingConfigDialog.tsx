import { useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, HelpCircle } from "lucide-react";
import type { ConfigFile, ConfigHyperparams, Backbone, AugmentationPreset, ModelType } from "@/stores/trainingStore";
import { getSlotLabel, getConfigSlots, useTrainingStore } from "@/stores/trainingStore";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { ModelStatsPreview } from "@/components/dialogs/ModelStatsPreview";

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
  skipUserLabeled: boolean;
  onSkipUserLabeledChange: (v: boolean) => void;
  existingPredictions: "clear_all" | "replace" | "keep";
  onExistingPredictionsChange: (v: "clear_all" | "replace" | "keep") => void;
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

const AUGMENTATION_PRESET_OPTIONS: { value: AugmentationPreset; label: string; desc: string }[] = [
  { value: "none", label: "None", desc: "No augmentation" },
  { value: "light", label: "Light", desc: "Rotation ±15°" },
  { value: "standard", label: "Standard", desc: "Rotation ±180° + noise" },
  { value: "heavy", label: "Heavy", desc: "Full augmentation suite" },
  { value: "custom", label: "Custom", desc: "Configure each parameter manually" },
];

const SEARCHABLE_FIELDS = [
  { label: "Pipeline Type", section: "pipeline", fieldId: "pipeline-type" },
  { label: "Anchor Part", section: "pipeline", fieldId: "field-anchorpart" },
  { label: "Sigma for Centroids", section: "pipeline", fieldId: "field-sigma-centroid" },
  { label: "Sigma for Nodes", section: "pipeline", fieldId: "field-sigma-nodes" },
  { label: "Inference Target", section: "pipeline", fieldId: "pipeline-inference" },
  { label: "Validation Fraction", section: "pipeline", fieldId: "field-valfraction" },
  { label: "Input Scale", section: "pipeline", fieldId: "field-inputscale" },
  { label: "Ensure Channels", section: "pipeline", fieldId: "field-ensurechannels" },
  { label: "Max Instances", section: "pipeline", fieldId: "field-maxinstances" },
  { label: "Accelerator", section: "pipeline", fieldId: "field-accelerator" },
  { label: "Enable W&B", section: "pipeline", fieldId: "field-wandb-enable" },
  { label: "W&B Entity", section: "pipeline", fieldId: "field-wandb-entity" },
  { label: "W&B Project", section: "pipeline", fieldId: "field-wandb-project" },
  { label: "Evaluation", section: "pipeline", fieldId: "field-eval-enable" },
  { label: "Run Name", section: "pipeline", fieldId: "field-runname" },
  { label: "Remote Training", section: "pipeline", fieldId: "pipeline-remote" },
  // Head — Data
  { label: "Validation Fraction (per-head)", section: "head", fieldId: "head-data" },
  { label: "Overfit Mode", section: "head", fieldId: "head-data" },
  { label: "Random Seed", section: "head", fieldId: "head-data" },
  { label: "Input Scaling", section: "head", fieldId: "head-data" },
  { label: "Crop Size", section: "head", fieldId: "head-data" },
  // Head — Augmentation
  { label: "Augmentation Preset", section: "head", fieldId: "field-augpreset" },
  { label: "Rotation", section: "head", fieldId: "head-augmentation" },
  { label: "Scale Augmentation", section: "head", fieldId: "head-augmentation" },
  { label: "Uniform Noise", section: "head", fieldId: "head-augmentation" },
  { label: "Gaussian Noise", section: "head", fieldId: "head-augmentation" },
  { label: "Contrast", section: "head", fieldId: "head-augmentation" },
  { label: "Brightness", section: "head", fieldId: "head-augmentation" },
  // Head — Optimization
  { label: "Batch Size", section: "head", fieldId: "field-batchsize" },
  { label: "Max Epochs", section: "head", fieldId: "field-maxepochs" },
  { label: "Learning Rate", section: "head", fieldId: "field-learningrate" },
  { label: "Stop Training on Plateau", section: "head", fieldId: "head-optimization" },
  { label: "Plateau Min Delta", section: "head", fieldId: "head-optimization" },
  { label: "Plateau Patience", section: "head", fieldId: "field-earlystopping" },
  { label: "Online Mining", section: "head", fieldId: "head-optimization" },
  { label: "Min Hard Keypoints", section: "head", fieldId: "head-optimization" },
  { label: "Max Hard Keypoints", section: "head", fieldId: "head-optimization" },
  // Head — Model
  { label: "Backbone", section: "head", fieldId: "field-backbone" },
  { label: "Stem Stride", section: "head", fieldId: "head-model" },
  { label: "Max Stride", section: "head", fieldId: "head-model" },
  { label: "Filters", section: "head", fieldId: "head-model" },
  { label: "Filters Rate", section: "head", fieldId: "head-model" },
  { label: "Middle Block", section: "head", fieldId: "head-model" },
  { label: "Up Interpolate", section: "head", fieldId: "head-model" },
  { label: "Anchor Part", section: "head", fieldId: "head-model" },
  { label: "Sigma", section: "head", fieldId: "field-sigma" },
  { label: "Output Stride", section: "head", fieldId: "head-model" },
];

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
    <div id={id} className="flex items-center gap-6 py-2.5 scroll-mt-4">
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function Toggle({ label, id, hint, checked, onChange }: { label: string; id?: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div id={id} className="flex items-center gap-6 py-2.5 scroll-mt-4">
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <button
        className={`w-10 h-6 rounded-full relative transition-colors ${checked ? "bg-primary" : "bg-zinc-700"}`}
        onClick={() => onChange(!checked)}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

function SectionHeading({ id, label }: { id: string; label: string }) {
  return (
    <h3 id={id} className="text-base font-medium pt-6 pb-3 first:pt-0 scroll-mt-4">
      {label}
    </h3>
  );
}

// ── Per-head tab content ───────────────────────────────────────────

function HeadTabContent({
  slot,
  configFile,
  hp,
  onUpdate,
  scrollRefCallback,
  skeletonNodes,
}: {
  slot: string;
  configFile: ConfigFile | undefined;
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  scrollRefCallback: (el: HTMLDivElement | null) => void;
  skeletonNodes: string[];
}) {
  const showAnchorPart = slot === "centroid" || slot === "centered_instance";
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
          value={configFile ? configFile.filename : "__browse__"}
          onValueChange={(v) => { if (v === "__browse__") handleConfigBrowse(); }}
        >
          <SelectTrigger className="h-10 text-sm font-mono bg-background">
            <SelectValue placeholder="Select training config file..." />
          </SelectTrigger>
          <SelectContent>
            {configFile && (
              <SelectItem value={configFile.filename}>
                {(() => {
                  const runNameMatch = configFile.content.match(/run_name:\s*(.+)/);
                  const runName = runNameMatch?.[1]?.trim();
                  return runName
                    ? `[Trained] ${runName}(${configFile.filename})`
                    : `[${configFile.modelType}] (${configFile.filename})`;
                })()}
              </SelectItem>
            )}
            <SelectItem value="__browse__" className="text-primary font-medium">
              Select training config file...
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
      <ModelStatsPreview hp={hp} maxStride={16} filters={16} filtersRate={2.0} configYaml={configFile?.content} slot={slot} />

      {/* ── 1. Data ── */}
      <div className={allLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading id="head-data" label="Data" />
      <div className="space-y-2">
        <div className={hp.overfitMode ? "opacity-50" : ""}>
          <Field label="Validation Fraction" hint="Fraction of labeled frames to use as a validation set. Ignored if &quot;Overfit Mode&quot; is enabled.">
            <Input type="number" value={hp.validationFraction} onChange={(e) => onUpdate({ validationFraction: Number(e.target.value) })} min={0} max={1} step={0.05} className="h-9 text-sm" disabled={hp.overfitMode} />
          </Field>
        </div>
        <div className="flex items-center gap-6">
          <Toggle label="Overfit Mode (train=val)" hint="If enabled, the same data will be used for both training and validation. This is useful for intentional overfitting on small datasets (fewer than 10 labeled frames) to test model capacity." checked={hp.overfitMode} onChange={(v) => onUpdate({ overfitMode: v })} />
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Random Seed
              <HintBubble text="Random seed for reproducible train/validation data splits. Leave empty (Auto) for random seed each run." />
            </span>
            <Input type="number" placeholder="0" className="h-8 text-sm w-20" />
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" defaultChecked className="accent-primary" />
            <span className="text-sm">Auto</span>
          </label>
        </div>
        <Field label="Input Scaling" hint="Rescaling factor applied to input images before training. Values less than 1.0 downsample the image, which reduces memory usage and speeds up training at the cost of spatial resolution. Note that crop size and sigma values are relative to the scaled image.">
          <Input type="number" value={hp.scale} onChange={(e) => onUpdate({ scale: Number(e.target.value) })} min={0.125} max={1} step={0.125} className="h-9 text-sm" />
        </Field>
        {showCropSize && (
          <div className="flex items-center gap-4">
            <Field label="Crop Size" hint="Bounding box crop size around each instance in pixels. Set to 'Auto' to compute from the data (largest instance bounding box, aligned to max_stride).">
              <Input type="number" value={256} className="h-9 text-sm" />
            </Field>
            <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
              <input type="checkbox" className="accent-primary" />
              <span className="text-sm">Auto</span>
            </label>
          </div>
        )}
      </div>

      </div>

      <Separator className="my-5" />

      {/* ── 2. Augmentation ── */}
      <div className={allLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading id="head-augmentation" label="Augmentation" />
      <div className="space-y-2">
        <Field label="Preset" id="field-augpreset" hint="Quick preset that configures all augmentation parameters at once. Choose 'None' to disable or select a preset and adjust individual settings below.">
          <Select value={hp.augmentationPreset} onValueChange={(v) => onUpdate({ augmentationPreset: v as AugmentationPreset })}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AUGMENTATION_PRESET_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label} — {o.desc}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {(() => {
          const isCustom = hp.augmentationPreset === "custom";
          const scaleOn = isCustom ? false : hp.augmentationPreset === "heavy";
          const uniformNoiseOn = false;
          const gaussianNoiseOn = isCustom ? false : hp.augmentationPreset === "standard" || hp.augmentationPreset === "heavy";
          const contrastOn = isCustom ? false : hp.augmentationPreset === "heavy";
          const brightnessOn = isCustom ? false : hp.augmentationPreset === "heavy";
          return (
            <>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                  Rotation
                  <HintBubble text="Rotation augmentation range. Off: disabled. ±15°: for side-view cameras where upside-down would be unnatural. ±180°: for top-view/overhead cameras where all orientations are valid." />
                </span>
                <Select value={hp.augmentationPreset === "none" ? "off" : hp.augmentationPreset === "light" ? "15" : "180"}>
                  <SelectTrigger className="h-8 text-sm w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="15">±15°</SelectItem>
                    <SelectItem value="180">±180°</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={scaleOn} readOnly={!isCustom} className="accent-primary" />
                  <span className="text-sm flex items-center gap-1">Scale <HintBubble text="Enable random scaling augmentation. Scaling is applied independently with 100% probability when enabled." /></span>
                </label>
                {scaleOn && (
                  <div className="flex items-center gap-4 pl-6">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Scale Min</span>
                      <Input type="number" value={0.9} min={0.1} max={2} step={0.05} className="h-8 text-sm w-20" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Scale Max</span>
                      <Input type="number" value={1.1} min={0.1} max={2} step={0.05} className="h-8 text-sm w-20" />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={uniformNoiseOn} readOnly={!isCustom} className="accent-primary" />
                  <span className="text-sm flex items-center gap-1">Uniform Noise <HintBubble text="Enable uniformly distributed noise augmentation." /></span>
                </label>
                {uniformNoiseOn && (
                  <div className="flex items-center gap-4 pl-6">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Min Val</span>
                      <Input type="number" value={0.0} min={0} max={1} step={0.01} className="h-8 text-sm w-20" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Max Val</span>
                      <Input type="number" value={0.1} min={0} max={1} step={0.01} className="h-8 text-sm w-20" />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={gaussianNoiseOn} readOnly={!isCustom} className="accent-primary" />
                  <span className="text-sm flex items-center gap-1">Gaussian Noise <HintBubble text="Enable normally distributed noise augmentation. This is applied independently to each pixel." /></span>
                </label>
                {gaussianNoiseOn && (
                  <div className="flex items-center gap-4 pl-6">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Mean</span>
                      <Input type="number" value={0.0} step={0.01} className="h-8 text-sm w-20" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Std Dev</span>
                      <Input type="number" value={0.04} step={0.01} className="h-8 text-sm w-20" />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={contrastOn} readOnly={!isCustom} className="accent-primary" />
                  <span className="text-sm flex items-center gap-1">Contrast <HintBubble text="Enable gamma contrast adjustment. This scales all pixel values by x^gamma where x is in [0, 1]." /></span>
                </label>
                {contrastOn && (
                  <div className="flex items-center gap-4 pl-6">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Contrast Min</span>
                      <Input type="number" value={0.5} min={0.5} max={2} step={0.05} className="h-8 text-sm w-20" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Contrast Max</span>
                      <Input type="number" value={2.0} min={0.5} max={2} step={0.05} className="h-8 text-sm w-20" />
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={brightnessOn} readOnly={!isCustom} className="accent-primary" />
                  <span className="text-sm flex items-center gap-1">Brightness <HintBubble text="Enable brightness augmentation. This adds the same value to all pixels to simulate illumination change." /></span>
                </label>
                {brightnessOn && (
                  <div className="flex items-center gap-4 pl-6">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Brightness Min</span>
                      <Input type="number" value={0.0} step={0.01} className="h-8 text-sm w-20" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Brightness Max</span>
                      <Input type="number" value={0.2} step={0.01} className="h-8 text-sm w-20" />
                    </div>
                  </div>
                )}
              </div>
            </>
          );
        })()}
      </div>
      </div>

      <Separator className="my-5" />

      {/* ── 3. Optimization ── */}
      <div className={allLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading id="head-optimization" label="Optimization" />
      <div className="space-y-2">
        <Field label="Batch Size" id="field-batchsize" hint="Number of examples per minibatch. Higher numbers can increase generalization by averaging gradient updates over more examples, at the cost of more GPU memory. Lower numbers may lead to overfitting but can help optimization with few varied examples.">
          <Input type="number" value={hp.batchSize} onChange={(e) => onUpdate({ batchSize: Number(e.target.value) })} min={1} max={128} className="h-9 text-sm" />
        </Field>
        <Field label="Epochs" id="field-maxepochs" hint="Maximum number of epochs to train for. Training can be stopped manually or automatically if early stopping is enabled and a plateau is detected.">
          <Input type="number" value={hp.maxEpochs} onChange={(e) => onUpdate({ maxEpochs: Number(e.target.value) })} min={1} className="h-9 text-sm" />
        </Field>
        <Field label="Initial Learning Rate" id="field-learningrate" hint="The initial learning rate for the optimizer. Typically 1e-3 or 1e-4. Can be decreased automatically with learning rate reduction on plateau. If too high or too low, training may fail to find good initial local minima.">
          <Input type="number" value={hp.learningRate} onChange={(e) => onUpdate({ learningRate: Number(e.target.value) })} step={0.0001} className="h-9 text-sm" />
        </Field>
        <Toggle label="Stop Training on Plateau" hint="If enabled, training will terminate automatically when the validation loss plateaus. This saves time and compute, and prevents training into the overfitting regime." checked={true} onChange={() => {}} />
        <Field label="Plateau Min. Delta" hint="Minimum absolute decrease in the loss in order to consider an epoch as not in a plateau.">
          <Input type="text" value="1e-08" className="h-9 text-sm" />
        </Field>
        <Field label="Plateau Patience" id="field-earlystopping" hint="Number of epochs without an improvement of at least min_delta in order for a plateau to be detected.">
          <Input type="number" value={hp.earlyStoppingPatience} onChange={(e) => onUpdate({ earlyStoppingPatience: Number(e.target.value) })} min={1} max={100} className="h-9 text-sm" />
        </Field>
        <Toggle label="Online Mining" hint="If enabled, online hard keypoint mining (OHKM) will compute loss per keypoint, sort from easy to hard, and scale hard keypoints to have higher weight. This encourages training to focus on tricky body parts. If disabled, all keypoints are weighted equally." checked={false} onChange={() => {}} />
        <div className="flex items-center gap-4 flex-wrap opacity-50">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Min Hard Keypoints
              <HintBubble text="The minimum number of keypoints that will be considered as 'hard', even if they are not below the hard_to_easy_ratio." />
            </span>
            <Input type="number" value={2} disabled className="h-8 text-sm w-16" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Max Hard Keypoints
              <HintBubble text="The maximum number of hard keypoints to apply scaling to. This can help when there are few very easy keypoints which may skew the ratio." />
            </span>
            <Input type="number" placeholder="None" disabled className="h-8 text-sm w-16" />
          </div>
        </div>
      </div>
      </div>

      <Separator className="my-5" />

      {/* ── 4. Model ── */}
      <div className={modelLocked ? "opacity-40 pointer-events-none" : ""}>
      <SectionHeading id="head-model" label="Model" />
      <div className="space-y-2">
        <Field label="Backbone" id="field-backbone" hint="Select the backbone architecture. UNet is the default and works well for most cases. ConvNeXt and Swin Transformer support pretrained ImageNet weights but require RGB images.">
          <Select value={hp.backbone || ""} onValueChange={(v) => onUpdate({ backbone: v as Backbone })}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="From config..." /></SelectTrigger>
            <SelectContent>
              {BACKBONE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Separator className="my-3" />
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Stem Stride
              <HintBubble text="If not None, controls how many stem blocks to use for initial downsampling. These are useful for learned downsampling that retains spatial information while reducing large input image sizes." />
            </span>
            <Input type="number" placeholder="0" className="h-8 text-sm w-16" />
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" defaultChecked className="accent-primary" />
              <span className="text-sm">None</span>
            </label>
          </div>
        </div>
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Max Stride
              <HintBubble text="Determines the number of downsampling blocks in the network, increasing receptive field size at the cost of network size." />
            </span>
            <Select value="16">
              <SelectTrigger className="h-8 text-sm w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[2, 4, 8, 16, 32, 64, 128].map((v) => <SelectItem key={v} value={String(v)}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Filters
              <HintBubble text="Base number of filters in the network." />
            </span>
            <Input type="number" value={16} className="h-8 text-sm w-16" />
          </div>
        </div>
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Filters Rate
              <HintBubble text="Factor to scale the number of filters by at each block." />
            </span>
            <Input type="number" value={2.0} step={0.1} className="h-8 text-sm w-20" />
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" defaultChecked className="accent-primary" />
            <span className="text-sm flex items-center gap-1">Middle Block <HintBubble text="If enabled, adds an intermediate block between the downsampling and upsampling branch for additional processing at the largest receptive field size." /></span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" defaultChecked className="accent-primary" />
            <span className="text-sm flex items-center gap-1">Up Interpolate <HintBubble text="If enabled, use bilinear upsampling instead of transposed convolutions. This can save computations but may lower overall accuracy." /></span>
          </label>
        </div>
        <Separator className="my-3" />
        <h4 className="text-sm font-medium text-muted-foreground mb-2">Head</h4>
        {showAnchorPart && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              Anchor Part
              <HintBubble text="Text name of a body part (node) to use as the anchor point. If None, the midpoint of the bounding box of all visible points will be used. Setting a reliable anchor point can significantly improve top-down model accuracy." />
            </span>
            <Select value="auto">
              <SelectTrigger className="h-8 text-sm w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                {skeletonNodes.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        <Field label="Sigma" id="field-sigma" hint="Spread of the Gaussian distribution of the confidence maps. Smaller values are more precise but harder to learn. Larger values are easier to learn but less precise. This spread is in units of pixels of the model input image (after any input scaling).">
          <Input type="number" value={hp.sigma} onChange={(e) => onUpdate({ sigma: Number(e.target.value) })} min={0.5} max={30} step={0.5} className="h-9 text-sm" />
        </Field>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground flex items-center gap-1.5">
            Output Stride
            <HintBubble text="The stride of the output confidence maps relative to the input image. This is the reciprocal of the resolution (e.g., stride 2 = 0.5x size). Increasing this value speeds up performance and decreases memory, at the cost of spatial resolution." />
          </span>
          <Select value="2">
            <SelectTrigger className="h-8 text-sm w-20"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1, 2, 4, 8, 16, 32, 64].map((v) => <SelectItem key={v} value={String(v)}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
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
  skipUserLabeled,
  onSkipUserLabeledChange,
  existingPredictions,
  onExistingPredictionsChange,
}: TrainingConfigDialogProps) {
  const pipelineScrollRef = useRef<HTMLDivElement>(null);
  const headScrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeTab, setActiveTab] = useState("pipeline");
  const [searchQuery, setSearchQuery] = useState("");

  // App store for suggestions count
  const labels = useAppStore((s) => s.labels);
  const suggestionsCount = labels?.suggestions?.length ?? 0;

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
    ? SEARCHABLE_FIELDS.filter((f) => f.label.toLowerCase().includes(searchQuery.toLowerCase()))
    : [];

  const handleSearchSelect = (fieldId: string, section: string) => {
    setSearchQuery("");
    const targetTab = section === "pipeline" ? "pipeline" : sortedConfigs[0]?.slot ?? "pipeline";
    setActiveTab(targetTab);
    setTimeout(() => {
      const ref = targetTab === "pipeline" ? pipelineScrollRef.current : headScrollRefs.current[targetTab];
      const el = ref?.querySelector(`#${fieldId}`);
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
                    key={r.fieldId}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent/50 flex items-center justify-between"
                    onClick={() => handleSearchSelect(r.fieldId, r.section)}
                  >
                    <span>{r.label}</span>
                    <span className="text-xs text-muted-foreground">{r.section === "pipeline" ? "Training Pipeline" : "Per-Head"}</span>
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
                <SectionHeading id="pipeline-type" label="Pipeline Type" />
                <div className="space-y-3">
                  <Field label="Type">
                    <span className="text-sm font-medium">{MODEL_TYPE_LABELS[modelType]}</span>
                  </Field>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {MODEL_TYPE_DESCRIPTIONS[modelType]}
                  </p>
                  {(modelType === "top_down" || modelType === "top_down_id") && (
                    <div className="flex items-center gap-4 flex-wrap pt-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Anchor Part
                          <HintBubble text="The body part used to center the crop around each animal. Choose one that is consistently visible and near the center of the animal." />
                        </span>
                        <Select
                          value={configs.find((c) => c.slot === "centroid")?.hyperparams.runName ? "auto" : "auto"}
                          disabled
                        >
                          <SelectTrigger className="h-8 text-sm w-32" id="field-anchorpart"><SelectValue placeholder="Auto" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            {skeletonNodes.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Sigma for Centroids
                          <HintBubble text="Gaussian spread for centroid confidence maps. Controls how wide the target peak is around each animal's center point." />
                        </span>
                        <Input
                          type="number"
                          id="field-sigma-centroid"
                          value={configs.find((c) => c.slot === "centroid")?.hyperparams.sigma ?? 5.0}
                          onChange={(e) => { const slot = configs.find((c) => c.slot === "centroid")?.slot; if (slot) onUpdateSlot(slot, { sigma: Number(e.target.value) }); }}
                          min={0.5} max={30} step={0.5}
                          className="h-8 text-sm w-20"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Sigma for Nodes
                          <HintBubble text="Gaussian spread for node confidence maps. Controls how wide the target peak is around each keypoint location." />
                        </span>
                        <Input
                          type="number"
                          id="field-sigma-nodes"
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
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Sigma
                          <HintBubble text="Gaussian spread for keypoint heatmaps. Smaller = more precise but harder to train. Larger = easier to train but less spatially precise." />
                        </span>
                        <Input
                          type="number"
                          id="field-sigma-nodes"
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
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Sigma
                          <HintBubble text="Gaussian spread for confidence maps. Controls how wide the target peak is around each keypoint." />
                        </span>
                        <Input
                          type="number"
                          id="field-sigma-nodes"
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
                <SectionHeading id="pipeline-inference" label="Inference Target" />
                <div className="space-y-3">
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5">
                        Post-Training Inference Target
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
                  </div>
                  <Toggle
                    label="Skip user labeled frames"
                    hint="Exclude frames that already have user-created labels from the inference target."
                    checked={skipUserLabeled}
                    onChange={onSkipUserLabeledChange}
                  />
                  <div className="flex items-center gap-4">
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
                <SectionHeading id="pipeline-preprocessing" label="Pre-processing / Post-processing" />
                {firstHp ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-6 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Convert Colors
                          <HintBubble text="Convert input images to a specific channel format. Use RGB for pretrained backbones or Grayscale for single-channel videos." />
                        </span>
                        <Select value="grayscale">
                          <SelectTrigger className="h-8 text-sm w-32" id="field-ensurechannels"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="rgb">RGB</SelectItem>
                            <SelectItem value="grayscale">Grayscale</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                          Max Instances
                          <HintBubble text="Maximum number of animal instances to detect per frame. Leave empty or check 'No max' for no limit." />
                        </span>
                        <Input type="number" id="field-maxinstances" placeholder="1" className="h-8 text-sm w-16" />
                      </div>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" defaultChecked className="accent-primary" />
                        <span className="text-sm">No max</span>
                      </label>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" className="accent-primary" />
                        <span className="text-sm">Filter Overlapping Instances</span>
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
                <SectionHeading id="pipeline-performance" label="Performance" />
                <div className="space-y-3">
                  <div className="flex items-center gap-6 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        Data Pipeline
                        <HintBubble text="How training data is loaded. 'Cache in Memory' is fastest but uses more RAM. 'Stream' reads from disk each epoch. 'Cache to Disk' saves processed data to disk." />
                      </span>
                      <Select value="memory">
                        <SelectTrigger className="h-8 text-sm w-40" id="field-datapipeline"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stream">Stream (no caching)</SelectItem>
                          <SelectItem value="memory">Cache in Memory</SelectItem>
                          <SelectItem value="disk">Cache to Disk</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        Dataloader Workers
                        <HintBubble text="Number of parallel workers for loading training data. More workers = faster data loading but more CPU/memory usage. 0 = main thread only." />
                      </span>
                      <Input type="number" value={0} min={0} max={16} className="h-8 text-sm w-16" />
                    </div>
                  </div>
                  <div className="flex items-center gap-6 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        Accelerator
                        <HintBubble text="Hardware to use for training. 'Auto' detects available hardware. Use 'cuda' for NVIDIA GPUs, 'mps' for Apple Silicon, or 'cpu' for CPU-only (slow)." />
                      </span>
                      <Select value="auto">
                        <SelectTrigger className="h-8 text-sm w-28" id="field-accelerator"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">auto</SelectItem>
                          <SelectItem value="cuda">cuda</SelectItem>
                          <SelectItem value="mps">mps</SelectItem>
                          <SelectItem value="cpu">cpu</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        Number of Devices
                        <HintBubble text="Number of GPUs/devices to use for training. Set to 1 for single-GPU training." />
                      </span>
                      <Input type="number" value={1} min={1} max={8} className="h-8 text-sm w-16" />
                    </div>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" className="accent-primary" />
                      <span className="text-sm">Auto</span>
                    </label>
                  </div>
                </div>

                <Separator className="my-5" />

                {/* 5. W&B */}
                <SectionHeading id="pipeline-wandb" label="WandB" />
                {firstHp ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Status:</span>
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                      <span className="text-sm text-red-400">Not logged in</span>
                    </div>
                    <div className="flex items-center gap-4 flex-wrap">
                      <Toggle label="Enable WandB for logging" id="field-wandb-enable" hint="Log training metrics, loss curves, and visualizations to Weights & Biases for experiment tracking." checked={firstHp.useWandb} onChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { useWandb: v }))} />
                      <Toggle label="Upload Viz" hint="Upload prediction visualization images to W&B for remote viewing." checked={false} onChange={() => {}} />
                      <Toggle label="Open in browser" hint="Automatically open the W&B run page in your browser when training starts." checked={false} onChange={() => {}} />
                    </div>
                    <div className="flex items-center gap-6 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Entity Name:</span>
                        <Input type="text" value={firstHp.wandbEntity} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbEntity: e.target.value }))} placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Project Name:</span>
                        <Input type="text" value={firstHp.wandbProject} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbProject: e.target.value }))} placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                    </div>
                    <div className="flex items-center gap-6 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Previous Run ID:</span>
                        <Input type="text" placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Group Name:</span>
                        <Input type="text" placeholder="" className="h-8 text-sm w-40" disabled={!firstHp.useWandb} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure W&B.</p>
                )}

                <Separator className="my-5" />

                {/* 6. Evaluation */}
                <SectionHeading id="pipeline-evaluation" label="Evaluation" />
                <div className="space-y-3">
                  <div className="flex items-center gap-6">
                    <Toggle label="Run evaluation during training" id="field-eval-enable" hint="Run inference on validation frames at epoch intervals and compute pose metrics (mOKS, mAP, PCK). Useful for monitoring training quality beyond loss." checked={false} onChange={() => {}} />
                    <div className="flex items-center gap-2 opacity-50">
                      <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                        Frequency (epochs):
                        <HintBubble text="How often to run full evaluation. Every 1 epoch is most informative but slower. Every 5–10 epochs is a good balance." />
                      </span>
                      <Input type="number" value={1} min={1} disabled className="h-8 text-sm w-16" />
                    </div>
                  </div>
                </div>

                <Separator className="my-5" />

                {/* 7. Output */}
                <SectionHeading id="pipeline-output" label="Output" />
                {firstHp ? (
                  <div className="space-y-3">
                    <Field label="Run Name" id="field-runname" hint="Name for this training run. Leave empty to auto-generate from timestamp and head type.">
                      <Input type="text" value={firstHp.runName} onChange={(e) => onUpdateSlot(firstConfig!.slot, { runName: e.target.value })} placeholder="Auto-generated" className="h-9 text-sm" />
                    </Field>
                    <Field label="Runs Folder" hint="Directory where the run folder and checkpoints will be created.">
                      <Input type="text" value="models" disabled className="h-9 text-sm" />
                    </Field>
                    <div className="flex items-center gap-6">
                      <span className="text-sm text-muted-foreground">Checkpoint:</span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" defaultChecked className="accent-primary" />
                        <span className="text-sm">Best Model</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" className="accent-primary" />
                        <span className="text-sm">Latest Model</span>
                      </label>
                    </div>
                    <div className="flex items-center gap-6">
                      <span className="text-sm text-muted-foreground">Visualization:</span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" defaultChecked className="accent-primary" />
                        <span className="text-sm">Visualize Predictions</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" className="accent-primary" />
                        <span className="text-sm">Keep Viz Images</span>
                      </label>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure output.</p>
                )}

                <Separator className="my-5" />

                {/* 8. Remote Training */}
                <SectionHeading id="pipeline-remote" label="Remote Training" />
                <div className="space-y-3">
                  <Toggle label="Enable Remote Training" hint="Send training jobs to a remote worker via sleap-connect instead of running locally." checked={remoteEnabled} onChange={onRemoteEnabledChange} />
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
                  configFile={cf}
                  hp={cf.hyperparams}
                  onUpdate={(updates) => onUpdateSlot(cf.slot, updates)}
                  scrollRefCallback={(el) => { headScrollRefs.current[cf.slot] = el; }}
                  skeletonNodes={skeletonNodes}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
