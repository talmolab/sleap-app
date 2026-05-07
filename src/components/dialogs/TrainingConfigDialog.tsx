import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConfigHyperparams, Backbone, AugmentationPreset } from "@/stores/trainingStore";

interface TrainingConfigDialogProps {
  open: boolean;
  onClose: () => void;
  hyperparams: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
}

const CATEGORIES = [
  { id: "model", label: "Model" },
  { id: "training", label: "Training" },
  { id: "data", label: "Data" },
  { id: "augmentation", label: "Augmentation" },
  { id: "head", label: "Head Config" },
  { id: "wandb", label: "W&B" },
] as const;

type Category = (typeof CATEGORIES)[number]["id"];

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <div className="w-40">{children}</div>
    </div>
  );
}

export function TrainingConfigDialog({
  open,
  onClose,
  hyperparams: hp,
  onUpdate,
}: TrainingConfigDialogProps) {
  const [activeCategory, setActiveCategory] = useState<Category>("model");

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="w-full sm:max-w-[750px] max-h-[80vh] p-0 overflow-hidden [backface-visibility:hidden]">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle>Training Configuration</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 border-t">
          {/* Left nav */}
          <nav className="w-[160px] border-r bg-muted/30 py-2 shrink-0">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                className={`w-full text-left px-4 py-1.5 text-xs transition-colors ${
                  activeCategory === cat.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {activeCategory === "model" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Model</h3>
                <Field label="Backbone">
                  <Select
                    value={hp.backbone || ""}
                    onValueChange={(v) => onUpdate({ backbone: v as Backbone })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="From config..." />
                    </SelectTrigger>
                    <SelectContent>
                      {BACKBONE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Run Name">
                  <Input
                    type="text"
                    value={hp.runName}
                    onChange={(e) => onUpdate({ runName: e.target.value })}
                    placeholder="Auto-generated"
                    className="h-8 text-xs"
                  />
                </Field>
              </div>
            )}

            {activeCategory === "training" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Training</h3>
                <Field label="Max Epochs">
                  <Input
                    type="number"
                    value={hp.maxEpochs}
                    onChange={(e) => onUpdate({ maxEpochs: Number(e.target.value) })}
                    min={1}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="Batch Size">
                  <Input
                    type="number"
                    value={hp.batchSize}
                    onChange={(e) => onUpdate({ batchSize: Number(e.target.value) })}
                    min={1}
                    max={128}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="Learning Rate">
                  <Input
                    type="number"
                    value={hp.learningRate}
                    onChange={(e) => onUpdate({ learningRate: Number(e.target.value) })}
                    step={0.0001}
                    className="h-8 text-xs"
                  />
                </Field>
                <Separator className="my-3" />
                <h4 className="text-xs font-medium text-muted-foreground mb-2">Early Stopping</h4>
                <Field label="Patience (epochs)">
                  <Input
                    type="number"
                    value={hp.earlyStoppingPatience}
                    onChange={(e) => onUpdate({ earlyStoppingPatience: Number(e.target.value) })}
                    min={1}
                    max={100}
                    className="h-8 text-xs"
                  />
                </Field>
              </div>
            )}

            {activeCategory === "data" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Data</h3>
                <Field label="Validation Fraction">
                  <Input
                    type="number"
                    value={hp.validationFraction}
                    onChange={(e) => onUpdate({ validationFraction: Number(e.target.value) })}
                    min={0}
                    max={1}
                    step={0.05}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="Input Scale">
                  <Input
                    type="number"
                    value={hp.scale}
                    onChange={(e) => onUpdate({ scale: Number(e.target.value) })}
                    min={0.125}
                    max={1}
                    step={0.125}
                    className="h-8 text-xs"
                  />
                </Field>
              </div>
            )}

            {activeCategory === "augmentation" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Augmentation</h3>
                <Field label="Preset">
                  <Select
                    value={hp.augmentationPreset}
                    onValueChange={(v) => onUpdate({ augmentationPreset: v as AugmentationPreset })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUGMENTATION_PRESET_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label} — {o.desc}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <p className="text-[11px] text-muted-foreground mt-3">
                  Detailed augmentation controls will be available in a future update.
                </p>
              </div>
            )}

            {activeCategory === "head" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Head Configuration</h3>
                <Field label="Sigma">
                  <Input
                    type="number"
                    value={hp.sigma}
                    onChange={(e) => onUpdate({ sigma: Number(e.target.value) })}
                    min={0.5}
                    max={30}
                    step={0.5}
                    className="h-8 text-xs"
                  />
                </Field>
                <p className="text-[11px] text-muted-foreground mt-3">
                  Gaussian spread for confidence map targets. Lower values produce sharper peaks.
                </p>
              </div>
            )}

            {activeCategory === "wandb" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Weights & Biases</h3>
                <Field label="Enable W&B">
                  <button
                    className={`w-9 h-5 rounded-full relative transition-colors ${
                      hp.useWandb ? "bg-primary" : "bg-zinc-700"
                    }`}
                    onClick={() => onUpdate({ useWandb: !hp.useWandb })}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        hp.useWandb ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                </Field>
                {hp.useWandb && (
                  <>
                    <Field label="Entity">
                      <Input
                        type="text"
                        value={hp.wandbEntity}
                        onChange={(e) => onUpdate({ wandbEntity: e.target.value })}
                        placeholder="username/org"
                        className="h-8 text-xs"
                      />
                    </Field>
                    <Field label="Project">
                      <Input
                        type="text"
                        value={hp.wandbProject}
                        onChange={(e) => onUpdate({ wandbProject: e.target.value })}
                        placeholder="project-name"
                        className="h-8 text-xs"
                      />
                    </Field>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-3 border-t">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
