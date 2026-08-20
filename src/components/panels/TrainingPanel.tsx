/**
 * Training panel for configuring and running sleap-nn model training.
 *
 * Layout (top to bottom):
 *  - Configuration sections (all collapsible)
 *  - Start/Stop/Cancel buttons
 *  - Progress (when running or done)
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTrainingStore, getConfigSlots, getSlotLabel, countUserLabeledFrames } from "@/stores/trainingStore";
import type { ModelType, ConfigFile, ConfigHyperparams } from "@/stores/trainingStore";
import { useConnectStore } from "@/stores/connectStore";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";
import { TrainingConfigDialog } from "@/components/dialogs/TrainingConfigDialog";
import { LossViewerDialog } from "@/components/monitors/LossViewerDialog";
import { LogTerminalDialog } from "@/components/monitors/LogTerminalDialog";
import { ErrorOutput } from "@/components/monitors/ErrorOutput";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/platform/index";
import { getBaselineProfilesForHead, slotToHeadType } from "@/lib/trainingProfiles";
import type { DiscoveredModel } from "@/lib/modelDiscovery";
import { Button } from "@/components/ui/button";
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
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Upload,
  X,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  Square,
  Settings2,
  LineChart,
  BarChart3,
  Copy,
  Maximize2,
  Crosshair,
  HelpCircle,
  Eye,
  EyeOff,
} from "lucide-react";
import { computeNodeVisibility, visibilityTier } from "@/lib/anchorVisibility";
import { TUTORIAL_FIRST_TRAINING_STEP_IDS } from "@/lib/tutorial/steps";

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_TYPE_OPTIONS: { value: ModelType; label: string }[] = [
  { value: "single_animal", label: "Single Animal" },
  { value: "top_down", label: "Top-Down" },
  { value: "bottom_up", label: "Bottom-Up" },
  { value: "top_down_id", label: "Top-Down + ID" },
  { value: "bottom_up_id", label: "Bottom-Up + ID" },
];

// ── Skeleton ↔ Pipeline Compatibility & Recommendation ───────────────────────

interface SkeletonCompatibility {
  disabledTypes: Set<ModelType>;
  warnings: Map<ModelType, string>;
}

interface PipelineRecommendation {
  recommended: ModelType;
  reason: string;
  alternatives: ModelType[];
}

const BOTTOM_UP_TYPES: ModelType[] = ["bottom_up", "bottom_up_id"];

async function openExternal(url: string) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
}

function isSkeletonConnected(
  nodes: { name: string }[],
  edges: { source: { name: string }; destination: { name: string } }[],
): boolean {
  if (nodes.length <= 1) return true;
  if (edges.length === 0) return false;
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.name, new Set());
  for (const e of edges) {
    adj.get(e.source.name)?.add(e.destination.name);
    adj.get(e.destination.name)?.add(e.source.name);
  }
  const visited = new Set<string>();
  const queue = [nodes[0].name];
  visited.add(nodes[0].name);
  while (queue.length > 0) {
    const curr = queue.pop()!;
    for (const neighbor of adj.get(curr) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited.size === nodes.length;
}

function getSkeletonCompatibility(
  skeleton: { nodes: { name: string }[]; edges: { source: { name: string }; destination: { name: string } }[] } | null,
): SkeletonCompatibility {
  const disabledTypes = new Set<ModelType>();
  const warnings = new Map<ModelType, string>();

  if (!skeleton) return { disabledTypes, warnings };

  if (skeleton.edges.length === 0) {
    for (const t of BOTTOM_UP_TYPES) disabledTypes.add(t);
  } else if (!isSkeletonConnected(skeleton.nodes, skeleton.edges)) {
    for (const t of BOTTOM_UP_TYPES) {
      warnings.set(t, "Bottom-Up works best with a fully connected skeleton");
    }
  }

  return { disabledTypes, warnings };
}

type LabelsLike = {
  labeledFrames: Array<{
    userInstances: Array<{
      points: Array<{ xy: [number, number]; visible: boolean }>;
    }>;
  }>;
  videos: Array<{ shape: [number, number, number, number] | null }>;
  skeletons: Array<{ edges: { source: { name: string }; destination: { name: string } }[] }>;
  tracks: unknown[];
};

function recommendPipeline(labels: LabelsLike | null): PipelineRecommendation | null {
  if (!labels || labels.labeledFrames.length === 0) return null;

  let maxInstances = 0;
  let bboxSum = 0;
  let bboxCount = 0;
  let maxPointCoord = 0;

  for (const lf of labels.labeledFrames) {
    const userInsts = lf.userInstances;
    if (userInsts.length > maxInstances) maxInstances = userInsts.length;

    for (const inst of userInsts) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let validCount = 0;
      for (const pt of inst.points) {
        if (pt.visible && !Number.isNaN(pt.xy[0]) && !Number.isNaN(pt.xy[1])) {
          if (pt.xy[0] < minX) minX = pt.xy[0];
          if (pt.xy[1] < minY) minY = pt.xy[1];
          if (pt.xy[0] > maxX) maxX = pt.xy[0];
          if (pt.xy[1] > maxY) maxY = pt.xy[1];
          if (pt.xy[0] > maxPointCoord) maxPointCoord = pt.xy[0];
          if (pt.xy[1] > maxPointCoord) maxPointCoord = pt.xy[1];
          validCount++;
        }
      }
      if (validCount >= 2) {
        bboxSum += Math.max(maxX - minX, maxY - minY);
        bboxCount++;
      }
    }
  }

  const avgBbox = bboxCount > 0 ? bboxSum / bboxCount : 0;
  let maxDim = 0;
  for (const v of labels.videos) {
    if (v.shape) {
      const d = Math.max(v.shape[1], v.shape[2]);
      if (d > maxDim) maxDim = d;
    }
  }
  if (maxDim === 0 && maxPointCoord > 0) {
    maxDim = maxPointCoord;
  }

  const ratio = maxDim > 0 ? avgBbox / maxDim : 0;
  const numEdges = labels.skeletons[0]?.edges.length ?? 0;
  const hasTracks = labels.tracks.length > 1;

  if (maxInstances <= 1) {
    return {
      recommended: "single_animal",
      reason: "Only one animal per frame",
      alternatives: ["top_down"],
    };
  }

  if (ratio < 0.20) {
    const alts: ModelType[] = ["bottom_up"];
    if (hasTracks) alts.push("top_down_id");
    return {
      recommended: "top_down",
      reason: `Animals are small (~${Math.round(ratio * 100)}% of frame) — top-down recommended`,
      alternatives: alts,
    };
  }

  if (numEdges === 0) {
    const alts: ModelType[] = [];
    if (hasTracks) alts.push("top_down_id");
    return {
      recommended: "top_down",
      reason: "No skeleton edges — bottom-up requires edges for Part Affinity Fields",
      alternatives: alts,
    };
  }

  const alts: ModelType[] = ["top_down"];
  if (hasTracks) alts.push("bottom_up_id");
  return {
    recommended: "bottom_up",
    reason: `Larger animals (~${Math.round(ratio * 100)}% of frame) — bottom-up handles occlusions well`,
    alternatives: alts,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Reusable widgets ─────────────────────────────────────────────────────────

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        className="flex items-center gap-1 w-full text-left py-1"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        <span className="text-xs font-medium">{title}</span>
      </button>
      {open && <div className="pl-4 space-y-2 pb-1">{children}</div>}
    </div>
  );
}

// ── Config upload slot ───────────────────────────────────────────────────────

/** True if `checkpointPath` lives inside `runPath` (either / or \ separator, and not equal to it). */
function checkpointBelongsToRun(checkpointPath: string, runPath: string): boolean {
  return checkpointPath.startsWith(`${runPath}/`) || checkpointPath.startsWith(`${runPath}\\`);
}

function ConfigSlot({
  slot,
  modelType,
  configFile,
  discoveredModels,
  onAdd,
  onRemove,
  disabled,
}: {
  slot: string;
  modelType: ModelType;
  configFile: ConfigFile | undefined;
  discoveredModels: DiscoveredModel[];
  onAdd: (slot: string) => void;
  onRemove: (slot: string) => void;
  disabled: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const { parseYamlConfig, addConfigFile } = useTrainingStore();

  const headType = slotToHeadType(modelType, slot);
  const baselineProfiles = getBaselineProfilesForHead(headType);
  const forThisHead = discoveredModels.filter((m) => m.headKey === headType);

  // Which dropdown item the current configFile actually corresponds to — a
  // discovered run is identified by its checkpoint living inside that run's
  // directory (every parsed run config shares the same literal filename,
  // "training_config.yaml", so the filename alone can't tell runs apart).
  const matchingRun = configFile?.checkpointPath
    ? forThisHead.find((run) => checkpointBelongsToRun(configFile.checkpointPath!, run.path))
    : undefined;
  const selectValue = !configFile ? "" : matchingRun ? matchingRun.path : configFile.filename;

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".yaml") && !file.name.endsWith(".yml")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parsed = parseYamlConfig(text, file.name, slot);
      if (parsed) {
        addConfigFile(parsed);
      }
    };
    reader.readAsText(file);
  };

  const handleSelectRun = async (run: DiscoveredModel) => {
    try {
      const { join } = await import("@tauri-apps/api/path");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const yamlText = await readTextFile(await join(run.path, "training_config.yaml"));
      const checkpointPath = run.checkpointFile ? await join(run.path, run.checkpointFile) : null;
      const parsed = parseYamlConfig(yamlText, "training_config.yaml", slot, checkpointPath);
      if (parsed) addConfigFile(parsed);
    } catch {
      // Unreadable/missing despite discovery — leave the current config as-is.
    }
  };

  return (
    <div
      className={`rounded-md border p-2 transition-colors ${
        configFile
          ? "border-green-500/50 bg-green-500/5"
          : `border-dashed ${dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
    >
      <div className="flex items-center gap-1">
        <Select
          value={selectValue}
          onValueChange={(v) => {
            if (v === "__browse__") {
              onAdd(slot);
              return;
            }
            const baseline = baselineProfiles.find((p) => p.filename === v);
            if (baseline) {
              const parsed = parseYamlConfig(baseline.content, baseline.filename, slot);
              if (parsed) addConfigFile(parsed);
              return;
            }
            const run = forThisHead.find((m) => m.path === v);
            if (run) handleSelectRun(run);
          }}
          disabled={disabled}
        >
          <SelectTrigger className="h-8 text-xs flex-1 min-w-0">
            <SelectValue placeholder="Select training config file..." />
          </SelectTrigger>
          <SelectContent>
            {baselineProfiles.map((p) => (
              <SelectItem key={p.filename} value={p.filename}>
                {p.label}
              </SelectItem>
            ))}
            {forThisHead.map((run) => (
              <SelectItem key={run.path} value={run.path}>
                [Trained] {run.runName ?? run.path} (training_config.yaml)
              </SelectItem>
            ))}
            {configFile && !matchingRun && !baselineProfiles.some((p) => p.filename === configFile.filename) && (
              <SelectItem value={configFile.filename}>{configFile.filename}</SelectItem>
            )}
            <SelectItem value="__browse__" className="text-primary font-medium">
              Browse for config file...
            </SelectItem>
          </SelectContent>
        </Select>
        {configFile && (
          <button
            className="text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => onRemove(slot)}
            disabled={disabled}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {configFile ? (
        <div className="text-[10px] text-muted-foreground font-mono mt-1">
          head: {configFile.modelType}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground mt-1 text-center">
          or drop a YAML config here
        </div>
      )}
    </div>
  );
}

// ── Per-config field groups ──────────────────────────────────────────────────

/** Tailwind text color per visibility tier, matching this panel's log coloring. */
const VISIBILITY_COLOR: Record<ReturnType<typeof visibilityTier>, string> = {
  high: "text-green-400",
  medium: "text-yellow-400",
  low: "text-destructive",
};

/**
 * Hover-help icon with a floating tooltip, portaled to `document.body`.
 * A plain `title` attribute doesn't reliably render in the Tauri desktop
 * WebView, so this mirrors TrainingConfigDialog's working `HintBubble`
 * instead of relying on the native tooltip.
 */
function HelpTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="cursor-help"
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setPos({ x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => setPos(null)}
    >
      <HelpCircle className="h-3 w-3 text-muted-foreground/50 hover:text-muted-foreground" />
      {pos && createPortal(
        <span
          className="fixed z-[9999] px-2.5 py-1.5 text-[10px] bg-popover border rounded-md shadow-lg w-56 text-foreground leading-relaxed"
          style={{ left: pos.x, top: pos.y - 6, transform: "translate(-50%, -100%)" }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

/**
 * Anchor-part picker, shared across the top-down pipeline's centroid /
 * centered-instance split — it's one concept (where to crop around each
 * animal), not a per-head setting, so it lives above that tab division
 * instead of duplicated inside one head's tab.
 */
function AnchorPartField({
  hp,
  onUpdate,
  disabled,
}: {
  hp: ConfigHyperparams;
  onUpdate: (updates: Partial<ConfigHyperparams>) => void;
  disabled: boolean;
}) {
  const labels = useAppStore((s) => s.labels);
  const skeleton = useAppStore((s) => s.skeleton);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const pickedAnchorNode = useAppStore((s) => s.pickedAnchorNode);
  const [myPickRequestId, setMyPickRequestId] = useState<number | null>(null);
  const [previewOn, setPreviewOn] = useState(false);

  const nodeVisibility = useMemo(
    () => computeNodeVisibility(labels, skeleton),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, skeleton, overlayVersion]
  );
  const hasLabeledData = [...nodeVisibility.values()].some((v) => v.total > 0);

  // Apply a canvas pick once it resolves — but only the one THIS field asked
  // for (myPickRequestId), so a stale/superseded request can't misapply.
  useEffect(() => {
    if (myPickRequestId == null || !pickedAnchorNode) return;
    if (pickedAnchorNode.requestId !== myPickRequestId) return;
    onUpdate({ anchorPart: pickedAnchorNode.nodeName });
    setMyPickRequestId(null);
    useAppStore.getState().clearPickedAnchorNode();
  }, [pickedAnchorNode, myPickRequestId, onUpdate]);

  // Keep the on-canvas crop preview in sync with the current selection while
  // the toggle is on; drop it the moment it's toggled off.
  useEffect(() => {
    if (previewOn) {
      useAppStore.getState().setAnchorPreview(hp.anchorPart);
    } else {
      useAppStore.getState().clearAnchorPreview();
    }
  }, [previewOn, hp.anchorPart]);

  // Safety net: never leave the preview dangling with no way to turn it off
  // if this field disappears entirely (e.g. pipeline switched away from
  // top-down) while the toggle was on.
  useEffect(() => {
    return () => {
      useAppStore.getState().clearAnchorPreview();
    };
  }, []);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground">Anchor Part</span>
        <HelpTooltip text="The % next to each node is how often it's visible across labeled instances in this project — pick one that's reliably visible and central on the animal for the best crop." />
      </div>
      <div className="flex items-center gap-1">
        <Select
          value={hp.anchorPart ?? "__auto__"}
          onValueChange={(v) => onUpdate({ anchorPart: v === "__auto__" ? null : v })}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 text-xs flex-1" data-tutorial="anchor-part-select"><SelectValue placeholder="Auto" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__auto__">Auto (bbox center)</SelectItem>
            {skeleton?.nodes.map((n) => {
              const vis = nodeVisibility.get(n.name);
              return (
                <SelectItem key={n.name} value={n.name}>
                  <span className="flex items-center gap-1.5">
                    {n.name}
                    {vis && vis.total > 0 && (
                      <span className={`text-[10px] ${VISIBILITY_COLOR[visibilityTier(vis.pct)]}`}>
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
          className="shrink-0 h-7 w-7 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:border-border"
          disabled={disabled || !hasLabeledData}
          title={
            hasLabeledData
              ? "Pick anchor from canvas"
              : "No labeled frames in this project yet"
          }
          onClick={() => setMyPickRequestId(useAppStore.getState().startAnchorPick())}
        >
          <Crosshair className="h-3.5 w-3.5" />
        </button>
        <button
          className={`shrink-0 h-7 w-7 flex items-center justify-center rounded border disabled:opacity-40 ${
            previewOn
              ? "border-primary/50 text-primary bg-primary/10"
              : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
          }`}
          disabled={disabled}
          title={previewOn ? "Hide crop preview" : "Preview crop on canvas"}
          onClick={() => setPreviewOn((v) => !v)}
        >
          {previewOn ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function HyperparamsFields({
  slot,
  hp,
  onUpdate,
  disabled,
}: {
  slot: string;
  hp: ConfigHyperparams;
  onUpdate: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground shrink-0">Max Epochs</span>
        <Input
          type="number"
          value={hp.maxEpochs}
          onChange={(e) => onUpdate(slot, { maxEpochs: Number(e.target.value) })}
          min={1}
          className="h-6 text-[10px] w-20"
          disabled={disabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground shrink-0">Batch Size</span>
        <Input
          type="number"
          value={hp.batchSize}
          onChange={(e) => onUpdate(slot, { batchSize: Number(e.target.value) })}
          min={1}
          max={128}
          className="h-6 text-[10px] w-20"
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Rotation Augmentation</span>
          <Select
            value={hp.rotationPreset}
            onValueChange={(v) => onUpdate(slot, { rotationPreset: v as "off" | "15" | "180" | "custom" })}
            disabled={disabled}
          >
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="15">&plusmn;15&deg;</SelectItem>
              <SelectItem value="180">&plusmn;180&deg;</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Scale Augmentation</span>
          <label className="flex items-center gap-1.5 h-7 cursor-pointer">
            <input
              type="checkbox"
              checked={hp.scaleEnabled}
              onChange={(e) => onUpdate(slot, { scaleEnabled: e.target.checked })}
              disabled={disabled}
              className="accent-primary"
            />
            <span className="text-[10px] text-muted-foreground">{hp.scaleEnabled ? "On" : "Off"}</span>
          </label>
        </div>
      </div>

    </div>
  );
}


// ── Panel ────────────────────────────────────────────────────────────────────

export function TrainingPanel() {
  const config = useTrainingStore((s) => s.config);
  const status = useTrainingStore((s) => s.status);
  const error = useTrainingStore((s) => s.error);
  const stderrTail = useTrainingStore((s) => s.stderrTail);
  const startedAt = useTrainingStore((s) => s.startedAt);
  const models = useTrainingStore((s) => s.models);
  const currentModelIndex = useTrainingStore((s) => s.currentModelIndex);
  const wandbUrl = useTrainingStore((s) => s.wandbUrl);
  const modelOutputDirs = useTrainingStore((s) => s.modelOutputDirs);
  const log = useTrainingStore((s) => s.log);
  // Memoize the rendered log lines so we only re-map when `log` actually changes,
  // not on every panel render (the log can update frequently during training).
  const logLines = useMemo(
    () =>
      log.map((line, j) => (
        <div
          key={j}
          className={
            line.includes("*** best ***")
              ? "text-green-400"
              : line.includes("Error") || line.includes("error")
                ? "text-destructive"
                : line.startsWith("—")
                  ? "text-yellow-400"
                  : ""
          }
        >
          {line}
        </div>
      )),
    [log],
  );
  const setConfig = useTrainingStore((s) => s.setConfig);
  const updateConfigHyperparams = useTrainingStore((s) => s.updateConfigHyperparams);
  const removeConfigFile = useTrainingStore((s) => s.removeConfigFile);
  const startTraining = useTrainingStore((s) => s.startTraining);
  const stopTraining = useTrainingStore((s) => s.stopTraining);
  const cancelTraining = useTrainingStore((s) => s.cancelTraining);
  const reset = useTrainingStore((s) => s.reset);
  const resetSeq = useTrainingStore((s) => s.resetSeq);
  const { parseYamlConfig: parseConfig, addConfigFile: addConfig } = useTrainingStore();
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const projectPath = useAppStore((s) => s.projectPath);
  const tutorialActive = useAppStore((s) => s.tutorialActive);
  const tutorialSteps = useAppStore((s) => s.tutorialSteps);
  const tutorialStepIndex = useAppStore((s) => s.tutorialStepIndex);

  // Auto-load a config when a slot has none: prefer the EXACT config from that
  // head's most recently trained run under `{projectDir}/models/` (same
  // discovery — findTrainedModels — InferencePanel uses to auto-pick a model),
  // so "Train Again" resumes from what was actually run last time rather than
  // a generic baseline; falls back to the baseline profile when there's no
  // trained run for that head (fresh project, or browser/no local project dir).
  // EXCEPT during the tutorial's first training pass
  // (`TUTORIAL_FIRST_TRAINING_STEP_IDS`) — that pass is meant to demonstrate
  // the baseline workflow, so it always loads the baseline even if a trained
  // run already exists on disk for this head (e.g. a prior tutorial pass on
  // the same project); the tutorial's later `retrain` step goes through this
  // same effect again (via `resetSeq`) with trained-config preference back on,
  // picking up the run that first pass just produced.
  // Clears stale configs from the previous model type first. Also re-runs on
  // `resetSeq` (bumped by every `reset()`, e.g. "Train Again"): a reset landing
  // back on the SAME model type wouldn't otherwise re-trigger this effect (its
  // other dependency, config.modelType, hasn't changed), so config.configs —
  // wiped to [] by reset() — would stay empty forever.
  const prevModelType = useRef(config.modelType);
  useEffect(() => {
    const newSlots = getConfigSlots(config.modelType);
    if (prevModelType.current !== config.modelType) {
      // Remove configs that don't belong to the new model type's slots
      for (const cf of config.configs) {
        if (!newSlots.includes(cf.slot)) {
          removeConfigFile(cf.slot);
        }
      }
      prevModelType.current = config.modelType;
    }
    const missingSlots = newSlots.filter(
      (slot) => !config.configs.some((c) => c.slot === slot),
    );

    const currentTutorialStepId = tutorialActive
      ? tutorialSteps[tutorialStepIndex]?.id
      : undefined;
    const preferTrained = !(
      currentTutorialStepId && TUTORIAL_FIRST_TRAINING_STEP_IDS.has(currentTutorialStepId)
    );

    let cancelled = false;
    (async () => {
      const { resolveSlotConfigSource } = await import("@/lib/trainedConfigAutoload");
      let discovered: DiscoveredModel[] = [];
      // No trained-model lookup possible without a local project dir (browser
      // mode / no project yet) — `discovered` stays empty and every slot below
      // just falls back to its baseline, same as before this feature existed.
      let fsAccess: import("@/lib/trainedConfigAutoload").TrainedConfigFsAccess = {
        readTextFile: async () => {
          throw new Error("no local project — trained-config lookup unavailable");
        },
        join: async () => {
          throw new Error("no local project — trained-config lookup unavailable");
        },
      };
      if (preferTrained && isTauri && projectPath) {
        try {
          const [{ findTrainedModels }, { dirname, join }, { readTextFile }] =
            await Promise.all([
              import("@/lib/modelDiscovery"),
              import("@tauri-apps/api/path"),
              import("@tauri-apps/plugin-fs"),
            ]);
          const projectDir = await dirname(projectPath);
          discovered = await findTrainedModels(projectDir);
          fsAccess = { readTextFile, join };
        } catch {
          discovered = [];
        }
      }
      if (cancelled) return;
      // Kept in state (not just this closure) so the per-slot config
      // dropdown can list every discovered run for a head, not just
      // whichever one this effect happened to auto-load.
      setDiscoveredModels(discovered);

      if (missingSlots.length === 0) return;

      for (const slot of missingSlots) {
        const source = await resolveSlotConfigSource(
          slot,
          config.modelType,
          discovered,
          fsAccess,
          { preferTrained },
        );
        if (cancelled) return;
        if (source) {
          const parsed = parseConfig(source.yamlText, source.filename, slot, source.checkpointPath);
          if (parsed) addConfig(parsed);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.modelType, resetSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Config dialog state
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  // Loss viewer modal: which model's curves are open (null = closed).
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [logDialogOpen, setLogDialogOpen] = useState(false);

  // Remote state
  const [remoteEnabled, setRemoteEnabled] = useState(!isTauri);
  const [remoteLabelsPath, setRemoteLabelsPath] = useState("");
  const [remoteValLabelsPath, setRemoteValLabelsPath] = useState("");
  const [inferenceTarget, setInferenceTarget] = useState<string>("suggestions");
  const [sampleCount, setSampleCount] = useState(20);
  const [skipUserLabeled, setSkipUserLabeled] = useState(false);
  const [existingPredictions, setExistingPredictions] = useState<"clear_all" | "replace" | "keep">("replace");
  // Client-side only — no sleap-nn schema field for this (see trainingStore.ts).
  const [autoOpenWandb, setAutoOpenWandb] = useState(false);
  // Auto-open the W&B run page once its URL becomes available, if requested.
  const openedWandbUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wandbUrl || !autoOpenWandb) return;
    if (openedWandbUrlRef.current === wandbUrl) return;
    openedWandbUrlRef.current = wandbUrl;
    void openExternal(wandbUrl);
  }, [wandbUrl, autoOpenWandb]);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserCallback, setFileBrowserCallback] = useState<
    ((path: string) => void) | null
  >(null);

  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const workers = useConnectStore((s) => s.workers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const selectWorker = useConnectStore((s) => s.selectWorker);

  const selectedWorker = workers.find((w) => w.peerId === selectedWorkerId);
  const workerMounts = selectedWorker?.mounts || ["/"];

  // App state
  const skeleton = useAppStore((s) => s.skeleton);
  const labels = useAppStore((s) => s.labels);
  const setModelMetricsDialogOpen = useAppStore(
    (s) => s.setModelMetricsDialogOpen
  );
  const skeletonCompat = useMemo(() => getSkeletonCompatibility(skeleton), [skeleton]);
  const pipelineRec = useMemo(() => recommendPipeline(labels as LabelsLike | null), [labels]);

  // Elapsed time ticker
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "running" || !startedAt) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  // Auto-scroll log
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.length]);

  const isRunning = status === "running";
  const isDone =
    status === "completed" || status === "error" || status === "stopped";

  // Can start?
  const requiredSlots = getConfigSlots(config.modelType);
  const hasAllConfigs = requiredSlots.every((slot) =>
    config.configs.some((c) => c.slot === slot),
  );
  const hasData = remoteEnabled
    ? !!remoteLabelsPath
    : !!config.trainingLabelsPath || !!projectPath;
  // Remote training points at a path on the worker's filesystem, which this
  // client can't read to count frames — only guard the local-project path,
  // where an empty project would otherwise start a doomed training run.
  const hasLabeledFrames = remoteEnabled
    ? true
    : (countUserLabeledFrames(labels) ?? 0) > 0;
  const hasValidLossWeights = config.configs.every((cf) =>
    cf.hyperparams.confmapsLossWeight > 0 &&
    cf.hyperparams.pafsLossWeight > 0 &&
    cf.hyperparams.classLossWeight > 0
  );
  // Resume needs a real .ckpt (it's a full Lightning-state restore); Fine-tune
  // accepts .ckpt or legacy SLEAP .h5 backbone/head weights — see
  // model_config.pretrained_*_weights vs trainer_config.resume_ckpt_path in
  // sleap-nn's lightning_modules.py / trainer_config.py.
  const hasValidCheckpointSelection = config.configs.every((cf) => {
    const mode = cf.hyperparams.trainingMode;
    if (mode === "reuse_config") return true;
    if (!cf.checkpointPath?.trim()) return false;
    if (mode === "resume") return cf.checkpointPath.toLowerCase().endsWith(".ckpt");
    return true;
  });
  const isModelTypeIncompatible = skeletonCompat.disabledTypes.has(config.modelType);
  const canStart =
    hasAllConfigs &&
    hasData &&
    hasLabeledFrames &&
    hasValidLossWeights &&
    hasValidCheckpointSelection &&
    !isModelTypeIncompatible &&
    status === "idle" &&
    (remoteEnabled ? !!selectedWorkerId : true);

  // Config upload via file dialog
  const handleConfigBrowse = (slot: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".yaml,.yml";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result as string;
          const { parseYamlConfig, addConfigFile } =
            useTrainingStore.getState();
          const parsed = parseYamlConfig(text, file.name, slot);
          if (parsed) {
            addConfigFile(parsed);
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  // Local data path browse
  const handleBrowseLocalData = async (
    setter: (path: string) => void,
    configKey: "trainingLabelsPath" | "validationLabelsPath",
  ) => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await tauriOpen({
        title: "Select Labels File",
        filters: [{ name: "SLP Files", extensions: ["slp"] }],
      });
      if (selected) {
        setter(selected as string);
        setConfig(configKey, selected as string);
      }
    } catch {
      /* cancelled */
    }
  };

  const handleStart = async () => {
    if (remoteEnabled) {
      await startTraining({
        remote: true,
        workerId: selectedWorkerId!,
        labelsPath: remoteLabelsPath,
        valLabelsPath: remoteValLabelsPath || undefined,
        inferenceTarget,
      });
    } else {
      await startTraining({
        inferenceTarget,
        sampleCount,
        skipUserLabeled,
        existingPredictions,
      });
    }
  };

  if (!isTauri && connectionStatus !== "connected") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <p className="text-xs text-muted-foreground">
          Connect to a worker in the Connect tab to start remote training.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 -m-2">
      {/* ── Configuration ──────────────────────────────────────────── */}
      <div className="px-3 py-2 space-y-1">
        {/* ── Model Type & Configs ─────────────────────────────────── */}
        <Section title="Model Type & Configs" defaultOpen={true}>
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">
              Model Type
            </span>
            <Select
              value={config.modelType}
              onValueChange={(v) => setConfig("modelType", v as ModelType)}
              disabled={isRunning}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_TYPE_OPTIONS.map((o) => {
                  const isDisabled = skeletonCompat.disabledTypes.has(o.value);
                  const isRecommended = pipelineRec?.recommended === o.value;
                  return (
                    <SelectItem key={o.value} value={o.value} disabled={isDisabled}>
                      {o.label}{isDisabled ? " (requires edges)" : ""}
                      {isRecommended && !isDisabled ? " ★" : ""}
                      {skeletonCompat.warnings.has(o.value) ? " ⚠" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {pipelineRec && config.modelType !== pipelineRec.recommended && !skeletonCompat.disabledTypes.has(config.modelType) && (
              <p className="text-[10px] text-green-400">
                💡 Recommended: {MODEL_TYPE_OPTIONS.find((o) => o.value === pipelineRec.recommended)?.label} — {pipelineRec.reason}
              </p>
            )}
            {skeletonCompat.warnings.has(config.modelType) && (
              <p className="text-[10px] text-yellow-400">⚠ {skeletonCompat.warnings.get(config.modelType)}</p>
            )}
            {isModelTypeIncompatible && (
              <p className="text-[10px] text-red-400">Selected model type is incompatible with the current skeleton</p>
            )}
          </div>

          {requiredSlots.map((slot) => {
            const configFile = config.configs.find((c) => c.slot === slot);
            return (
              <div key={slot} className="space-y-1">
                <span className="text-[10px] text-muted-foreground">
                  {getSlotLabel(slot)}
                </span>
                <ConfigSlot
                  slot={slot}
                  modelType={config.modelType}
                  configFile={configFile}
                  discoveredModels={discoveredModels}
                  onAdd={handleConfigBrowse}
                  onRemove={removeConfigFile}
                  disabled={isRunning}
                />
              </div>
            );
          })}

          {hasAllConfigs && config.configs.length > 0 && (
            <div className="bg-green-500/8 border border-green-500/20 rounded-md p-2 text-[11px] text-green-400">
              Auto-filled from config files. All fields are editable.
            </div>
          )}
        </Section>

        <Separator />

        {/* ── Data ─────────────────────────────────────────────────── */}
        <Section title="Data" defaultOpen={true}>
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">
              {remoteEnabled
                ? "Training Labels (on worker)"
                : "Training Labels"}
            </span>
            <div className="flex gap-1">
              <Input
                value={
                  remoteEnabled
                    ? remoteLabelsPath
                    : config.trainingLabelsPath || projectPath || ""
                }
                readOnly
                className="h-7 text-xs font-mono flex-1"
                placeholder="No file selected"
              />
              <Button
                variant="outline"
                size="xs"
                className="px-2"
                disabled={isRunning}
                onClick={() => {
                  if (remoteEnabled) {
                    setFileBrowserCallback(
                      () => (path: string) => setRemoteLabelsPath(path),
                    );
                    setFileBrowserOpen(true);
                  } else {
                    handleBrowseLocalData(
                      (p) => setConfig("trainingLabelsPath", p),
                      "trainingLabelsPath",
                    );
                  }
                }}
              >
                <Folder className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">
              Validation Labels (optional)
            </span>
            <div className="flex gap-1">
              <Input
                value={
                  remoteEnabled
                    ? remoteValLabelsPath
                    : config.validationLabelsPath
                }
                readOnly
                className="h-7 text-xs font-mono flex-1"
                placeholder="Same as training (auto-split)"
              />
              <Button
                variant="outline"
                size="xs"
                className="px-2"
                disabled={isRunning}
                onClick={() => {
                  if (remoteEnabled) {
                    setFileBrowserCallback(
                      () => (path: string) => setRemoteValLabelsPath(path),
                    );
                    setFileBrowserOpen(true);
                  } else {
                    handleBrowseLocalData(
                      (p) => setConfig("validationLabelsPath", p),
                      "validationLabelsPath",
                    );
                  }
                }}
              >
                <Folder className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">
              Post-Training Inference Target
            </span>
            <Select
              value={inferenceTarget}
              onValueChange={(v) => setInferenceTarget(v)}
              disabled={isRunning}
            >
              <SelectTrigger
                className="h-7 text-xs"
                data-tutorial="post-training-inference-target-select"
              >
                <SelectValue />
              </SelectTrigger>
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
            {(inferenceTarget === "random_video" || inferenceTarget === "random") && (
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="text-[10px] text-muted-foreground shrink-0">Sample count</span>
                <Input type="number" min={1} value={sampleCount}
                  onChange={(e) => setSampleCount(Math.max(1, Number(e.target.value)))}
                  className="h-6 text-[10px] w-20" disabled={isRunning} />
              </div>
            )}
          </div>
        </Section>

        <Separator />

        {/* ── Hyperparameters (per-config tabs) ─────────────────── */}
        <Section title="Hyperparameters" defaultOpen={true}>
          {config.configs.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              Upload config file(s) above to see hyperparameters.
            </p>
          ) : (
            <>
              {/* Shared across the centroid/centered-instance split — it's one
                  concept (where to crop), so it lives above that division. */}
              {(() => {
                const ciConfig = config.configs.find((cf) => cf.slot === "centered_instance");
                if (!ciConfig) return null;
                return (
                  <>
                    <AnchorPartField
                      hp={ciConfig.hyperparams}
                      onUpdate={(updates) => updateConfigHyperparams("centered_instance", updates)}
                      disabled={isRunning}
                    />
                    <Separator className="my-2" />
                  </>
                );
              })()}
              {config.configs.length === 1 ? (
                <HyperparamsFields
                  slot={config.configs[0].slot}
                  hp={config.configs[0].hyperparams}
                  onUpdate={updateConfigHyperparams}
                  disabled={isRunning}
                />
              ) : (
                <Tabs defaultValue={config.configs[0]?.slot}>
                  <TabsList className="w-full h-7">
                    {config.configs.map((cf) => (
                      <TabsTrigger key={cf.slot} value={cf.slot} className="flex-1 text-[10px] h-6">
                        {getSlotLabel(cf.slot).replace(" Config", "")}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {config.configs.map((cf) => (
                    <TabsContent key={cf.slot} value={cf.slot} className="mt-2">
                      <HyperparamsFields
                        slot={cf.slot}
                        hp={cf.hyperparams}
                        onUpdate={updateConfigHyperparams}
                        disabled={isRunning}
                      />
                    </TabsContent>
                  ))}
                </Tabs>
              )}
            </>
          )}
        </Section>

        {isTauri && (
          <>
            <Separator />

            {/* ── Remote (desktop only — web is always remote) ──────── */}
            <Section title="Remote" defaultOpen={false}>
              <div className="flex items-center justify-between py-1">
                <span className="text-xs">Remote Training</span>
                <button
                  className={`w-9 h-5 rounded-full relative transition-colors ${
                    remoteEnabled ? "bg-primary" : "bg-zinc-700"
                  }`}
                  onClick={() => setRemoteEnabled(!remoteEnabled)}
                  disabled={connectionStatus !== "connected"}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      remoteEnabled ? "translate-x-4" : ""
                    }`}
                  />
                </button>
              </div>

              {connectionStatus !== "connected" && !remoteEnabled && (
                <p className="text-[10px] text-muted-foreground">
                  Connect to a room in the Connect tab to enable remote training.
                </p>
              )}

              {remoteEnabled && connectionStatus === "connected" && (
                <>
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Room
                    </label>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      {(() => {
                        const state = useConnectStore.getState();
                        const room = state.availableRooms.find(
                          (r) => r.roomId === state.roomId,
                        );
                        return room?.name || state.roomId;
                      })()}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Worker
                    </label>
                    <Select
                      value={selectedWorkerId || ""}
                      onValueChange={(v) => selectWorker(v)}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue placeholder="Select a worker" />
                      </SelectTrigger>
                      <SelectContent>
                        {workers.map((w) => (
                          <SelectItem
                            key={w.peerId}
                            value={w.peerId}
                            disabled={w.status !== "available"}
                          >
                            {w.name}
                            {w.gpu ? ` (${w.gpu.model})` : ""}
                            {w.status !== "available" ? ` — ${w.status}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {workers.filter((w) => w.status === "available").length === 0 && (
                    <div className="bg-orange-500/8 border border-orange-500/20 rounded-md p-2 text-[11px] text-orange-400">
                      <b>All workers are busy.</b> Wait for a worker to become
                      available, or disable remote training.
                    </div>
                  )}
                </>
              )}
            </Section>
          </>
        )}

        <Separator />

        {/* ── W&B link (shown as soon as available) ─────────────── */}
        {wandbUrl && (
          <a
            href={wandbUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] text-blue-400 hover:underline bg-blue-500/8 border border-blue-500/20 rounded-md px-2 py-1.5"
          >
            <ExternalLink className="h-3 w-3" />
            View on Weights & Biases
          </a>
        )}

        {/* ── Action buttons ──────────────────────────────────────── */}
        {config.configs.length > 0 && (
          <Button
            variant="outline"
            className="w-full h-8 text-xs border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
            onClick={() => setConfigDialogOpen(true)}
            disabled={isRunning}
          >
            <Settings2 className="h-3 w-3 mr-1.5" />
            Full Configuration...
          </Button>
        )}
        {status === "idle" && (
          <>
            <Button
              className="w-full h-8 text-xs"
              onClick={handleStart}
              disabled={!canStart}
              data-tutorial="start-training-button"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              {remoteEnabled ? "Start Remote Training" : "Start Training"}
            </Button>
            {!canStart && (
              <p className="text-[10px] text-muted-foreground text-center mt-1">
                {!hasAllConfigs
                  ? "Upload config file(s) to begin"
                  : !hasData
                    ? "Select training data"
                    : !hasLabeledFrames
                      ? "Label at least one frame before training"
                      : !hasValidCheckpointSelection
                        ? "Select a checkpoint file for Resume/Fine-tune"
                        : remoteEnabled && !selectedWorkerId
                          ? "Select a worker"
                          : ""}
              </p>
            )}
          </>
        )}

        {isRunning && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 h-8 text-xs border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10"
              onClick={() => stopTraining()}
            >
              <Square className="h-3 w-3 mr-1" />
              Stop Early
            </Button>
            <Button
              variant="destructive"
              className="flex-1 h-8 text-xs"
              onClick={() => cancelTraining()}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Cancel
            </Button>
          </div>
        )}

        {isRunning && (
          <p className="text-[9px] text-muted-foreground text-center">
            Stop Early saves a checkpoint. Cancel terminates immediately.
          </p>
        )}

        {status === "completed" && modelOutputDirs.length > 0 && (
          <div className="bg-green-500/8 border border-green-500/20 rounded-md p-2 text-[11px] text-green-400 space-y-1">
            <div className="font-medium">Trained model{modelOutputDirs.length > 1 ? "s" : ""}:</div>
            {modelOutputDirs.map((dir, i) => (
              <div key={i} className="font-mono text-[10px] text-green-300 break-all">{dir}</div>
            ))}
          </div>
        )}
        {status === "completed" && (
          <Button
            variant="outline"
            className="w-full h-8 text-xs"
            onClick={() => setModelMetricsDialogOpen(true)}
          >
            <BarChart3 className="h-3.5 w-3.5 mr-1" />
            View Metrics
          </Button>
        )}
        {status === "completed" && (
          <Button className="w-full h-8 text-xs" onClick={() => reset()}>
            Train Again
          </Button>
        )}

        {(status === "error" || status === "stopped") && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 h-8 text-xs"
              onClick={() => {
                const savedConfig = { ...config };
                reset();
                // Restore config for retry
                Object.entries(savedConfig).forEach(([key, value]) => {
                  setConfig(
                    key as keyof typeof savedConfig,
                    value as never,
                  );
                });
              }}
            >
              Retry
            </Button>
            <Button className="flex-1 h-8 text-xs" onClick={() => reset()}>
              New Training
            </Button>
          </div>
        )}
      </div>

      {/* ── Progress ──────────────────────────────────────────────── */}
      {(isRunning || isDone) && models.length > 0 && (
        <>
          <Separator />
          <div className="px-3 py-2 space-y-2">
            {/* Status header */}
            <div className="flex items-center gap-2">
              {isRunning && (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs font-medium">Training...</span>
                </>
              )}
              {status === "completed" && (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-xs font-medium">Complete</span>
                </>
              )}
              {status === "error" && (
                <>
                  <XCircle className="h-4 w-4 text-destructive" />
                  <span className="text-xs font-medium">Failed</span>
                </>
              )}
              {status === "stopped" && (
                <>
                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                  <span className="text-xs font-medium">Stopped</span>
                </>
              )}
              {startedAt && (
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {formatDuration(isDone ? elapsed : Date.now() - startedAt)}
                </span>
              )}
            </div>

            {/* Completion banner */}
            {status === "completed" && (
              <div className="bg-green-500/8 border border-green-500/20 rounded-md p-2 text-[11px] text-green-400">
                <b>Training complete!</b>{" "}
                {models.length > 1
                  ? `All ${models.length} models trained successfully.`
                  : "Model trained successfully."}
              </div>
            )}

            {/* Per-model progress */}
            {models.map((model, i) => {
              const pct =
                model.maxEpochs > 0
                  ? (model.epoch / model.maxEpochs) * 100
                  : 0;
              const isCompleted = model.status === "completed";
              const isFailed = model.status === "failed";
              const isCurrent = i === currentModelIndex && isRunning;

              return (
                <div
                  key={i}
                  className={isCompleted && !isDone ? "opacity-70" : ""}
                >
                  {(() => {
                    const hasChart = isCurrent || isCompleted || isFailed;
                    return (
                      <div
                        role={hasChart ? "button" : undefined}
                        tabIndex={hasChart ? 0 : undefined}
                        onClick={() => {
                          if (hasChart) setViewerIndex(i);
                        }}
                        onKeyDown={(e) => {
                          if (hasChart && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            setViewerIndex(i);
                          }
                        }}
                        className={`text-[11px] font-medium flex items-center gap-1.5 mb-1 ${
                          isFailed
                            ? "text-destructive"
                            : isCompleted
                              ? "text-green-500"
                              : "text-primary"
                        } ${hasChart ? "cursor-pointer hover:underline" : ""}`}
                      >
                        {isCompleted && (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        {isFailed && <XCircle className="h-3 w-3" />}
                        {isCurrent && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        {model.status === "pending" && (
                          <span className="w-3 h-3 rounded-full border border-muted-foreground/30" />
                        )}
                        {isCurrent
                          ? `Training: ${model.label} (${i + 1}/${models.length})`
                          : isCompleted
                            ? `${model.label} — ${model.epochSamples.length} epochs${
                                model.bestValLoss != null
                                  ? `, best val_loss: ${model.bestValLoss.toFixed(4)}`
                                  : ""
                              }`
                            : isFailed
                              ? `${model.label} — failed at epoch ${model.epoch}`
                              : `${model.label} (pending)`}
                        {hasChart && (
                          <LineChart className="h-3 w-3 ml-auto opacity-60" />
                        )}
                      </div>
                    );
                  })()}

                  {/* Progress bar */}
                  <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden mb-1">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isFailed
                          ? "bg-destructive"
                          : isCompleted
                            ? "bg-green-500"
                            : "bg-primary"
                      }`}
                      style={{
                        width: `${Math.max(0, Math.min(100, pct))}%`,
                      }}
                    />
                  </div>

                  {/* Stats */}
                  {(isCurrent || isCompleted || isFailed) && (
                    <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                      <span>
                        {model.epoch} / {model.maxEpochs} epochs
                      </span>
                      {model.loss != null && (
                        <span>loss: {model.loss.toFixed(4)}</span>
                      )}
                    </div>
                  )}

                </div>
              );
            })}

            {/* Single shared log terminal */}
            {log.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Log</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => setLogDialogOpen(true)}
                    >
                      <Maximize2 className="h-3 w-3 mr-1" /> Expand
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => navigator.clipboard.writeText(log.join("\n"))}
                    >
                      <Copy className="h-3 w-3 mr-1" /> Copy
                    </Button>
                  </div>
                </div>
                <pre
                  ref={logRef}
                  onClick={() => setLogDialogOpen(true)}
                  title="Click to open the full log"
                  className="max-h-48 overflow-auto rounded border bg-muted p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all cursor-pointer hover:border-muted-foreground/50"
                >
                  {logLines}
                </pre>
              </div>
            )}

            {/* Error banner + forwarded sleap-nn error output */}
            {error && status === "error" && (
              <div className="rounded-md bg-destructive/15 border border-destructive/30 px-2 py-1.5 text-[10px] text-destructive">
                {error}
              </div>
            )}
            {status === "error" && stderrTail.length > 0 && (
              <ErrorOutput lines={stderrTail} title="Error output (sleap-nn)" />
            )}

            {/* Next step hint */}
            {status === "completed" && (
              <div className="bg-blue-500/8 border border-blue-500/20 rounded-md p-2 text-[11px] text-blue-400">
                <b>Next step:</b> Use these models in the Inference tab to run
                predictions on your data.
              </div>
            )}
          </div>
        </>
      )}

      <LogTerminalDialog
        open={logDialogOpen}
        onOpenChange={setLogDialogOpen}
        log={log}
        title="Training log"
      />

      <LossViewerDialog
        open={viewerIndex !== null}
        onOpenChange={(o) => {
          if (!o) setViewerIndex(null);
        }}
        model={viewerIndex !== null ? (models[viewerIndex] ?? null) : null}
        startedAt={startedAt}
        status={status}
        errorLines={stderrTail}
        isActive={
          viewerIndex !== null &&
          viewerIndex === currentModelIndex &&
          isRunning
        }
        onStopEarly={() => stopTraining()}
        onCancel={() => cancelTraining()}
      />

      <RemoteFileBrowser
        open={fileBrowserOpen}
        onClose={() => setFileBrowserOpen(false)}
        onSelect={(path) => {
          if (fileBrowserCallback) fileBrowserCallback(path);
          setFileBrowserOpen(false);
        }}
        mounts={workerMounts}
        mode="file"
        fileFilter=".slp"
      />

      <TrainingConfigDialog
        open={configDialogOpen}
        onClose={() => setConfigDialogOpen(false)}
        modelType={config.modelType}
        configs={config.configs}
        onUpdateSlot={updateConfigHyperparams}
        inferenceTarget={inferenceTarget}
        onInferenceTargetChange={setInferenceTarget}
        remoteEnabled={remoteEnabled}
        onRemoteEnabledChange={setRemoteEnabled}
        skeletonNodes={(() => {
          const skeleton = useAppStore.getState().skeleton;
          return skeleton?.nodes?.map((n) => n.name) ?? [];
        })()}
        sampleCount={sampleCount}
        onSampleCountChange={setSampleCount}
        skipUserLabeled={skipUserLabeled}
        onSkipUserLabeledChange={setSkipUserLabeled}
        existingPredictions={existingPredictions}
        onExistingPredictionsChange={setExistingPredictions}
        autoOpenWandb={autoOpenWandb}
        onAutoOpenWandbChange={setAutoOpenWandb}
      />
    </div>
  );
}
