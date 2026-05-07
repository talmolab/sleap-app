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
import { getSlotLabel } from "@/stores/trainingStore";
import { useConnectStore } from "@/stores/connectStore";

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
  { id: "pipeline-preprocessing", label: "Pre/Post-processing" },
  { id: "pipeline-performance", label: "Performance" },
  { id: "pipeline-wandb", label: "W&B" },
  { id: "pipeline-evaluation", label: "Evaluation" },
  { id: "pipeline-output", label: "Output" },
  { id: "pipeline-remote", label: "Remote Training" },
] as const;

const HEAD_NAV = [
  { id: "head-model", label: "Model" },
  { id: "head-optimization", label: "Optimization" },
  { id: "head-augmentation", label: "Augmentation" },
] as const;

const BACKBONE_OPTIONS: { value: Backbone; label: string }[] = [
  { value: "UNet", label: "UNet" },
  { value: "LEAP CNN", label: "LEAP CNN" },
  { value: "Stacked Hourglass", label: "Stacked Hourglass" },
];

const AUGMENTATION_PRESET_OPTIONS: { value: AugmentationPreset; label: string; desc: string }[] = [
  { value: "none", label: "None", desc: "No augmentation" },
  { value: "light", label: "Light", desc: "Rotation ±15°" },
  { value: "standard", label: "Standard", desc: "Rotation ±180° + noise" },
  { value: "heavy", label: "Heavy", desc: "Full augmentation suite" },
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
  { label: "Backbone", section: "head", fieldId: "field-backbone" },
  { label: "Sigma", section: "head", fieldId: "field-sigma" },
  { label: "Max Epochs", section: "head", fieldId: "field-maxepochs" },
  { label: "Batch Size", section: "head", fieldId: "field-batchsize" },
  { label: "Learning Rate", section: "head", fieldId: "field-learningrate" },
  { label: "Early Stopping Patience", section: "head", fieldId: "field-earlystopping" },
  { label: "Augmentation Preset", section: "head", fieldId: "field-augpreset" },
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
  hp,
  onUpdate,
  scrollRefCallback,
}: {
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  scrollRefCallback: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={scrollRefCallback} className="flex-1 overflow-y-auto px-8 py-6 bg-muted/20">
      {/* ── Model ── */}
      <SectionHeading id="head-model" label="Model" />
      <div className="space-y-2">
        <Field label="Backbone" id="field-backbone" hint="UNet is recommended for most cases. ConvNeXt/SwinT have pretrained weights but require RGB images and have fixed max_stride=32.">
          <Select value={hp.backbone || ""} onValueChange={(v) => onUpdate({ backbone: v as Backbone })}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="From config..." /></SelectTrigger>
            <SelectContent>
              {BACKBONE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Sigma" id="field-sigma" hint="Gaussian spread for keypoint heatmaps. Smaller = more precise but harder to train. Larger = easier to train but less spatially precise.">
          <Input type="number" value={hp.sigma} onChange={(e) => onUpdate({ sigma: Number(e.target.value) })} min={0.5} max={30} step={0.5} className="h-9 text-sm" />
        </Field>
      </div>

      <Separator className="my-5" />

      {/* ── Optimization ── */}
      <SectionHeading id="head-optimization" label="Optimization" />
      <div className="space-y-2">
        <Field label="Max Epochs" id="field-maxepochs" hint="Maximum training epochs. Training may stop earlier via early stopping. 100–200 is typical; complex datasets may need more.">
          <Input type="number" value={hp.maxEpochs} onChange={(e) => onUpdate({ maxEpochs: Number(e.target.value) })} min={1} className="h-9 text-sm" />
        </Field>
        <Field label="Batch Size" id="field-batchsize" hint="Number of samples per training batch. Larger batches train faster but use more GPU memory. If you get OOM errors, reduce this first. 4–8 is typical for 8GB GPUs.">
          <Input type="number" value={hp.batchSize} onChange={(e) => onUpdate({ batchSize: Number(e.target.value) })} min={1} max={128} className="h-9 text-sm" />
        </Field>
        <Field label="Learning Rate" id="field-learningrate" hint="Initial learning rate for the optimizer. Lower values train more slowly but may converge better. 1e-4 is a good default.">
          <Input type="number" value={hp.learningRate} onChange={(e) => onUpdate({ learningRate: Number(e.target.value) })} step={0.0001} className="h-9 text-sm" />
        </Field>
        <Separator className="my-4" />
        <h4 className="text-sm font-medium text-muted-foreground mb-3">Early Stopping</h4>
        <Field label="Patience (epochs)" id="field-earlystopping" hint="Number of epochs to wait for improvement before stopping. Higher values allow recovery from plateaus but risk overfitting.">
          <Input type="number" value={hp.earlyStoppingPatience} onChange={(e) => onUpdate({ earlyStoppingPatience: Number(e.target.value) })} min={1} max={100} className="h-9 text-sm" />
        </Field>
      </div>

      <Separator className="my-5" />

      {/* ── Augmentation ── */}
      <SectionHeading id="head-augmentation" label="Augmentation" />
      <div className="space-y-2">
        <Field label="Preset" id="field-augpreset" hint="Data augmentation expands training data via random transformations (rotation, noise, etc.) to help the model generalize and reduce overfitting.">
          <Select value={hp.augmentationPreset} onValueChange={(v) => onUpdate({ augmentationPreset: v as AugmentationPreset })}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AUGMENTATION_PRESET_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label} — {o.desc}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <p className="text-sm text-muted-foreground mt-4">
          Detailed augmentation controls will be available in a future update.
        </p>
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
}: TrainingConfigDialogProps) {
  const pipelineScrollRef = useRef<HTMLDivElement>(null);
  const headScrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeTab, setActiveTab] = useState("pipeline");
  const [searchQuery, setSearchQuery] = useState("");

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
    const targetTab = section === "pipeline" ? "pipeline" : configs[0]?.slot ?? "pipeline";
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
  const firstConfig = configs[0];
  const firstHp = firstConfig?.hyperparams;

  const room = availableRooms.find((r) => r.roomId === roomId);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) { onClose(); setSearchQuery(""); } }}>
      <DialogContent className="w-full sm:max-w-[1000px] h-[70vh] p-0 overflow-hidden inset-0 translate-x-0 translate-y-0 m-auto flex flex-col">
        <DialogHeader className="px-6 pt-5 pb-3 shrink-0">
          <DialogTitle className="text-lg">Training Configuration</DialogTitle>
          <div className="relative mt-2">
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
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
          <div className="flex justify-center mx-6 shrink-0">
            <TabsList className="h-9">
              <TabsTrigger value="pipeline" className="text-sm">Training Pipeline</TabsTrigger>
              {configs.map((cf) => (
                <TabsTrigger key={cf.slot} value={cf.slot} className="text-sm">
                  {getSlotLabel(cf.slot).replace(" Config", "")} Model Configuration
                </TabsTrigger>
              ))}
            </TabsList>
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
                <div className="space-y-2">
                  <Field label="Post-Training Target" hint="Which frames to run inference on after training completes. Predictions will be merged back into the project.">
                    <Select value={inferenceTarget} onValueChange={onInferenceTargetChange}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
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
                  </Field>
                </div>

                <Separator className="my-5" />

                {/* 3. Preprocessing / Post-processing */}
                <SectionHeading id="pipeline-preprocessing" label="Preprocessing / Post-processing" />
                {firstHp ? (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Preprocessing</h4>
                    <Field label="Input Scale" id="field-inputscale" hint="Factor to resize images before feeding to the model. Lower = faster training + larger effective receptive field. Higher = more detail preserved but slower.">
                      <Input type="number" value={firstHp.scale} onChange={(e) => { const v = Number(e.target.value); configs.forEach((c) => onUpdateSlot(c.slot, { scale: v })); }} min={0.125} max={1} step={0.125} className="h-9 text-sm" />
                    </Field>
                    <Field label="Validation Fraction" id="field-valfraction" hint="Fraction of labeled frames held out for validation. Used to monitor training and for early stopping. 10–20% is typical.">
                      <Input type="number" value={firstHp.validationFraction} onChange={(e) => { const v = Number(e.target.value); configs.forEach((c) => onUpdateSlot(c.slot, { validationFraction: v })); }} min={0} max={1} step={0.05} className="h-9 text-sm" />
                    </Field>
                    <Separator className="my-4" />
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Post-processing (inference)</h4>
                    <Field label="Ensure Channels" id="field-ensurechannels" hint="Convert input images to a specific channel format during post-training inference. Use RGB for pretrained backbones or Grayscale for single-channel videos.">
                      <Select value="auto" disabled>
                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto</SelectItem>
                          <SelectItem value="rgb">RGB</SelectItem>
                          <SelectItem value="grayscale">Grayscale</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Max Instances" id="field-maxinstances" hint="Maximum number of animal instances to detect per frame during post-training inference. Leave empty for no limit.">
                      <Input type="number" placeholder="No limit" disabled className="h-9 text-sm" />
                    </Field>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure preprocessing.</p>
                )}

                <Separator className="my-5" />

                {/* 4. Performance */}
                <SectionHeading id="pipeline-performance" label="Performance" />
                <div className="space-y-2">
                  <Field label="Accelerator" id="field-accelerator" hint="Hardware to use for training. 'Auto' detects available hardware automatically. Use GPU for NVIDIA, MPS for Apple Silicon, or CPU for CPU-only (slow).">
                    <Select value="auto" disabled>
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="cuda">CUDA (GPU)</SelectItem>
                        <SelectItem value="mps">MPS (Apple Silicon)</SelectItem>
                        <SelectItem value="cpu">CPU</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <p className="text-[11px] text-muted-foreground">
                    Additional performance options (data pipeline caching, dataloader workers) will be available in a future update.
                  </p>
                </div>

                <Separator className="my-5" />

                {/* 5. W&B */}
                <SectionHeading id="pipeline-wandb" label="Weights & Biases" />
                {firstHp ? (
                  <div className="space-y-2">
                    <Toggle label="Enable W&B" id="field-wandb-enable" hint="Log training metrics, loss curves, and visualizations to Weights & Biases for experiment tracking." checked={firstHp.useWandb} onChange={(v) => configs.forEach((c) => onUpdateSlot(c.slot, { useWandb: v }))} />
                    {firstHp.useWandb && (
                      <>
                        <Field label="Entity" id="field-wandb-entity" hint="W&B username or organization name.">
                          <Input type="text" value={firstHp.wandbEntity} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbEntity: e.target.value }))} placeholder="username/org" className="h-9 text-sm" />
                        </Field>
                        <Field label="Project" id="field-wandb-project" hint="W&B project name for grouping training runs.">
                          <Input type="text" value={firstHp.wandbProject} onChange={(e) => configs.forEach((c) => onUpdateSlot(c.slot, { wandbProject: e.target.value }))} placeholder="project-name" className="h-9 text-sm" />
                        </Field>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure W&B.</p>
                )}

                <Separator className="my-5" />

                {/* 6. Evaluation */}
                <SectionHeading id="pipeline-evaluation" label="Evaluation" />
                <div className="space-y-2">
                  <Toggle label="Run evaluation during training" id="field-eval-enable" hint="Run inference on validation frames at epoch intervals and compute pose metrics (mOKS, mAP, PCK). Useful for monitoring training quality beyond loss." checked={false} onChange={() => {}} />
                  <p className="text-[11px] text-muted-foreground">
                    Evaluation settings (frequency, metric selection) will be available in a future update.
                  </p>
                </div>

                <Separator className="my-5" />

                {/* 7. Output */}
                <SectionHeading id="pipeline-output" label="Output" />
                {firstHp ? (
                  <div className="space-y-2">
                    <Field label="Run Name" id="field-runname" hint="Name for this training run. Leave empty to auto-generate from timestamp and head type.">
                      <Input type="text" value={firstHp.runName} onChange={(e) => onUpdateSlot(firstConfig!.slot, { runName: e.target.value })} placeholder="Auto-generated" className="h-9 text-sm" />
                    </Field>
                    <p className="text-[11px] text-muted-foreground">
                      Checkpoint options (runs folder, save best/last model) will be available in a future update.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload config files to configure output.</p>
                )}

                <Separator className="my-5" />

                {/* 8. Remote Training */}
                <SectionHeading id="pipeline-remote" label="Remote Training" />
                <div className="space-y-2">
                  <Toggle label="Enable Remote Training" hint="Send training jobs to a remote worker via sleap-connect instead of running locally." checked={remoteEnabled} onChange={onRemoteEnabledChange} />
                  {remoteEnabled && connectionStatus === "connected" && (
                    <>
                      <Field label="Room">
                        <span className="text-sm flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          {room?.name || roomId}
                        </span>
                      </Field>
                      <Field label="Worker" hint="Select which worker will run the training job. Workers with GPUs are preferred.">
                        <Select value={selectedWorkerId || ""} onValueChange={selectWorker}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select a worker" /></SelectTrigger>
                          <SelectContent>
                            {workers.map((w) => (
                              <SelectItem key={w.peerId} value={w.peerId} disabled={w.status !== "available"}>
                                {w.name}{w.gpu ? ` (${w.gpu.model})` : ""}{w.status !== "available" ? ` — ${w.status}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    </>
                  )}
                  {remoteEnabled && connectionStatus !== "connected" && (
                    <p className="text-sm text-muted-foreground">
                      Connect to a room in the Connect tab to enable remote training.
                    </p>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* ── Per-head tabs ── */}
            {configs.map((cf) => (
              <TabsContent key={cf.slot} value={cf.slot} className="flex-1 min-h-0 mt-0 overflow-hidden">
                <HeadTabContent
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
