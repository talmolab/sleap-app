/**
 * Inference panel for configuring and running sleap-nn predictions.
 *
 * Layout (top to bottom):
 *  - Configuration sections (all collapsible)
 *  - Run button
 *  - Progress / log (when running or done, at bottom)
 */

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useEnvironmentStore } from "../../stores/environmentStore";
import { useInferenceStore } from "../../stores/inferenceStore";
import type { InferenceConfig, PipelineType } from "@/stores/inferenceStore";
import { useConnectStore } from "@/stores/connectStore";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";
import { isTauri } from "../../platform/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { HintBubble } from "@/components/HintBubble";
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
  FolderOpen,
  Folder,
  Play,
  X,
  Download,
  ChevronDown,
  ChevronRight,
  Copy,
  Settings2,
  Maximize2,
} from "lucide-react";
import { InferenceConfigDialog } from "@/components/dialogs/InferenceConfigDialog";
import { LogTerminalDialog } from "@/components/monitors/LogTerminalDialog";

// ── Types & Constants ─────────────────────────────────────────────────────────

type FrameRange = "all_videos" | "video" | "suggestions" | "user_labeled" | "predicted" | "random_video" | "random" | "frame" | "custom";

const PIPELINE_OPTIONS: { value: PipelineType; label: string; desc: string }[] =
  [
    { value: "top-down", label: "Top-Down", desc: "Two models: centroid + centered instance." },
    { value: "bottom-up", label: "Bottom-Up", desc: "Single model with confidence maps + PAFs." },
    { value: "single-animal", label: "Single Animal", desc: "Single confidence map model." },
    { value: "top-down-id", label: "Top-Down + ID", desc: "Top-down with identity classification." },
    { value: "bottom-up-id", label: "Bottom-Up + ID", desc: "Bottom-up with identity classification." },
  ];

const DEVICE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "cuda", label: "CUDA (GPU)" },
  { value: "cpu", label: "CPU" },
  { value: "mps", label: "MPS (Apple Silicon)" },
];


/**
 * Extensions sleap-nn inference accepts as a data_path input:
 *   - .slp: labeled project (inference writes predictions back into it)
 *   - .mp4 / .avi / .mov / .mkv: raw video files (inference produces a sibling .predictions.slp)
 * Matches the video format set used in src/lib/resolveVideos.ts.
 */
const INFERENCE_DATA_EXTENSIONS = [".slp", ".mp4", ".avi", ".mov", ".mkv"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Reusable widgets ──────────────────────────────────────────────────────────

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

/** Label + optional hint bubble, shared by the compact field rows below. */
function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
      {label}
      {hint && <HintBubble text={hint} className="h-3 w-3" />}
    </span>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="rounded border-border"
      />
      {label}
      {hint && <HintBubble text={hint} className="h-3 w-3" />}
    </label>
  );
}

function NumField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <FieldLabel label={label} hint={hint} />
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="h-6 text-[10px] w-20"
        disabled={disabled}
      />
    </div>
  );
}

function NullableNumField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  placeholder = "Off",
  disabled,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <FieldLabel label={label} hint={hint} />
      <Input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        className="h-6 text-[10px] w-20"
        disabled={disabled}
      />
    </div>
  );
}

function NodeCheckboxList({
  nodes,
  selected,
  onChange,
  disabled,
}: {
  nodes: string[];
  selected: number[];
  onChange: (indices: number[]) => void;
  disabled?: boolean;
}) {
  if (nodes.length === 0) {
    return <p className="text-[10px] text-muted-foreground">No skeleton loaded — all nodes used.</p>;
  }
  const toggle = (i: number) => {
    onChange(
      selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i].sort((a, b) => a - b)
    );
  };
  return (
    <div className="border rounded max-h-28 overflow-y-auto p-1 space-y-0.5">
      {nodes.map((name, i) => (
        <label key={i} className="flex items-center gap-1.5 text-[10px] px-1 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.includes(i)}
            onChange={() => toggle(i)}
            disabled={disabled}
            className="rounded border-border"
          />
          {name}
        </label>
      ))}
    </div>
  );
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: Omit<InferenceConfig, "modelPaths" | "videoIndex" | "frameRange"> = {
  pipeline: "top-down",
  sampleCount: 20,
  excludeUserLabeled: false,
  batchSize: 4,
  device: "auto",
  maxInstances: null,
  peakThreshold: 0.2,
  integralRefinement: true,
  integralPatchSize: 5,
  nPoints: 10,
  maxEdgeLengthRatio: 0.25,
  distPenaltyWeight: 1.0,
  minLineScores: 0.25,
  tracking: false,
  trackerMethod: "simple",
  similarityMethod: "oks",
  matchingMethod: "hungarian",
  trackingWindowSize: 5,
  maxTracks: null,
  connectSingleBreaks: false,
  robust: 0.95,
  minMatchPoints: 0,
  minNewTrackPoints: 0,
  scoringReduction: "mean",
  trackingTargetInstanceCount: null,
  trackingPreCullToTarget: false,
  trackingPreCullIouThreshold: 0,
  trackingCleanInstanceCount: null,
  trackingCleanIouThreshold: 0,
  flowImgScale: 1.0,
  flowWindowSize: 21,
  flowMaxLevels: 3,
  kfTrackFeatures: "centroid",
  kfInitFrameCount: 10,
  kfNodeIndices: [],
  kfResetGapSize: 5,
  ensureChannels: "auto",
  filterOverlapping: false,
  filterMethod: "iou",
  filterThreshold: 0.8,
  filterMinVisibleNodes: null,
  filterMinVisibleNodeFraction: null,
  filterMinMeanNodeScore: null,
  filterMinInstanceScore: null,
  filterMinCentroidDistance: null,
};

// ── Panel ─────────────────────────────────────────────────────────────────────

export function InferencePanel() {
  const video = useAppStore((s) => s.video);
  const projectPath = useAppStore((s) => s.projectPath);
  const skeleton = useAppStore((s) => s.skeleton);
  const skeletonNodeNames = skeleton?.nodes?.map((n) => n.name) ?? [];
  const tools = useEnvironmentStore((s) => s.tools);
  const detectionStatus = useEnvironmentStore((s) => s.detectionStatus);
  const refresh = useEnvironmentStore((s) => s.refresh);

  useEffect(() => {
    if (isTauri && detectionStatus === "idle") refresh();
  }, [refresh, detectionStatus]);

  const inferenceStatus = useInferenceStore((s) => s.status);
  const progress = useInferenceStore((s) => s.progress);
  const log = useInferenceStore((s) => s.log);
  const error = useInferenceStore((s) => s.error);
  const outputPath = useInferenceStore((s) => s.outputPath);
  const startedAt = useInferenceStore((s) => s.startedAt);
  const startInference = useInferenceStore((s) => s.startInference);
  const cancelInference = useInferenceStore((s) => s.cancelInference);
  const loadAndMergeResults = useInferenceStore((s) => s.loadAndMergeResults);
  const reset = useInferenceStore((s) => s.reset);

  // Config state
  const [pipeline, setPipeline] = useState<PipelineType>(DEFAULTS.pipeline);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [modelPaths, setModelPaths] = useState<string[]>([]);
  const [frameRange, setFrameRange] = useState<FrameRange>("suggestions");
  const [frameStart, setFrameStart] = useState("0");
  const [frameEnd, setFrameEnd] = useState("1000");
  const [sampleCount, setSampleCount] = useState(20);
  const [excludeUserLabeled, setExcludeUserLabeled] = useState(DEFAULTS.excludeUserLabeled);
  const [batchSize, setBatchSize] = useState(DEFAULTS.batchSize);
  const [device, setDevice] = useState(DEFAULTS.device);
  const [maxInstances, setMaxInstances] = useState<number | null>(DEFAULTS.maxInstances);
  const [noMaxInstances, setNoMaxInstances] = useState(true);
  const [peakThreshold, setPeakThreshold] = useState(DEFAULTS.peakThreshold);
  const [integralRefinement, setIntegralRefinement] = useState(DEFAULTS.integralRefinement);
  const [integralPatchSize, setIntegralPatchSize] = useState(DEFAULTS.integralPatchSize);
  const [nPoints, setNPoints] = useState(DEFAULTS.nPoints);
  const [maxEdgeLengthRatio, setMaxEdgeLengthRatio] = useState(DEFAULTS.maxEdgeLengthRatio);
  const [distPenaltyWeight, setDistPenaltyWeight] = useState(DEFAULTS.distPenaltyWeight);
  const [minLineScores, setMinLineScores] = useState(DEFAULTS.minLineScores);
  const [tracking, setTracking] = useState(DEFAULTS.tracking);
  const [trackerMethod, setTrackerMethod] = useState(DEFAULTS.trackerMethod);
  const [similarityMethod, setSimilarityMethod] = useState(DEFAULTS.similarityMethod);
  const [matchingMethod, setMatchingMethod] = useState(DEFAULTS.matchingMethod);
  const [trackingWindowSize, setTrackingWindowSize] = useState(DEFAULTS.trackingWindowSize);
  const [maxTracks, setMaxTracks] = useState<number | null>(DEFAULTS.maxTracks);
  const [noMaxTracks, setNoMaxTracks] = useState(true);
  const [connectSingleBreaks, setConnectSingleBreaks] = useState(DEFAULTS.connectSingleBreaks);
  const [robust, setRobust] = useState(DEFAULTS.robust);
  const [minMatchPoints, setMinMatchPoints] = useState(DEFAULTS.minMatchPoints);
  const [minNewTrackPoints, setMinNewTrackPoints] = useState(DEFAULTS.minNewTrackPoints);
  const [scoringReduction, setScoringReduction] = useState(DEFAULTS.scoringReduction);
  const [trackingTargetInstanceCount, setTrackingTargetInstanceCount] = useState<number | null>(DEFAULTS.trackingTargetInstanceCount);
  const [trackingPreCullToTarget, setTrackingPreCullToTarget] = useState(DEFAULTS.trackingPreCullToTarget);
  const [trackingPreCullIouThreshold, setTrackingPreCullIouThreshold] = useState(DEFAULTS.trackingPreCullIouThreshold);
  const [trackingCleanInstanceCount, setTrackingCleanInstanceCount] = useState<number | null>(DEFAULTS.trackingCleanInstanceCount);
  const [trackingCleanIouThreshold, setTrackingCleanIouThreshold] = useState(DEFAULTS.trackingCleanIouThreshold);
  const [flowImgScale, setFlowImgScale] = useState(DEFAULTS.flowImgScale);
  const [flowWindowSize, setFlowWindowSize] = useState(DEFAULTS.flowWindowSize);
  const [flowMaxLevels, setFlowMaxLevels] = useState(DEFAULTS.flowMaxLevels);
  const [kfTrackFeatures, setKfTrackFeatures] = useState(DEFAULTS.kfTrackFeatures);
  const [kfInitFrameCount, setKfInitFrameCount] = useState(DEFAULTS.kfInitFrameCount);
  const [kfNodeIndices, setKfNodeIndices] = useState<number[]>(DEFAULTS.kfNodeIndices);
  const [kfResetGapSize, setKfResetGapSize] = useState(DEFAULTS.kfResetGapSize);
  const [ensureChannels, setEnsureChannels] = useState(DEFAULTS.ensureChannels);
  const [filterOverlapping, setFilterOverlapping] = useState(DEFAULTS.filterOverlapping);
  const [filterMethod, setFilterMethod] = useState(DEFAULTS.filterMethod);
  const [filterThreshold, setFilterThreshold] = useState(DEFAULTS.filterThreshold);
  const [filterMinVisibleNodes, setFilterMinVisibleNodes] = useState<number | null>(DEFAULTS.filterMinVisibleNodes);
  const [filterMinVisibleNodeFraction, setFilterMinVisibleNodeFraction] = useState<number | null>(DEFAULTS.filterMinVisibleNodeFraction);
  const [filterMinMeanNodeScore, setFilterMinMeanNodeScore] = useState<number | null>(DEFAULTS.filterMinMeanNodeScore);
  const [filterMinInstanceScore, setFilterMinInstanceScore] = useState<number | null>(DEFAULTS.filterMinInstanceScore);
  const [filterMinCentroidDistance, setFilterMinCentroidDistance] = useState<number | null>(DEFAULTS.filterMinCentroidDistance);
  const [merging, setMerging] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Remote inference state
  const [remoteEnabled, setRemoteEnabled] = useState(!isTauri);
  const [remoteDataPath, setRemoteDataPath] = useState("");
  const [remoteModelPaths, setRemoteModelPaths] = useState<string[]>([]);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserMode, setFileBrowserMode] = useState<"directory" | "file">("directory");
  const [fileBrowserCallback, setFileBrowserCallback] = useState<((path: string) => void) | null>(null);

  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const workers = useConnectStore((s) => s.workers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const selectWorker = useConnectStore((s) => s.selectWorker);

  const availableWorkers = workers.filter((w) => w.status === "available");
  const selectedWorker = workers.find((w) => w.peerId === selectedWorkerId);
  const workerMounts = selectedWorker?.mounts || ["/"];

  // Elapsed time ticker
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (inferenceStatus !== "running" || !startedAt) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [inferenceStatus, startedAt]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Auto-detect trained models: if the project has a `models/` folder with a
  // trained run for every head the selected pipeline needs, default to the
  // most recently trained one per head — mirrors legacy SLEAP's
  // TrainingConfigsGetter auto-selecting the most recent trained config.
  // Never overwrites an existing selection (manual pick or a prior
  // auto-detect), and never runs for remote inference (no local project dir).
  useEffect(() => {
    if (!isTauri || remoteEnabled || !projectPath) return;
    let cancelled = false;
    (async () => {
      const [{ findTrainedModels, pickModelsForPipeline }, { dirname }] = await Promise.all([
        import("@/lib/modelDiscovery"),
        import("@tauri-apps/api/path"),
      ]);
      const projectDir = await dirname(projectPath);
      const models = await findTrainedModels(projectDir);
      if (cancelled) return;
      const picked = pickModelsForPipeline(models, pipeline);
      if (picked.length === 0) return;
      setModelPaths((prev) => (prev.length === 0 ? picked : prev));
    })();
    return () => {
      cancelled = true;
    };
  }, [remoteEnabled, projectPath, pipeline]);

  const sleapNnAvailable = tools.some(
    (t) => t.name === "sleap-nn" || t.commands?.includes("sleap-nn")
  );
  const isRunning = inferenceStatus === "running";
  const isDone = inferenceStatus === "completed" || inferenceStatus === "error" || inferenceStatus === "cancelled";
  const activeModelPaths = remoteEnabled ? remoteModelPaths : modelPaths;

  // Custom range validation: check against current video's frame count
  const currentVideoFrameCount = video?.shape?.[0] ?? Infinity;
  const customRangeInvalid = frameRange === "custom" && (
    Number(frameStart) < 0 ||
    Number(frameEnd) < 0 ||
    Number(frameStart) >= currentVideoFrameCount ||
    Number(frameEnd) >= currentVideoFrameCount ||
    Number(frameStart) > Number(frameEnd) ||
    isNaN(Number(frameStart)) ||
    isNaN(Number(frameEnd))
  );

  const canRun = (remoteEnabled ? (!!selectedWorkerId && !!remoteDataPath) : sleapNnAvailable) && !isRunning && !isDone && activeModelPaths.length > 0 && !customRangeInvalid;
  const isTopDown = pipeline === "top-down" || pipeline === "top-down-id";

  if (!isTauri && connectionStatus !== "connected") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <p className="text-xs text-muted-foreground">
          Connect to a worker in the Connect tab to start remote inference.
        </p>
      </div>
    );
  }

  const handleAddModel = async () => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await tauriOpen({ directory: true, title: "Select Model Directory" });
      if (selected && !modelPaths.includes(selected as string)) {
        setModelPaths((prev) => [...prev, selected as string]);
      }
    } catch { /* cancelled */ }
  };

  const handleRunInference = async () => {
    // Derive video index from inference target: "current video" targets use the
    // active video from appStore, "all videos" targets use "all"
    const currentVideoTargets = ["frame", "video", "random_video", "custom"];
    const currentVideoIdx = (() => {
      const { labels, video: activeVideo } = useAppStore.getState();
      if (!labels || !activeVideo) return 0;
      const idx = labels.videos.indexOf(activeVideo);
      return idx >= 0 ? idx : 0;
    })();
    const videoIndex = currentVideoTargets.includes(frameRange as string)
      ? currentVideoIdx
      : ("all" as const);

    const config: InferenceConfig = {
      pipeline, modelPaths: remoteEnabled ? remoteModelPaths : modelPaths,
      videoIndex,
      frameRange: frameRange === "custom" ? { start: Number(frameStart), end: Number(frameEnd) } : frameRange,
      sampleCount, excludeUserLabeled, batchSize, device,
      maxInstances: noMaxInstances ? null : maxInstances,
      peakThreshold,
      integralRefinement, integralPatchSize,
      nPoints, maxEdgeLengthRatio, distPenaltyWeight, minLineScores,
      tracking, trackerMethod, similarityMethod, matchingMethod,
      trackingWindowSize,
      maxTracks: noMaxTracks ? null : maxTracks,
      connectSingleBreaks, robust,
      minMatchPoints, minNewTrackPoints, scoringReduction,
      trackingTargetInstanceCount, trackingPreCullToTarget, trackingPreCullIouThreshold,
      trackingCleanInstanceCount, trackingCleanIouThreshold,
      flowImgScale, flowWindowSize, flowMaxLevels,
      kfTrackFeatures, kfInitFrameCount, kfNodeIndices, kfResetGapSize,
      ensureChannels, filterOverlapping, filterMethod, filterThreshold,
      filterMinVisibleNodes, filterMinVisibleNodeFraction, filterMinMeanNodeScore,
      filterMinInstanceScore, filterMinCentroidDistance,
    };

    if (remoteEnabled) {
      await startInference(config, {
        remote: true,
        dataPath: remoteDataPath,
        workerId: selectedWorkerId!,
      });
    } else {
      await startInference(config);
    }
  };

  const pct = progress && progress.nTotal > 0 ? (progress.nProcessed / progress.nTotal) * 100 : 0;

  return (
    <div className="flex flex-col gap-0 -m-2">
      {/* ── Configuration (top) ────────────────────────────────────── */}
      <div className="px-3 py-2 space-y-1">
        {!sleapNnAvailable && isTauri && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-[10px] text-yellow-700 dark:text-yellow-400 mb-1">
            <p className="font-medium">sleap-nn not detected</p>
            <p className="mt-0.5">Install via the Environment panel first.</p>
          </div>
        )}

        {/* ── Pipeline ────────────────────────────────────────────── */}
        <Section title="Pipeline" defaultOpen={true}>
          <Select value={pipeline} onValueChange={(v) => setPipeline(v as PipelineType)} disabled={isRunning}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PIPELINE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {PIPELINE_OPTIONS.find((o) => o.value === pipeline)?.desc}
          </p>
        </Section>

        <Separator />

        {/* ── Models ──────────────────────────────────────────────── */}
        <Section title="Models" defaultOpen={true}>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" className="h-6 text-[10px] px-2"
              onClick={() => {
                if (remoteEnabled) {
                  setFileBrowserMode("directory");
                  setFileBrowserCallback(() => (path: string) => {
                    setRemoteModelPaths((prev) => [...prev, path]);
                  });
                  setFileBrowserOpen(true);
                } else {
                  handleAddModel();
                }
              }} disabled={isRunning}>
              <FolderOpen className="h-3 w-3 mr-1" /> {remoteEnabled ? "Browse Worker" : "Add"}
            </Button>
          </div>
          {activeModelPaths.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {isTopDown ? "Add two directories (centroid + centered-instance)." : "Add a model directory."}
            </p>
          ) : (
            <div className="space-y-1">
              {activeModelPaths.map((p, i) => (
                <div key={i} className="flex items-center gap-1 rounded border border-green-500/50 bg-green-500/5 px-2 py-1">
                  <Folder className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                  <span className="text-[10px] truncate flex-1 font-medium" title={p}>{remoteEnabled ? p : p.split(/[\\/]/).pop()}</span>
                  <button className="text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => {
                      if (remoteEnabled) {
                        setRemoteModelPaths((prev) => prev.filter((_, j) => j !== i));
                      } else {
                        setModelPaths((prev) => prev.filter((_, j) => j !== i));
                      }
                    }}
                    disabled={isRunning} title="Remove">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Separator />

        {/* ── Data ────────────────────────────────────────────────── */}
        <Section title="Data" defaultOpen={true}>
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Inference Target</span>
            <Select value={frameRange} onValueChange={(v) => setFrameRange(v as FrameRange)} disabled={isRunning}>
              <SelectTrigger className="h-7 text-xs" data-tutorial="inference-target-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="frame">Current frame</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
                <SelectItem value="video">Entire current video</SelectItem>
                <SelectItem value="all_videos">All videos</SelectItem>
                <SelectItem value="random_video">Random sample (current video)</SelectItem>
                <SelectItem value="random">Random sample (all videos)</SelectItem>
                <SelectItem value="suggestions">Suggested frames</SelectItem>
                <SelectItem value="user_labeled">User labeled frames</SelectItem>
                <SelectItem value="predicted">Frames with predictions</SelectItem>
              </SelectContent>
            </Select>
            {(frameRange === "random_video" || frameRange === "random") && (
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="text-[10px] text-muted-foreground shrink-0">Sample count</span>
                <Input type="number" min={1} value={sampleCount}
                  onChange={(e) => setSampleCount(Math.max(1, Number(e.target.value)))}
                  className="h-6 text-[10px] w-20" disabled={isRunning} />
              </div>
            )}
            {frameRange === "custom" && (
              <div className="space-y-1 mt-1">
                <div className="flex items-center gap-1">
                  <Input type="number" min={0} placeholder="Start" value={frameStart}
                    onChange={(e) => setFrameStart(e.target.value)}
                    className={`h-6 text-[10px] flex-1 ${customRangeInvalid ? "border-red-500" : ""}`}
                    disabled={isRunning} />
                  <span className="text-[10px] text-muted-foreground">to</span>
                  <Input type="number" min={0} placeholder="End" value={frameEnd}
                    onChange={(e) => setFrameEnd(e.target.value)}
                    className={`h-6 text-[10px] flex-1 ${customRangeInvalid ? "border-red-500" : ""}`}
                    disabled={isRunning} />
                </div>
                {customRangeInvalid && (
                  <p className="text-[10px] text-red-400">
                    {Number(frameStart) > Number(frameEnd)
                      ? "Start must be less than end"
                      : currentVideoFrameCount !== Infinity
                        ? `Range must be 0–${currentVideoFrameCount - 1} (${currentVideoFrameCount} frames in current video)`
                        : "Invalid range"}
                  </p>
                )}
              </div>
            )}
          </div>
          <Check label="Exclude user-labeled frames" checked={excludeUserLabeled}
            onChange={setExcludeUserLabeled} disabled={isRunning} />
          {remoteEnabled && (
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Data Path (on worker)
              </label>
              <div className="flex gap-1">
                <Input
                  value={remoteDataPath}
                  readOnly
                  className="h-7 text-xs font-mono flex-1"
                  placeholder="Select a .slp or video file on the worker"
                />
                <Button
                  variant="outline"
                  size="xs"
                  className="px-2"
                  onClick={() => {
                    setFileBrowserMode("file");
                    setFileBrowserCallback(() => (path: string) => {
                      setRemoteDataPath(path);
                    });
                    setFileBrowserOpen(true);
                  }}
                >
                  <Folder className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </Section>

        <Separator />

        {/* ── Inference ───────────────────────────────────────────── */}
        <Section title="Inference" defaultOpen={true}>
          <NumField label="Batch size" value={batchSize} onChange={setBatchSize} min={1} max={128} disabled={isRunning} />

          {isTauri && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">Device</span>
              <Select value={device} onValueChange={(v) => setDevice(v as typeof device)} disabled={isRunning}>
                <SelectTrigger className="h-6 text-[10px] w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEVICE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <NumField label="Peak threshold" value={peakThreshold} onChange={setPeakThreshold}
            min={0} max={1} step={0.05} disabled={isRunning} />

          <div className="space-y-1">
            <NumField label="Max instances" value={maxInstances ?? 0}
              onChange={(v) => setMaxInstances(v)} min={1} max={100} disabled={isRunning || noMaxInstances} />
            <Check label="No limit" checked={noMaxInstances}
              onChange={(v) => { setNoMaxInstances(v); if (!v && maxInstances === null) setMaxInstances(2); }}
              disabled={isRunning} />
          </div>

        </Section>

        <Separator />

        {/* ── Tracking ────────────────────────────────────────────── */}
        <Section title="Tracking" defaultOpen={false}>
          <Check label="Enable tracking" hint="Connect predicted instances across frames to maintain identity over time."
            checked={tracking} onChange={setTracking} disabled={isRunning} />
          {tracking && (
            <>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel label="Method" hint="Simple matches instances by similarity alone. Optical Flow predicts motion from pixel displacement — best for fast-moving animals. Kalman Filter predicts motion from a per-track velocity model — best for a known, fixed number of animals whose motion helps disambiguate crossings or occlusions." />
                <Select value={trackerMethod} onValueChange={(v) => setTrackerMethod(v as typeof trackerMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="simple">Simple</SelectItem>
                    <SelectItem value="flow">Optical Flow</SelectItem>
                    <SelectItem value="kalman">Kalman Filter</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel label="Similarity" hint="Metric for comparing instances across frames. OKS uses keypoint positions, IoU uses bounding boxes, Centroids uses center distance." />
                <Select value={similarityMethod} onValueChange={(v) => setSimilarityMethod(v as typeof similarityMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oks">OKS</SelectItem>
                    <SelectItem value="iou">IoU</SelectItem>
                    <SelectItem value="centroids">Centroid dist.</SelectItem>
                    <SelectItem value="euclidean_dist">Euclidean dist.</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel label="Matching" hint="Algorithm for assigning detections to tracks. Hungarian finds the globally optimal assignment; Greedy is faster but may be suboptimal." />
                <Select value={matchingMethod} onValueChange={(v) => setMatchingMethod(v as typeof matchingMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hungarian">Hungarian</SelectItem>
                    <SelectItem value="greedy">Greedy</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <NumField label="Window size" value={trackingWindowSize} onChange={setTrackingWindowSize}
                hint="Number of past frames used as matching candidates. Fixed Window (default) uses the last N frames; Local Queues (used automatically when Max Tracks is set) keeps the last N instances per track ID instead — more robust to track breaks and occlusions."
                min={1} max={100} disabled={isRunning} />
              <div className="space-y-1">
                <NumField label="Max tracks" value={maxTracks ?? 0}
                  hint="Maximum number of simultaneous tracks. Leave empty for no limit; set to the number of animals if known. Setting this automatically switches matching to Local Queues, since Fixed Window ignores this cap."
                  onChange={(v) => setMaxTracks(v)} min={1} max={100} disabled={isRunning || noMaxTracks} />
                <Check label="No limit" checked={noMaxTracks}
                  onChange={(v) => { setNoMaxTracks(v); if (!v && maxTracks === null) setMaxTracks(2); }}
                  disabled={isRunning} />
              </div>
              <Section title="Advanced">
                <NumField label="Robust (quantile)" value={robust} onChange={setRobust}
                  hint="If between 0 and 1 (exclusive), uses a robust quantile similarity score instead of the plain max across matched keypoints — 0.95 is a good starting value. Leave at 1 to use max similarity (non-robust)."
                  min={0} max={1} step={0.05} disabled={isRunning} />
                <Check label="Connect single-frame breaks" checked={connectSingleBreaks}
                  hint="When Max Tracks is set (Local Queues matching), reconnects a track break where exactly one track is lost and exactly one new track is spawned in the same frame — fixes brief detection dropouts without merging unrelated tracks."
                  onChange={setConnectSingleBreaks} disabled={isRunning} />
                <NumField label="Min match points" value={minMatchPoints} onChange={setMinMatchPoints}
                  hint="Minimum number of non-missing keypoints an instance needs to be considered a valid match candidate."
                  min={0} disabled={isRunning} />
                <NumField label="Min new-track points" value={minNewTrackPoints} onChange={setMinNewTrackPoints}
                  hint="Minimum number of non-missing keypoints required before an unmatched instance is allowed to spawn a new track."
                  min={0} disabled={isRunning} />
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel label="Scoring reduction" hint="How to combine multiple similarity scores when several detections could match the same track: Mean averages them, Max takes the best score, Robust quantile is tolerant of outlier scores." />
                  <Select value={scoringReduction} onValueChange={(v) => setScoringReduction(v as typeof scoringReduction)} disabled={isRunning}>
                    <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mean">Mean</SelectItem>
                      <SelectItem value="max">Max</SelectItem>
                      <SelectItem value="robust_quantile">Robust quantile</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <NullableNumField label="Target instance count" value={trackingTargetInstanceCount}
                  hint="Target number of instances to track per frame. Required by Kalman filtering and Pre-cull; auto-derived from Max Tracks/Max Instances if left empty."
                  onChange={setTrackingTargetInstanceCount} min={1} max={100} placeholder="Auto" disabled={isRunning} />
                <Check label="Pre-cull to target" checked={trackingPreCullToTarget}
                  hint="Before tracking, discard detections above the target instance count for that frame."
                  onChange={setTrackingPreCullToTarget} disabled={isRunning} />
                {trackingPreCullToTarget && (
                  <NumField label="Pre-cull IoU threshold" value={trackingPreCullIouThreshold} onChange={setTrackingPreCullIouThreshold}
                    hint="IoU threshold used to remove overlapping instances above the target count before tracking."
                    min={0} max={1} step={0.05} disabled={isRunning} />
                )}
                <NullableNumField label="Clean-up instance count" value={trackingCleanInstanceCount}
                  hint="After tracking, cull instances above this target count per frame — unlike Pre-cull (which trims before tracking), this trims the tracked output. Leave empty to disable."
                  onChange={setTrackingCleanInstanceCount} min={1} max={100} placeholder="Disabled" disabled={isRunning} />
                {trackingCleanInstanceCount != null && (
                  <NumField label="Clean-up IoU threshold" value={trackingCleanIouThreshold} onChange={setTrackingCleanIouThreshold}
                    hint="IoU threshold used when culling instances above the clean-up target count after tracking."
                    min={0} max={1} step={0.05} disabled={isRunning} />
                )}
              </Section>

              {trackerMethod === "flow" && (
                <>
                  <div className="pt-1 text-[10px] font-medium text-muted-foreground">Optical Flow</div>
                  <NumField label="Image scale" value={flowImgScale} onChange={setFlowImgScale}
                    hint="Scale factor for images before computing optical flow. Lower values are faster but less precise."
                    min={0.1} max={2} step={0.1} disabled={isRunning} />
                  <NumField label="Flow window size" value={flowWindowSize} onChange={setFlowWindowSize}
                    hint="Size of the search window for optical flow computation. Larger windows handle faster motion but are slower."
                    min={3} max={99} step={2} disabled={isRunning} />
                  <NumField label="Pyramid levels" value={flowMaxLevels} onChange={setFlowMaxLevels}
                    hint="Number of image pyramid levels for multi-scale optical flow. More levels handle larger displacements."
                    min={1} max={10} disabled={isRunning} />
                </>
              )}

              {trackerMethod === "kalman" && (
                <>
                  <div className="pt-1 text-[10px] font-medium text-muted-foreground">Kalman Filter</div>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel label="Track features" hint="What the motion model tracks. Centroid (default) rigidly translates the last pose using a single filter per track — stable and recommended. Keypoints runs one filter per node for noisier but sometimes more distinctive per-node motion; pair it with a permissive similarity setting." />
                    <Select value={kfTrackFeatures} onValueChange={(v) => setKfTrackFeatures(v as typeof kfTrackFeatures)} disabled={isRunning}>
                      <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="centroid">Centroid</SelectItem>
                        <SelectItem value="keypoints">Keypoints</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <NumField label="Init frame count" value={kfInitFrameCount} onChange={setKfInitFrameCount}
                    hint="Number of warm-up frames tracked with the base tracker before the Kalman filters are fit via EM."
                    min={1} disabled={isRunning} />
                  <NumField label="Reset gap size" value={kfResetGapSize} onChange={setKfResetGapSize}
                    hint="Number of consecutive missed frames after which a stale track's Kalman filter is reset."
                    min={1} disabled={isRunning} />
                  <FieldLabel label="Tracked nodes (all if none checked)" hint="Skeleton nodes to track with the motion model. Useful for restricting to a stable subset, e.g. spine nodes. Leave all unchecked to use every node." />
                  <NodeCheckboxList nodes={skeletonNodeNames} selected={kfNodeIndices} onChange={setKfNodeIndices} disabled={isRunning} />
                </>
              )}
            </>
          )}
        </Section>

        <Separator />

        {/* ── Post-processing ─────────────────────────────────────── */}
        <Section title="Post-processing" defaultOpen={false}>
          <Check label="Filter overlapping instances" checked={filterOverlapping}
            hint="Remove duplicate detections that overlap significantly, using greedy non-max suppression. Applied independently of tracking, after node-count and confidence filters."
            onChange={setFilterOverlapping} disabled={isRunning} />
          {filterOverlapping && (
            <>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel label="Method" hint="Metric for measuring overlap. IoU uses bounding box intersection; OKS uses keypoint similarity." />
                <Select value={filterMethod} onValueChange={(v) => setFilterMethod(v as typeof filterMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iou">IoU</SelectItem>
                    <SelectItem value="oks">OKS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <NumField label="Threshold" value={filterThreshold} onChange={setFilterThreshold}
                hint="Overlap score above which instances are considered duplicates and the lower-scoring one is removed. Lower is more aggressive (~0.3), higher is more permissive (0.8 default)."
                min={0} max={1} step={0.05} disabled={isRunning} />
            </>
          )}
          <NullableNumField label="Min visible nodes" value={filterMinVisibleNodes}
            hint="Minimum number of visible (non-missing) keypoints an instance must have to be kept. Leave empty to disable."
            onChange={setFilterMinVisibleNodes} min={0} placeholder="Off" disabled={isRunning} />
          <NullableNumField label="Min visible node fraction" value={filterMinVisibleNodeFraction}
            hint="Minimum fraction of skeleton nodes that must be visible, e.g. 0.5 requires at least half. Leave empty to disable."
            onChange={setFilterMinVisibleNodeFraction} min={0} max={1} step={0.05} placeholder="Off" disabled={isRunning} />
          <NullableNumField label="Min mean node score" value={filterMinMeanNodeScore}
            hint="Minimum mean confidence score across an instance's visible nodes. Instances scoring lower are removed. Leave empty to disable."
            onChange={setFilterMinMeanNodeScore} min={0} max={1} step={0.05} placeholder="Off" disabled={isRunning} />
          <NullableNumField label="Min instance score" value={filterMinInstanceScore}
            hint="Minimum overall instance confidence score. Leave empty to disable. Meaning differs by pipeline: for Top-Down this is centroid confidence; for Bottom-Up it's derived from PAF grouping quality."
            onChange={setFilterMinInstanceScore} min={0} max={1} step={0.05} placeholder="Off" disabled={isRunning} />
          <NullableNumField label="Min centroid distance" value={filterMinCentroidDistance}
            hint="Centroid-only de-duplication radius in pixels: drops any predicted centroid within this distance of a higher-scored kept centroid. Use this instead of Filter Overlapping for centroid-only output, since bounding-box IoU/OKS are degenerate for single points. Leave empty to disable."
            onChange={setFilterMinCentroidDistance} min={0} step={1} placeholder="Off" disabled={isRunning} />
        </Section>

        {isTauri && (
          <>
            <Separator />

            {/* ── Remote (desktop only — web is always remote) ──────── */}
            <Section title="Remote" defaultOpen={false}>
              <div className="flex items-center justify-between py-1">
                <span className="text-xs">Remote Inference</span>
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
                  Connect to a room in the Connect tab to enable remote inference.
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
                        const room = state.availableRooms.find((r) => r.roomId === state.roomId);
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

                  {availableWorkers.length === 0 && (
                    <div className="bg-orange-500/8 border border-orange-500/20 rounded-md p-2 text-[11px] text-orange-400">
                      <b>All workers are busy.</b> Wait for a worker to become
                      available, or disable remote inference.
                    </div>
                  )}
                </>
              )}
            </Section>
          </>
        )}

        <Separator />

        {/* ── Action buttons ──────────────────────────────────────── */}
        <Button
          variant="outline"
          className="w-full h-8 text-xs border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
          onClick={() => setConfigDialogOpen(true)}
          disabled={isRunning}
        >
          <Settings2 className="h-3 w-3 mr-1.5" />
          Full Configuration...
        </Button>
        <Button
          className="w-full h-8 text-xs"
          onClick={handleRunInference}
          disabled={!canRun}
          data-tutorial="run-inference-button"
        >
          <Play className="h-3.5 w-3.5 mr-1.5" /> {remoteEnabled ? "Run Remote Inference" : "Run Inference"}
        </Button>
      </div>

      {/* ── Progress (bottom) ──────────────────────────────────────── */}
      {(isRunning || isDone) && (
        <>
          <Separator />
          <div className="px-3 py-2 space-y-2">
            {/* Status header */}
            <div className="flex items-center gap-2">
              {isRunning && (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs font-medium">Running...</span>
                </>
              )}
              {inferenceStatus === "completed" && (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-xs font-medium">Complete</span>
                </>
              )}
              {inferenceStatus === "error" && (
                <>
                  <XCircle className="h-4 w-4 text-destructive" />
                  <span className="text-xs font-medium">Failed</span>
                </>
              )}
              {inferenceStatus === "cancelled" && (
                <>
                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                  <span className="text-xs font-medium">Cancelled</span>
                </>
              )}
              {startedAt && (
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {formatDuration(isDone ? elapsed : Date.now() - startedAt)}
                </span>
              )}
            </div>

            {/* Progress bar */}
            <div className="space-y-1">
              <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{progress ? `${progress.nProcessed} / ${progress.nTotal} frames` : "Initializing..."}</span>
                <span>{pct > 0 ? `${pct.toFixed(1)}%` : ""}</span>
              </div>
            </div>

            {/* Stats */}
            {progress && (
              <div className="flex gap-3 text-[10px] text-muted-foreground">
                {progress.rate > 0 && <span>{progress.rate.toFixed(1)} fps</span>}
                {progress.eta > 0 && <span>ETA {formatEta(progress.eta)}</span>}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="rounded-md bg-destructive/15 border border-destructive/30 px-2 py-1.5 text-[10px] text-destructive">
                {error}
              </div>
            )}

            {/* Inline actions (cancel while running, load results on complete) */}
            {isRunning && (
              <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => cancelInference()}>
                <X className="h-3.5 w-3.5 mr-1" /> Cancel
              </Button>
            )}
            {inferenceStatus === "completed" && outputPath && (
              isTauri ? (
                <Button size="sm" className="h-7 text-xs"
                  onClick={async () => { setMerging(true); await loadAndMergeResults(); setMerging(false); }}
                  disabled={merging}>
                  {merging ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                  {merging ? "Loading..." : "Load Results"}
                </Button>
              ) : (
                <div className="text-[10px] text-muted-foreground">
                  Results saved on worker. Download from the worker filesystem to load.
                </div>
              )
            )}

            {/* Log */}
            {log.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Log</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => setLogDialogOpen(true)}
                  >
                    <Maximize2 className="h-3 w-3 mr-1" /> Expand
                  </Button>
                </div>
                <pre
                  ref={logRef}
                  onClick={() => setLogDialogOpen(true)}
                  title="Click to open the full log"
                  className="max-h-48 overflow-auto rounded border bg-muted p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all cursor-pointer hover:border-muted-foreground/50"
                >
                  {log.join("\n")}
                </pre>
              </div>
            )}
            <LogTerminalDialog
              open={logDialogOpen}
              onOpenChange={setLogDialogOpen}
              log={log}
              title="Inference log"
            />

            {/* Bottom actions: copy + dismiss */}
            {isDone && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-7 text-xs"
                  onClick={() => navigator.clipboard.writeText(log.join("\n"))}>
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy Log
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => reset()}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      <RemoteFileBrowser
        open={fileBrowserOpen}
        onClose={() => setFileBrowserOpen(false)}
        onSelect={(path) => {
          if (fileBrowserCallback) fileBrowserCallback(path);
          setFileBrowserOpen(false);
        }}
        mounts={workerMounts}
        mode={fileBrowserMode}
        fileFilter={
          fileBrowserMode === "file" ? INFERENCE_DATA_EXTENSIONS : undefined
        }
      />

      <InferenceConfigDialog
        open={configDialogOpen}
        onClose={() => setConfigDialogOpen(false)}
        pipeline={pipeline}
        tracking={tracking}
        onTrackingChange={setTracking}
        skeletonNodes={skeletonNodeNames}
        values={{
          peakThreshold, maxInstances,
          integralRefinement, integralPatchSize,
          nPoints, maxEdgeLengthRatio, distPenaltyWeight, minLineScores,
          trackerMethod, similarityMethod, matchingMethod,
          trackingWindowSize, maxTracks, connectSingleBreaks, robust,
          minMatchPoints, minNewTrackPoints, scoringReduction,
          trackingTargetInstanceCount, trackingPreCullToTarget, trackingPreCullIouThreshold,
          trackingCleanInstanceCount, trackingCleanIouThreshold,
          flowImgScale, flowWindowSize, flowMaxLevels,
          kfTrackFeatures, kfInitFrameCount, kfNodeIndices, kfResetGapSize,
          ensureChannels, filterOverlapping, filterMethod, filterThreshold,
          filterMinVisibleNodes, filterMinVisibleNodeFraction, filterMinMeanNodeScore,
          filterMinInstanceScore, filterMinCentroidDistance,
        }}
        onUpdate={(updates) => {
          if ("peakThreshold" in updates) setPeakThreshold(updates.peakThreshold!);
          if ("maxInstances" in updates) setMaxInstances(updates.maxInstances!);
          if ("integralRefinement" in updates) setIntegralRefinement(updates.integralRefinement!);
          if ("integralPatchSize" in updates) setIntegralPatchSize(updates.integralPatchSize!);
          if ("nPoints" in updates) setNPoints(updates.nPoints!);
          if ("maxEdgeLengthRatio" in updates) setMaxEdgeLengthRatio(updates.maxEdgeLengthRatio!);
          if ("distPenaltyWeight" in updates) setDistPenaltyWeight(updates.distPenaltyWeight!);
          if ("minLineScores" in updates) setMinLineScores(updates.minLineScores!);
          if ("trackerMethod" in updates) setTrackerMethod(updates.trackerMethod!);
          if ("similarityMethod" in updates) setSimilarityMethod(updates.similarityMethod!);
          if ("matchingMethod" in updates) setMatchingMethod(updates.matchingMethod!);
          if ("trackingWindowSize" in updates) setTrackingWindowSize(updates.trackingWindowSize!);
          if ("maxTracks" in updates) { setMaxTracks(updates.maxTracks!); setNoMaxTracks(updates.maxTracks === null); }
          if ("connectSingleBreaks" in updates) setConnectSingleBreaks(updates.connectSingleBreaks!);
          if ("robust" in updates) setRobust(updates.robust!);
          if ("minMatchPoints" in updates) setMinMatchPoints(updates.minMatchPoints!);
          if ("minNewTrackPoints" in updates) setMinNewTrackPoints(updates.minNewTrackPoints!);
          if ("scoringReduction" in updates) setScoringReduction(updates.scoringReduction!);
          if ("trackingTargetInstanceCount" in updates) setTrackingTargetInstanceCount(updates.trackingTargetInstanceCount!);
          if ("trackingPreCullToTarget" in updates) setTrackingPreCullToTarget(updates.trackingPreCullToTarget!);
          if ("trackingPreCullIouThreshold" in updates) setTrackingPreCullIouThreshold(updates.trackingPreCullIouThreshold!);
          if ("trackingCleanInstanceCount" in updates) setTrackingCleanInstanceCount(updates.trackingCleanInstanceCount!);
          if ("trackingCleanIouThreshold" in updates) setTrackingCleanIouThreshold(updates.trackingCleanIouThreshold!);
          if ("flowImgScale" in updates) setFlowImgScale(updates.flowImgScale!);
          if ("flowWindowSize" in updates) setFlowWindowSize(updates.flowWindowSize!);
          if ("flowMaxLevels" in updates) setFlowMaxLevels(updates.flowMaxLevels!);
          if ("kfTrackFeatures" in updates) setKfTrackFeatures(updates.kfTrackFeatures!);
          if ("kfInitFrameCount" in updates) setKfInitFrameCount(updates.kfInitFrameCount!);
          if ("kfNodeIndices" in updates) setKfNodeIndices(updates.kfNodeIndices!);
          if ("kfResetGapSize" in updates) setKfResetGapSize(updates.kfResetGapSize!);
          if ("ensureChannels" in updates) setEnsureChannels(updates.ensureChannels!);
          if ("filterOverlapping" in updates) setFilterOverlapping(updates.filterOverlapping!);
          if ("filterMethod" in updates) setFilterMethod(updates.filterMethod!);
          if ("filterThreshold" in updates) setFilterThreshold(updates.filterThreshold!);
          if ("filterMinVisibleNodes" in updates) setFilterMinVisibleNodes(updates.filterMinVisibleNodes!);
          if ("filterMinVisibleNodeFraction" in updates) setFilterMinVisibleNodeFraction(updates.filterMinVisibleNodeFraction!);
          if ("filterMinMeanNodeScore" in updates) setFilterMinMeanNodeScore(updates.filterMinMeanNodeScore!);
          if ("filterMinInstanceScore" in updates) setFilterMinInstanceScore(updates.filterMinInstanceScore!);
          if ("filterMinCentroidDistance" in updates) setFilterMinCentroidDistance(updates.filterMinCentroidDistance!);
        }}
      />
    </div>
  );
}
