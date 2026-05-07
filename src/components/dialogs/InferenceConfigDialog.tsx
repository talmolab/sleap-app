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

export interface InferenceConfigValues {
  peakThreshold: number;
  maxInstances: number | null;
  anchorPart: string | null;
  integralRefinement: boolean;
  integralPatchSize: number;
  nPoints: number;
  maxEdgeLengthRatio: number;
  distPenaltyWeight: number;
  minLineScores: number;
  trackerMethod: "simple" | "flow";
  similarityMethod: "oks" | "iou" | "centroids" | "euclidean_dist";
  matchingMethod: "hungarian" | "greedy";
  trackingWindowSize: number;
  maxTracks: number | null;
  connectSingleBreaks: boolean;
  robust: number;
  flowImgScale: number;
  flowWindowSize: number;
  flowMaxLevels: number;
  ensureChannels: "auto" | "rgb" | "grayscale";
  filterOverlapping: boolean;
  filterMethod: "iou" | "oks";
  filterThreshold: number;
}

interface InferenceConfigDialogProps {
  open: boolean;
  onClose: () => void;
  values: InferenceConfigValues;
  onUpdate: (updates: Partial<InferenceConfigValues>) => void;
  pipeline: string;
  tracking: boolean;
  skeletonNodes?: string[];
}

const CATEGORIES = [
  { id: "inference", label: "Inference" },
  { id: "tracking", label: "Tracking" },
  { id: "flow", label: "Optical Flow" },
  { id: "advanced", label: "Advanced" },
  { id: "postprocess", label: "Post-processing" },
] as const;

type Category = (typeof CATEGORIES)[number]["id"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <div className="w-44">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <button
        className={`w-9 h-5 rounded-full relative transition-colors ${
          checked ? "bg-primary" : "bg-zinc-700"
        }`}
        onClick={() => onChange(!checked)}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );
}

export function InferenceConfigDialog({
  open,
  onClose,
  values: v,
  onUpdate,
  pipeline,
  tracking,
  skeletonNodes = [],
}: InferenceConfigDialogProps) {
  const [activeCategory, setActiveCategory] = useState<Category>("inference");

  const isTopDown = pipeline === "top-down" || pipeline === "top-down-id";
  const isBottomUp = pipeline === "bottom-up" || pipeline === "bottom-up-id";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="w-full sm:max-w-[750px] max-h-[80vh] p-0 overflow-hidden [backface-visibility:hidden]">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle>Inference Configuration</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 border-t">
          {/* Left nav */}
          <nav className="w-[160px] border-r bg-muted/30 py-2 shrink-0">
            {CATEGORIES.map((cat) => {
              if (cat.id === "flow" && v.trackerMethod !== "flow") return null;
              return (
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
              );
            })}
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {activeCategory === "inference" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Inference Parameters</h3>
                <Field label="Peak Threshold">
                  <Input
                    type="number"
                    value={v.peakThreshold}
                    onChange={(e) => onUpdate({ peakThreshold: Number(e.target.value) })}
                    min={0}
                    max={1}
                    step={0.05}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="Max Instances">
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={v.maxInstances ?? ""}
                      onChange={(e) => onUpdate({ maxInstances: e.target.value ? Number(e.target.value) : null })}
                      min={1}
                      max={100}
                      className="h-8 text-xs flex-1"
                      placeholder="No limit"
                    />
                  </div>
                </Field>
                {isTopDown && (
                  <Field label="Anchor Part">
                    <Select
                      value={v.anchorPart ?? "none"}
                      onValueChange={(val) => onUpdate({ anchorPart: val === "none" ? null : val })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Auto" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Auto (centroid)</SelectItem>
                        {skeletonNodes.map((node) => (
                          <SelectItem key={node} value={node}>{node}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                <Separator className="my-3" />
                <Field label="Ensure Channels">
                  <Select
                    value={v.ensureChannels}
                    onValueChange={(val) => onUpdate({ ensureChannels: val as typeof v.ensureChannels })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto</SelectItem>
                      <SelectItem value="rgb">RGB</SelectItem>
                      <SelectItem value="grayscale">Grayscale</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            )}

            {activeCategory === "tracking" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Tracking</h3>
                {!tracking ? (
                  <p className="text-xs text-muted-foreground">
                    Tracking is disabled. Enable it in the sidebar to configure these settings.
                  </p>
                ) : (
                  <>
                    <Field label="Tracker Method">
                      <Select
                        value={v.trackerMethod}
                        onValueChange={(val) => onUpdate({ trackerMethod: val as typeof v.trackerMethod })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="simple">Simple (instance matching)</SelectItem>
                          <SelectItem value="flow">Optical Flow</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Similarity">
                      <Select
                        value={v.similarityMethod}
                        onValueChange={(val) => onUpdate({ similarityMethod: val as typeof v.similarityMethod })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="oks">Object Keypoint Similarity</SelectItem>
                          <SelectItem value="iou">IoU (bounding box)</SelectItem>
                          <SelectItem value="centroids">Centroid distance</SelectItem>
                          <SelectItem value="euclidean_dist">Euclidean distance</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Matching">
                      <Select
                        value={v.matchingMethod}
                        onValueChange={(val) => onUpdate({ matchingMethod: val as typeof v.matchingMethod })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hungarian">Hungarian</SelectItem>
                          <SelectItem value="greedy">Greedy</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Window Size">
                      <Input
                        type="number"
                        value={v.trackingWindowSize}
                        onChange={(e) => onUpdate({ trackingWindowSize: Number(e.target.value) })}
                        min={1}
                        max={100}
                        className="h-8 text-xs"
                      />
                    </Field>
                    <Field label="Max Tracks">
                      <Input
                        type="number"
                        value={v.maxTracks ?? ""}
                        onChange={(e) => onUpdate({ maxTracks: e.target.value ? Number(e.target.value) : null })}
                        min={1}
                        max={100}
                        className="h-8 text-xs"
                        placeholder="No limit"
                      />
                    </Field>
                    <Field label="Robust (quantile)">
                      <Input
                        type="number"
                        value={v.robust}
                        onChange={(e) => onUpdate({ robust: Number(e.target.value) })}
                        min={0}
                        max={1}
                        step={0.05}
                        className="h-8 text-xs"
                      />
                    </Field>
                    <Toggle
                      label="Connect single-frame breaks"
                      checked={v.connectSingleBreaks}
                      onChange={(val) => onUpdate({ connectSingleBreaks: val })}
                    />
                  </>
                )}
              </div>
            )}

            {activeCategory === "flow" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Optical Flow</h3>
                <Field label="Image Scale">
                  <Input
                    type="number"
                    value={v.flowImgScale}
                    onChange={(e) => onUpdate({ flowImgScale: Number(e.target.value) })}
                    min={0.1}
                    max={2}
                    step={0.1}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="Window Size">
                  <Input
                    type="number"
                    value={v.flowWindowSize}
                    onChange={(e) => onUpdate({ flowWindowSize: Number(e.target.value) })}
                    min={3}
                    max={99}
                    step={2}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="Pyramid Levels">
                  <Input
                    type="number"
                    value={v.flowMaxLevels}
                    onChange={(e) => onUpdate({ flowMaxLevels: Number(e.target.value) })}
                    min={1}
                    max={10}
                    className="h-8 text-xs"
                  />
                </Field>
              </div>
            )}

            {activeCategory === "advanced" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Advanced</h3>
                <Toggle
                  label="Integral Refinement"
                  checked={v.integralRefinement}
                  onChange={(val) => onUpdate({ integralRefinement: val })}
                />
                {v.integralRefinement && (
                  <Field label="Patch Size">
                    <Input
                      type="number"
                      value={v.integralPatchSize}
                      onChange={(e) => onUpdate({ integralPatchSize: Number(e.target.value) })}
                      min={3}
                      max={15}
                      step={2}
                      className="h-8 text-xs"
                    />
                  </Field>
                )}
                {isBottomUp && (
                  <>
                    <Separator className="my-3" />
                    <h4 className="text-xs font-medium text-muted-foreground mb-2">PAF Matching</h4>
                    <Field label="Sample Points">
                      <Input
                        type="number"
                        value={v.nPoints}
                        onChange={(e) => onUpdate({ nPoints: Number(e.target.value) })}
                        min={1}
                        max={50}
                        className="h-8 text-xs"
                      />
                    </Field>
                    <Field label="Max Edge Ratio">
                      <Input
                        type="number"
                        value={v.maxEdgeLengthRatio}
                        onChange={(e) => onUpdate({ maxEdgeLengthRatio: Number(e.target.value) })}
                        min={0}
                        max={1}
                        step={0.05}
                        className="h-8 text-xs"
                      />
                    </Field>
                    <Field label="Distance Penalty">
                      <Input
                        type="number"
                        value={v.distPenaltyWeight}
                        onChange={(e) => onUpdate({ distPenaltyWeight: Number(e.target.value) })}
                        min={0}
                        max={10}
                        step={0.1}
                        className="h-8 text-xs"
                      />
                    </Field>
                    <Field label="Min Line Scores">
                      <Input
                        type="number"
                        value={v.minLineScores}
                        onChange={(e) => onUpdate({ minLineScores: Number(e.target.value) })}
                        min={-1}
                        max={1}
                        step={0.05}
                        className="h-8 text-xs"
                      />
                    </Field>
                  </>
                )}
              </div>
            )}

            {activeCategory === "postprocess" && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium mb-3">Post-processing</h3>
                <Toggle
                  label="Filter Overlapping Instances"
                  checked={v.filterOverlapping}
                  onChange={(val) => onUpdate({ filterOverlapping: val })}
                />
                {v.filterOverlapping && (
                  <>
                    <Field label="Method">
                      <Select
                        value={v.filterMethod}
                        onValueChange={(val) => onUpdate({ filterMethod: val as typeof v.filterMethod })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="iou">IoU</SelectItem>
                          <SelectItem value="oks">OKS</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Threshold">
                      <Input
                        type="number"
                        value={v.filterThreshold}
                        onChange={(e) => onUpdate({ filterThreshold: Number(e.target.value) })}
                        min={0}
                        max={1}
                        step={0.05}
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
