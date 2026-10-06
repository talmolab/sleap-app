import { useRef, useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, ChevronDown, ChevronRight, Check, RotateCcw } from "lucide-react";
import { HintBubble } from "@/components/HintBubble";
import { confirmDialog } from "@/stores/confirmStore";

export interface InferenceConfigValues {
  peakThreshold: number;
  maxInstances: number | null;
  integralRefinement: boolean;
  integralPatchSize: number;
  nPoints: number;
  maxEdgeLengthRatio: number;
  distPenaltyWeight: number;
  minLineScores: number;
  trackerMethod: "simple" | "flow" | "kalman";
  similarityMethod: "oks" | "iou" | "centroids" | "euclidean_dist";
  matchingMethod: "hungarian" | "greedy";
  trackingWindowSize: number;
  maxTracks: number | null;
  connectSingleBreaks: boolean;
  robust: number;
  minMatchPoints: number;
  minNewTrackPoints: number;
  scoringReduction: "mean" | "max" | "robust_quantile";
  trackingTargetInstanceCount: number | null;
  trackingPreCullToTarget: boolean;
  trackingPreCullIouThreshold: number;
  trackingCleanInstanceCount: number | null;
  trackingCleanIouThreshold: number;
  flowImgScale: number;
  flowWindowSize: number;
  flowMaxLevels: number;
  kfTrackFeatures: "centroid" | "keypoints";
  kfInitFrameCount: number;
  kfNodeIndices: number[];
  kfResetGapSize: number;
  ensureChannels: "auto" | "rgb" | "grayscale";
  filterOverlapping: boolean;
  filterMethod: "iou" | "oks";
  filterThreshold: number;
  filterMinVisibleNodes: number | null;
  filterMinVisibleNodeFraction: number | null;
  filterMinMeanNodeScore: number | null;
  filterMinInstanceScore: number | null;
  filterMinCentroidDistance: number | null;
}

interface InferenceConfigDialogProps {
  open: boolean;
  onClose: () => void;
  values: InferenceConfigValues;
  onUpdate: (updates: Partial<InferenceConfigValues>) => void;
  pipeline: string;
  tracking: boolean;
  onTrackingChange: (enabled: boolean) => void;
  skeletonNodes: string[];
  /** When provided, shows a "Reset to defaults…" footer action. */
  onResetDefaults?: () => void;
}

const CATEGORIES = [
  { id: "inference", label: "Inference" },
  { id: "tracking", label: "Tracking" },
  { id: "flow", label: "Optical Flow" },
  { id: "kalman", label: "Kalman Filter" },
  { id: "advanced", label: "Advanced" },
  { id: "postprocess", label: "Post-processing" },
] as const;

const SEARCHABLE_FIELDS = [
  { label: "Peak Threshold", section: "inference", fieldId: "field-peakthreshold" },
  { label: "Max Instances", section: "inference", fieldId: "field-maxinstances" },
  { label: "Ensure Channels", section: "inference", fieldId: "field-ensurechannels" },
  { label: "Tracker Method", section: "tracking", fieldId: "field-trackermethod" },
  { label: "Similarity", section: "tracking", fieldId: "field-similarity" },
  { label: "Matching", section: "tracking", fieldId: "field-matching" },
  { label: "Window Size", section: "tracking", fieldId: "field-trackwindow" },
  { label: "Max Tracks", section: "tracking", fieldId: "field-maxtracks" },
  { label: "Robust (quantile)", section: "tracking", fieldId: "field-robust" },
  { label: "Connect Single-Frame Breaks", section: "tracking", fieldId: "field-connectbreaks" },
  { label: "Min Match Points", section: "tracking", fieldId: "field-minmatchpoints" },
  { label: "Min New Track Points", section: "tracking", fieldId: "field-minnewtrackpoints" },
  { label: "Scoring Reduction", section: "tracking", fieldId: "field-scoringreduction" },
  { label: "Target Instance Count", section: "tracking", fieldId: "field-targetinstancecount" },
  { label: "Pre-cull to Target", section: "tracking", fieldId: "field-precull" },
  { label: "Pre-cull IoU Threshold", section: "tracking", fieldId: "field-precull-iou" },
  { label: "Clean-up Instance Count", section: "tracking", fieldId: "field-cleaninstancecount" },
  { label: "Clean-up IoU Threshold", section: "tracking", fieldId: "field-cleaniou" },
  { label: "Image Scale", section: "flow", fieldId: "field-flowscale" },
  { label: "Flow Window Size", section: "flow", fieldId: "field-flowwindow" },
  { label: "Pyramid Levels", section: "flow", fieldId: "field-flowlevels" },
  { label: "Kalman Track Features", section: "kalman", fieldId: "field-kftrackfeatures" },
  { label: "Kalman Init Frame Count", section: "kalman", fieldId: "field-kfinitframecount" },
  { label: "Kalman Reset Gap Size", section: "kalman", fieldId: "field-kfresetgapsize" },
  { label: "Kalman Tracked Nodes", section: "kalman", fieldId: "field-kfnodeindices" },
  { label: "Integral Refinement", section: "advanced", fieldId: "field-integralrefinement" },
  { label: "Integral Patch Size", section: "advanced", fieldId: "field-integralpatch" },
  { label: "Sample Points", section: "advanced", fieldId: "field-npoints" },
  { label: "Max Edge Ratio", section: "advanced", fieldId: "field-maxedgeratio" },
  { label: "Distance Penalty", section: "advanced", fieldId: "field-distpenalty" },
  { label: "Min Line Scores", section: "advanced", fieldId: "field-minlinescores" },
  { label: "Filter Overlapping", section: "postprocess", fieldId: "field-filteroverlapping" },
  { label: "Filter Method", section: "postprocess", fieldId: "field-filtermethod" },
  { label: "Filter Threshold", section: "postprocess", fieldId: "field-filterthreshold" },
  { label: "Min Visible Nodes", section: "postprocess", fieldId: "field-filterminvisiblenodes" },
  { label: "Min Visible Node Fraction", section: "postprocess", fieldId: "field-filterminvisiblenodefraction" },
  { label: "Min Mean Node Score", section: "postprocess", fieldId: "field-filterminmeannodescore" },
  { label: "Min Instance Score", section: "postprocess", fieldId: "field-filterminstancescore" },
  { label: "Min Centroid Distance", section: "postprocess", fieldId: "field-filtermincentroiddistance" },
];

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
        className={`w-10 h-6 rounded-full relative transition-colors ${
          checked ? "bg-primary" : "bg-zinc-700"
        }`}
        onClick={() => onChange(!checked)}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );
}

/** A Toggle that enables/disables an optional numeric filter, revealing its value field only when on. */
function ToggleNumberField({
  label,
  id,
  hint,
  valueLabel,
  value,
  onChange,
  defaultValue,
  min,
  max,
  step,
}: {
  label: string;
  id?: string;
  hint?: string;
  valueLabel: string;
  value: number | null;
  onChange: (v: number | null) => void;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <>
      <Toggle
        label={label}
        id={id}
        hint={hint}
        checked={value != null}
        onChange={(checked) => onChange(checked ? defaultValue : null)}
      />
      {value != null && (
        <Field label={valueLabel}>
          <Input
            type="number"
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            min={min}
            max={max}
            step={step}
            className="h-9 text-sm"
          />
        </Field>
      )}
    </>
  );
}

function SectionHeading({ id, label }: { id: string; label: string }) {
  return (
    <h3 id={id} className="text-base font-medium pt-6 pb-3 first:pt-0 scroll-mt-4">
      {label}
    </h3>
  );
}

function NodeMultiSelect({
  label,
  id,
  hint,
  nodes,
  selected,
  onChange,
}: {
  label: string;
  id?: string;
  hint?: string;
  nodes: string[];
  selected: number[];
  onChange: (indices: number[]) => void;
}) {
  const toggle = (i: number) => {
    onChange(
      selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i].sort((a, b) => a - b)
    );
  };
  return (
    <div id={id} className="flex items-start gap-6 py-2.5 scroll-mt-4">
      <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1.5 pt-1.5">
        {label}
        {hint && <HintBubble text={hint} />}
      </span>
      <div className="flex-1 min-w-0">
        {nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-1.5">
            No skeleton loaded — leave unset to use all nodes.
          </p>
        ) : (
          <div className="border rounded-md max-h-40 overflow-y-auto p-2 space-y-1">
            {nodes.map((name, i) => (
              <label key={i} className="flex items-center gap-2 text-sm px-1 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.includes(i)}
                  onChange={() => toggle(i)}
                  className="h-3.5 w-3.5"
                />
                {name}
              </label>
            ))}
          </div>
        )}
      </div>
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
  onTrackingChange,
  skeletonNodes,
  onResetDefaults,
}: InferenceConfigDialogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showTrackingAdvanced, setShowTrackingAdvanced] = useState(false);

  const isBottomUp = pipeline === "bottom-up" || pipeline === "bottom-up-id";

  const scrollTo = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector(`#${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const searchResults = searchQuery.trim()
    ? SEARCHABLE_FIELDS.filter((f) =>
        f.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : [];

  const handleSearchSelect = (fieldId: string) => {
    setSearchQuery("");
    const el = scrollRef.current?.querySelector(`#${fieldId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-primary", "rounded");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary", "rounded"), 1500);
    }
  };

  const handleResetDefaults = async () => {
    const ok = await confirmDialog({
      title: "Reset to defaults?",
      message: "This restores all inference parameters to their default values, discarding your edits.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (ok) onResetDefaults?.();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) { onClose(); setSearchQuery(""); } }}>
      <DialogContent showCloseButton={false} className="w-[92vw] h-[90vh] min-w-[640px] min-h-[480px] max-w-[96vw] sm:max-w-[96vw] max-h-[94vh] resize overflow-hidden p-0 inset-0 translate-x-0 translate-y-0 m-auto flex flex-col" onKeyDown={(e) => e.stopPropagation()}>
        {/* Compact header: title (left) · saved indicator (right) */}
        <div className="relative flex items-center justify-between gap-4 px-6 py-2.5 border-b shrink-0">
          <DialogTitle className="text-base font-semibold shrink-0">Inference Configuration</DialogTitle>
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0"
            title="Edits are saved automatically as you type"
          >
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            All changes saved
          </span>
        </div>

        {/* Field search — full-width row snug below the header */}
        <div className="relative px-6 py-2 border-b shrink-0">
          <Search className="absolute left-8 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search parameters..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 text-sm pl-9"
          />
          {searchResults.length > 0 && (
            <div className="absolute top-full left-6 right-6 mt-1 bg-popover border rounded-md shadow-lg z-10 max-h-48 overflow-y-auto">
              {searchResults.map((r) => (
                <button
                  key={r.fieldId}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent/50 flex items-center justify-between"
                  onClick={() => handleSearchSelect(r.fieldId)}
                >
                  <span>{r.label}</span>
                  <span className="text-xs text-muted-foreground">{CATEGORIES.find((c) => c.id === r.section)?.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left nav — jump links */}
          <nav className="w-[180px] border-r bg-muted/30 py-3 shrink-0">
            {CATEGORIES.filter(
              (cat) =>
                (cat.id !== "flow" || v.trackerMethod === "flow") &&
                (cat.id !== "kalman" || v.trackerMethod === "kalman")
            ).map((cat) => (
              <button
                key={cat.id}
                className="w-full text-left px-5 py-2.5 text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50"
                onClick={() => scrollTo(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </nav>

          {/* Scrollable content — all sections visible */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6">
            {/* ── Inference ── */}
            <SectionHeading id="inference" label="Inference Parameters" />
            <div className="space-y-2">
              <Field label="Peak Threshold" id="field-peakthreshold" hint="Minimum confidence score for a detected keypoint to be kept. Lower values detect more points but may include false positives.">
                <Input
                  type="number"
                  value={v.peakThreshold}
                  onChange={(e) => onUpdate({ peakThreshold: Number(e.target.value) })}
                  min={0}
                  max={1}
                  step={0.05}
                  className="h-9 text-sm"
                />
              </Field>
              <Field label="Max Instances" id="field-maxinstances" hint="Maximum number of animal instances to detect per frame. Leave empty for no limit.">
                <Input
                  type="number"
                  value={v.maxInstances ?? ""}
                  onChange={(e) => onUpdate({ maxInstances: e.target.value ? Number(e.target.value) : null })}
                  min={1}
                  max={100}
                  className="h-9 text-sm"
                  placeholder="No limit"
                />
              </Field>
              <Field label="Ensure Channels" id="field-ensurechannels" hint="Convert input images to a specific channel format. Use RGB for pretrained backbones or Grayscale for single-channel videos.">
                <Select
                  value={v.ensureChannels}
                  onValueChange={(val) => onUpdate({ ensureChannels: val as typeof v.ensureChannels })}
                >
                  <SelectTrigger className="h-9 text-sm">
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

            <Separator className="my-5" />

            {/* ── Tracking ── */}
            <SectionHeading id="tracking" label="Tracking" />
            <div className="space-y-2">
              <Toggle label="Enable Tracking" hint="Connect predicted instances across frames to maintain identity over time." checked={tracking} onChange={onTrackingChange} />
              {!tracking ? (
                <p className="text-sm text-muted-foreground">
                  Tracking is disabled. Enable it above to configure tracking settings.
                </p>
              ) : (
                <>
                  <Field label="Tracker Method" id="field-trackermethod" hint="Simple matches instances by similarity alone. Optical Flow predicts motion from pixel displacement — best for fast-moving animals. Kalman Filter predicts motion from a per-track velocity model — best for a known, fixed number of animals whose motion helps disambiguate crossings or occlusions.">
                    <Select
                      value={v.trackerMethod}
                      onValueChange={(val) => onUpdate({ trackerMethod: val as typeof v.trackerMethod })}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="simple">Simple (instance matching)</SelectItem>
                        <SelectItem value="flow">Optical Flow</SelectItem>
                        <SelectItem value="kalman">Kalman Filter</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Similarity" id="field-similarity" hint="Metric for comparing instances across frames. OKS uses keypoint positions, IoU uses bounding boxes, Centroids uses center distance.">
                    <Select
                      value={v.similarityMethod}
                      onValueChange={(val) => onUpdate({ similarityMethod: val as typeof v.similarityMethod })}
                    >
                      <SelectTrigger className="h-9 text-sm">
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
                  <Field label="Matching" id="field-matching" hint="Algorithm for assigning detections to tracks. Hungarian finds the globally optimal assignment; Greedy is faster but may be suboptimal.">
                    <Select
                      value={v.matchingMethod}
                      onValueChange={(val) => onUpdate({ matchingMethod: val as typeof v.matchingMethod })}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hungarian">Hungarian</SelectItem>
                        <SelectItem value="greedy">Greedy</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Window Size" id="field-trackwindow" hint="Number of past frames used as matching candidates. Fixed Window (default) uses the last N frames; Local Queues (used automatically when Max Tracks is set) keeps the last N instances per track ID instead — more robust to track breaks and occlusions.">
                    <Input
                      type="number"
                      value={v.trackingWindowSize}
                      onChange={(e) => onUpdate({ trackingWindowSize: Number(e.target.value) })}
                      min={1}
                      max={100}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Max Tracks" id="field-maxtracks" hint="Maximum number of simultaneous tracks. Leave empty for no limit; set to the number of animals if known. Setting this automatically switches matching to Local Queues, since Fixed Window ignores this cap.">
                    <Input
                      type="number"
                      value={v.maxTracks ?? ""}
                      onChange={(e) => onUpdate({ maxTracks: e.target.value ? Number(e.target.value) : null })}
                      min={1}
                      max={100}
                      className="h-9 text-sm"
                      placeholder="No limit"
                    />
                  </Field>
                  <button
                    className="flex items-center gap-1 pt-2 text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => setShowTrackingAdvanced((v) => !v)}
                  >
                    {showTrackingAdvanced ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    Advanced
                  </button>
                  {showTrackingAdvanced && (
                    <>
                      <Field label="Robust (quantile)" id="field-robust" hint="If between 0 and 1 (exclusive), uses a robust quantile similarity score instead of the plain max across matched keypoints — 0.95 is a good starting value. Leave at 1 to use max similarity (non-robust).">
                        <Input
                          type="number"
                          value={v.robust}
                          onChange={(e) => onUpdate({ robust: Number(e.target.value) })}
                          min={0}
                          max={1}
                          step={0.05}
                          className="h-9 text-sm"
                        />
                      </Field>
                      <Toggle
                        label="Connect single-frame breaks"
                        id="field-connectbreaks"
                        hint="When Max Tracks is set (Local Queues matching), reconnects a track break where exactly one track is lost and exactly one new track is spawned in the same frame — fixes brief detection dropouts without merging unrelated tracks."
                        checked={v.connectSingleBreaks}
                        onChange={(val) => onUpdate({ connectSingleBreaks: val })}
                      />
                      <Field label="Min Match Points" id="field-minmatchpoints" hint="Minimum number of non-missing keypoints an instance needs to be considered a valid match candidate.">
                        <Input
                          type="number"
                          value={v.minMatchPoints}
                          onChange={(e) => onUpdate({ minMatchPoints: Number(e.target.value) })}
                          min={0}
                          className="h-9 text-sm"
                        />
                      </Field>
                      <Field label="Min New Track Points" id="field-minnewtrackpoints" hint="Minimum number of non-missing keypoints required before an unmatched instance is allowed to spawn a new track.">
                        <Input
                          type="number"
                          value={v.minNewTrackPoints}
                          onChange={(e) => onUpdate({ minNewTrackPoints: Number(e.target.value) })}
                          min={0}
                          className="h-9 text-sm"
                        />
                      </Field>
                      <Field label="Scoring Reduction" id="field-scoringreduction" hint="How to combine multiple similarity scores when several detections could match the same track: Mean averages them, Max takes the best score, Robust quantile is tolerant of outlier scores.">
                        <Select
                          value={v.scoringReduction}
                          onValueChange={(val) => onUpdate({ scoringReduction: val as typeof v.scoringReduction })}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="mean">Mean</SelectItem>
                            <SelectItem value="max">Max</SelectItem>
                            <SelectItem value="robust_quantile">Robust quantile</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Target Instance Count" id="field-targetinstancecount" hint="Target number of instances to track per frame. Required by Kalman filtering and pre-cull; auto-derived from Max Tracks/Max Instances if left empty.">
                        <Input
                          type="number"
                          value={v.trackingTargetInstanceCount ?? ""}
                          onChange={(e) => onUpdate({ trackingTargetInstanceCount: e.target.value ? Number(e.target.value) : null })}
                          min={1}
                          max={100}
                          className="h-9 text-sm"
                          placeholder="Auto"
                        />
                      </Field>
                      <Toggle
                        label="Pre-cull to target"
                        id="field-precull"
                        hint="Before tracking, discard excess instances above the target instance count for that frame."
                        checked={v.trackingPreCullToTarget}
                        onChange={(val) => onUpdate({ trackingPreCullToTarget: val })}
                      />
                      {v.trackingPreCullToTarget && (
                        <Field label="Pre-cull IoU Threshold" id="field-precull-iou" hint="IoU threshold used to remove overlapping instances above the target count before tracking.">
                          <Input
                            type="number"
                            value={v.trackingPreCullIouThreshold}
                            onChange={(e) => onUpdate({ trackingPreCullIouThreshold: Number(e.target.value) })}
                            min={0}
                            max={1}
                            step={0.05}
                            className="h-9 text-sm"
                          />
                        </Field>
                      )}
                      <Field label="Clean-up Instance Count" id="field-cleaninstancecount" hint="After tracking, cull instances above this target count per frame — unlike Pre-cull (which trims before tracking), this trims the tracked output. Leave empty to disable.">
                        <Input
                          type="number"
                          value={v.trackingCleanInstanceCount ?? ""}
                          onChange={(e) => onUpdate({ trackingCleanInstanceCount: e.target.value ? Number(e.target.value) : null })}
                          min={1}
                          max={100}
                          className="h-9 text-sm"
                          placeholder="Disabled"
                        />
                      </Field>
                      {v.trackingCleanInstanceCount != null && (
                        <Field label="Clean-up IoU Threshold" id="field-cleaniou" hint="IoU threshold used when culling instances above the clean-up target count after tracking.">
                          <Input
                            type="number"
                            value={v.trackingCleanIouThreshold}
                            onChange={(e) => onUpdate({ trackingCleanIouThreshold: Number(e.target.value) })}
                            min={0}
                            max={1}
                            step={0.05}
                            className="h-9 text-sm"
                          />
                        </Field>
                      )}
                    </>
                  )}
                </>
              )}
            </div>

            <Separator className="my-5" />

            {v.trackerMethod === "flow" && (
              <>
                {/* ── Optical Flow ── */}
                <SectionHeading id="flow" label="Optical Flow" />
                <div className="space-y-2">
                  <Field label="Image Scale" id="field-flowscale" hint="Scale factor for images before computing optical flow. Lower values are faster but less precise.">
                    <Input
                      type="number"
                      value={v.flowImgScale}
                      onChange={(e) => onUpdate({ flowImgScale: Number(e.target.value) })}
                      min={0.1}
                      max={2}
                      step={0.1}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Window Size" id="field-flowwindow" hint="Size of the search window for optical flow computation. Larger windows handle faster motion but are slower.">
                    <Input
                      type="number"
                      value={v.flowWindowSize}
                      onChange={(e) => onUpdate({ flowWindowSize: Number(e.target.value) })}
                      min={3}
                      max={99}
                      step={2}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Pyramid Levels" id="field-flowlevels" hint="Number of image pyramid levels for multi-scale optical flow. More levels handle larger displacements.">
                    <Input
                      type="number"
                      value={v.flowMaxLevels}
                      onChange={(e) => onUpdate({ flowMaxLevels: Number(e.target.value) })}
                      min={1}
                      max={10}
                      className="h-9 text-sm"
                    />
                  </Field>
                </div>

                <Separator className="my-5" />
              </>
            )}

            {v.trackerMethod === "kalman" && (
              <>
                {/* ── Kalman Filter ── */}
                <SectionHeading id="kalman" label="Kalman Filter" />
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Poses are predicted with a per-track constant-velocity Kalman filter. Requires a
                    Target Instance Count (set above, or auto-derived from Max Tracks/Max Instances).
                  </p>
                  <Field label="Track Features" id="field-kftrackfeatures" hint="What the motion model tracks: Centroid is rigid and stable; Keypoints models per-node motion (noisier — pair with IoU scoring for best results).">
                    <Select
                      value={v.kfTrackFeatures}
                      onValueChange={(val) => onUpdate({ kfTrackFeatures: val as typeof v.kfTrackFeatures })}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="centroid">Centroid</SelectItem>
                        <SelectItem value="keypoints">Keypoints</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Init Frame Count" id="field-kfinitframecount" hint="Number of warm-up frames tracked with the base tracker before the Kalman filters are fit.">
                    <Input
                      type="number"
                      value={v.kfInitFrameCount}
                      onChange={(e) => onUpdate({ kfInitFrameCount: Number(e.target.value) })}
                      min={1}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Reset Gap Size" id="field-kfresetgapsize" hint="Number of consecutive missed frames after which a stale track's Kalman filter is reset.">
                    <Input
                      type="number"
                      value={v.kfResetGapSize}
                      onChange={(e) => onUpdate({ kfResetGapSize: Number(e.target.value) })}
                      min={1}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <NodeMultiSelect
                    label="Tracked Nodes"
                    id="field-kfnodeindices"
                    hint="Skeleton nodes to track with the motion model. Leave all unchecked to use every node."
                    nodes={skeletonNodes}
                    selected={v.kfNodeIndices}
                    onChange={(indices) => onUpdate({ kfNodeIndices: indices })}
                  />
                </div>

                <Separator className="my-5" />
              </>
            )}

            {/* ── Advanced ── */}
            <SectionHeading id="advanced" label="Advanced" />
            <div className="space-y-2">
              <Toggle
                label="Integral Refinement"
                id="field-integralrefinement"
                hint="Use integral regression to refine keypoint locations to sub-pixel accuracy. Recommended for most pipelines."
                checked={v.integralRefinement}
                onChange={(val) => onUpdate({ integralRefinement: val })}
              />
              {v.integralRefinement && (
                <Field label="Patch Size" id="field-integralpatch" hint="Size of the local patch around each peak used for integral regression refinement. Larger patches are more robust but slower.">
                  <Input
                    type="number"
                    value={v.integralPatchSize}
                    onChange={(e) => onUpdate({ integralPatchSize: Number(e.target.value) })}
                    min={3}
                    max={15}
                    step={2}
                    className="h-9 text-sm"
                  />
                </Field>
              )}
              {isBottomUp && (
                <>
                  <Separator className="my-4" />
                  <h4 className="text-sm font-medium text-muted-foreground mb-3">PAF Matching</h4>
                  <Field label="Sample Points" id="field-npoints" hint="Number of points sampled along each edge for PAF scoring. More points give better accuracy but are slower.">
                    <Input
                      type="number"
                      value={v.nPoints}
                      onChange={(e) => onUpdate({ nPoints: Number(e.target.value) })}
                      min={1}
                      max={50}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Max Edge Ratio" id="field-maxedgeratio" hint="Maximum edge length as a fraction of image size. Edges longer than this are discarded during PAF matching.">
                    <Input
                      type="number"
                      value={v.maxEdgeLengthRatio}
                      onChange={(e) => onUpdate({ maxEdgeLengthRatio: Number(e.target.value) })}
                      min={0}
                      max={1}
                      step={0.05}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Distance Penalty" id="field-distpenalty" hint="Weight for penalizing long edges during PAF grouping. Higher values prefer shorter connections between keypoints.">
                    <Input
                      type="number"
                      value={v.distPenaltyWeight}
                      onChange={(e) => onUpdate({ distPenaltyWeight: Number(e.target.value) })}
                      min={0}
                      max={10}
                      step={0.1}
                      className="h-9 text-sm"
                    />
                  </Field>
                  <Field label="Min Line Scores" id="field-minlinescores" hint="Minimum PAF score for an edge to be considered valid. Lower values are more permissive.">
                    <Input
                      type="number"
                      value={v.minLineScores}
                      onChange={(e) => onUpdate({ minLineScores: Number(e.target.value) })}
                      min={-1}
                      max={1}
                      step={0.05}
                      className="h-9 text-sm"
                    />
                  </Field>
                </>
              )}
            </div>

            <Separator className="my-5" />

            {/* ── Post-processing ── */}
            <SectionHeading id="postprocess" label="Post-processing" />
            <div className="space-y-2">
              <Toggle
                label="Filter Overlapping Instances"
                id="field-filteroverlapping"
                hint="Remove duplicate detections that overlap significantly, using greedy non-max suppression. Applied independently of tracking, after node-count and confidence filters."
                checked={v.filterOverlapping}
                onChange={(val) => onUpdate({ filterOverlapping: val })}
              />
              {v.filterOverlapping && (
                <>
                  <Field label="Method" id="field-filtermethod" hint="Metric for measuring overlap. IoU uses bounding box intersection; OKS uses keypoint similarity.">
                    <Select
                      value={v.filterMethod}
                      onValueChange={(val) => onUpdate({ filterMethod: val as typeof v.filterMethod })}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="iou">IoU</SelectItem>
                        <SelectItem value="oks">OKS</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Threshold" id="field-filterthreshold" hint="Overlap score above which instances are considered duplicates and the lower-scoring one is removed. Lower is more aggressive (~0.3), higher is more permissive (0.8 default).">
                    <Input
                      type="number"
                      value={v.filterThreshold}
                      onChange={(e) => onUpdate({ filterThreshold: Number(e.target.value) })}
                      min={0}
                      max={1}
                      step={0.05}
                      className="h-9 text-sm"
                    />
                  </Field>
                </>
              )}

              <Separator className="my-4" />

              <ToggleNumberField
                label="Min Visible Nodes"
                id="field-filterminvisiblenodes"
                hint="Minimum number of visible (non-missing) keypoints an instance must have to be kept."
                valueLabel="Minimum nodes"
                value={v.filterMinVisibleNodes}
                onChange={(val) => onUpdate({ filterMinVisibleNodes: val })}
                defaultValue={1}
                min={0}
              />
              <ToggleNumberField
                label="Min Visible Node Fraction"
                id="field-filterminvisiblenodefraction"
                hint="Minimum fraction of skeleton nodes that must be visible, e.g. 0.5 requires at least half."
                valueLabel="Minimum fraction"
                value={v.filterMinVisibleNodeFraction}
                onChange={(val) => onUpdate({ filterMinVisibleNodeFraction: val })}
                defaultValue={0.5}
                min={0}
                max={1}
                step={0.05}
              />
              <ToggleNumberField
                label="Min Mean Node Score"
                id="field-filterminmeannodescore"
                hint="Minimum mean confidence score across an instance's visible nodes. Instances scoring lower are removed."
                valueLabel="Minimum score"
                value={v.filterMinMeanNodeScore}
                onChange={(val) => onUpdate({ filterMinMeanNodeScore: val })}
                defaultValue={0.3}
                min={0}
                max={1}
                step={0.05}
              />
              <ToggleNumberField
                label="Min Instance Score"
                id="field-filterminstancescore"
                hint="Minimum overall instance confidence score. Instances scoring lower are removed. Meaning differs by pipeline: for Top-Down this is centroid confidence; for Bottom-Up it's derived from PAF grouping quality."
                valueLabel="Minimum score"
                value={v.filterMinInstanceScore}
                onChange={(val) => onUpdate({ filterMinInstanceScore: val })}
                defaultValue={0.3}
                min={0}
                max={1}
                step={0.05}
              />
              <ToggleNumberField
                label="Min Centroid Distance"
                id="field-filtermincentroiddistance"
                hint="Centroid-only de-duplication radius in pixels: drops any predicted centroid within this distance of a higher-scored kept centroid. Use this instead of Filter Overlapping for centroid-only output (single-point pipelines), since bounding-box IoU/OKS are degenerate for single points."
                valueLabel="Distance (px)"
                value={v.filterMinCentroidDistance}
                onChange={(val) => onUpdate({ filterMinCentroidDistance: val })}
                defaultValue={10}
                min={0}
                step={1}
              />
            </div>
          </div>
        </div>

        {/* Footer: reset (left) · Done (right) */}
        <div className="flex items-center justify-between px-6 py-3 border-t shrink-0">
          {onResetDefaults ? (
            <button
              type="button"
              onClick={handleResetDefaults}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to defaults…
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => { onClose(); setSearchQuery(""); }}
            className="px-4 h-8 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
