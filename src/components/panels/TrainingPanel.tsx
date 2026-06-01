/**
 * Training panel for configuring and running sleap-nn model training.
 *
 * Layout (top to bottom):
 *  - Configuration sections (all collapsible)
 *  - Start/Stop/Cancel buttons
 *  - Progress (when running or done)
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { useTrainingStore, getConfigSlots, getSlotLabel } from "@/stores/trainingStore";
import type { ModelType, ConfigFile, ConfigHyperparams } from "@/stores/trainingStore";
import { useConnectStore } from "@/stores/connectStore";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";
import { TrainingConfigDialog } from "@/components/dialogs/TrainingConfigDialog";
import { LossViewerDialog } from "@/components/monitors/LossViewerDialog";
import { slotToHeadType, getDefaultProfileForHead } from "@/lib/trainingProfiles";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/platform/index";
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
} from "lucide-react";

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

function ConfigSlot({
  slot,
  configFile,
  onAdd,
  onRemove,
  disabled,
}: {
  slot: string;
  configFile: ConfigFile | undefined;
  onAdd: (slot: string) => void;
  onRemove: (slot: string) => void;
  disabled: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const { parseYamlConfig, addConfigFile } = useTrainingStore();

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

  if (configFile) {
    return (
      <div className="border border-green-500/50 bg-green-500/5 rounded-md p-2 text-left">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">{configFile.filename}</span>
          <button
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(slot)}
            disabled={disabled}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
          head: {configFile.modelType}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border border-dashed rounded-md p-3 text-center cursor-pointer transition-colors ${
        dragOver
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50"
      }`}
      onClick={() => !disabled && onAdd(slot)}
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
      <div className="text-[11px] text-muted-foreground">
        Drop YAML config here or click to browse
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">
        Accepts .yaml files
      </div>
    </div>
  );
}

// ── Per-config field groups ──────────────────────────────────────────────────

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

      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground shrink-0">Learning Rate</span>
        <Input
          type="number"
          value={hp.learningRate}
          onChange={(e) => onUpdate(slot, { learningRate: Number(e.target.value) })}
          step={0.0001}
          className="h-6 text-[10px] w-20"
          disabled={disabled}
        />
      </div>

      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Rotation</span>
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

    </div>
  );
}


// ── Panel ────────────────────────────────────────────────────────────────────

export function TrainingPanel() {
  const config = useTrainingStore((s) => s.config);
  const status = useTrainingStore((s) => s.status);
  const error = useTrainingStore((s) => s.error);
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
  const { parseYamlConfig: parseConfig, addConfigFile: addConfig } = useTrainingStore();

  // Auto-load baseline configs when model type changes: clear stale configs
  // from the previous model type, then populate defaults for the new one.
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
    for (const slot of newSlots) {
      if (config.configs.some((c) => c.slot === slot)) continue;
      const headType = slotToHeadType(config.modelType, slot);
      const baseline = getDefaultProfileForHead(headType);
      if (baseline) {
        const parsed = parseConfig(baseline.content, baseline.filename, slot);
        if (parsed) addConfig(parsed);
      }
    }
  }, [config.modelType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Config dialog state
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  // Loss viewer modal: which model's curves are open (null = closed).
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // Remote state
  const [remoteEnabled, setRemoteEnabled] = useState(!isTauri);
  const [remoteLabelsPath, setRemoteLabelsPath] = useState("");
  const [remoteValLabelsPath, setRemoteValLabelsPath] = useState("");
  const [inferenceTarget, setInferenceTarget] = useState<string>("suggestions");
  const [sampleCount, setSampleCount] = useState(20);
  const [skipUserLabeled, setSkipUserLabeled] = useState(false);
  const [existingPredictions, setExistingPredictions] = useState<"clear_all" | "replace" | "keep">("replace");
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
  const projectPath = useAppStore((s) => s.projectPath);
  const skeleton = useAppStore((s) => s.skeleton);
  const labels = useAppStore((s) => s.labels);
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
  const hasValidLossWeights = config.configs.every((cf) =>
    cf.hyperparams.confmapsLossWeight > 0 &&
    cf.hyperparams.pafsLossWeight > 0 &&
    cf.hyperparams.classLossWeight > 0
  );
  const isModelTypeIncompatible = skeletonCompat.disabledTypes.has(config.modelType);
  const canStart =
    hasAllConfigs &&
    hasData &&
    hasValidLossWeights &&
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
                  configFile={configFile}
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
              <SelectTrigger className="h-7 text-xs">
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
          ) : config.configs.length === 1 ? (
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
              <pre
                ref={logRef}
                className="max-h-48 overflow-auto rounded border bg-muted p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all"
              >
                {logLines}
              </pre>
            )}

            {/* Error banner */}
            {error && status === "error" && (
              <div className="rounded-md bg-destructive/15 border border-destructive/30 px-2 py-1.5 text-[10px] text-destructive">
                {error}
              </div>
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

      <LossViewerDialog
        open={viewerIndex !== null}
        onOpenChange={(o) => {
          if (!o) setViewerIndex(null);
        }}
        model={viewerIndex !== null ? (models[viewerIndex] ?? null) : null}
        startedAt={startedAt}
        status={status}
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
      />
    </div>
  );
}
