/**
 * Inference panel for configuring and running sleap-nn predictions.
 *
 * Organized into sections:
 *  - Progress (when running/done)
 *  - Pipeline type
 *  - Models
 *  - Data (video, frames, exclusions)
 *  - Inference (batch, device, peaks, anchor)
 *  - Tracking (collapsible)
 *  - Advanced (collapsible: bottom-up params, optical flow, NMS)
 */

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useEnvironmentStore } from "../../stores/environmentStore";
import { useInferenceStore } from "../../stores/inferenceStore";
import type { InferenceConfig, PipelineType } from "@/stores/inferenceStore";
import { isTauri } from "../../platform/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
  Play,
  X,
  Download,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type FrameRange = "all" | "labeled" | "suggested" | "custom";

const PIPELINE_OPTIONS: { value: PipelineType; label: string; desc: string }[] =
  [
    {
      value: "top-down",
      label: "Top-Down",
      desc: "Two models: centroid detection + centered instance. Best for multi-animal.",
    },
    {
      value: "bottom-up",
      label: "Bottom-Up",
      desc: "Single model with confidence maps + PAFs. Good for dense groups.",
    },
    {
      value: "single-animal",
      label: "Single Animal",
      desc: "Single confidence map model. Use when only one animal is present.",
    },
    {
      value: "top-down-id",
      label: "Top-Down + ID",
      desc: "Top-down with identity classification for re-identification.",
    },
    {
      value: "bottom-up-id",
      label: "Bottom-Up + ID",
      desc: "Bottom-up with identity classification for re-identification.",
    },
  ];

const DEVICE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "cuda", label: "CUDA (GPU)" },
  { value: "cpu", label: "CPU" },
  { value: "mps", label: "MPS (Apple Silicon)" },
];

const SIMILARITY_OPTIONS = [
  { value: "oks", label: "Object Keypoint Similarity" },
  { value: "iou", label: "IoU (bounding box)" },
  { value: "centroids", label: "Centroid distance" },
  { value: "euclidean_dist", label: "Euclidean distance" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Collapsible section with chevron toggle. */
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

/** Inline checkbox + label. */
function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
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
    </label>
  );
}

/** Small labeled number input. */
function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground shrink-0">
        {label}
      </span>
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

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: Omit<InferenceConfig, "modelPaths" | "videoIndex" | "frameRange"> = {
  pipeline: "top-down",
  excludeUserLabeled: false,
  batchSize: 4,
  device: "auto",
  maxInstances: null,
  peakThreshold: 0.2,
  anchorPart: null,
  integralRefinement: true,
  integralPatchSize: 5,
  nPoints: 10,
  maxEdgeLengthRatio: 0.25,
  distPenaltyWeight: 1.0,
  minLineScores: 0.25,
  tracking: true,
  trackerMethod: "simple",
  similarityMethod: "oks",
  matchingMethod: "hungarian",
  trackingWindowSize: 5,
  maxTracks: null,
  connectSingleBreaks: false,
  flowImgScale: 1.0,
  flowWindowSize: 21,
  flowMaxLevels: 3,
  filterOverlapping: false,
  filterMethod: "iou",
  filterThreshold: 0.8,
};

// ── Panel ─────────────────────────────────────────────────────────────────────

export function InferencePanel() {
  const labels = useAppStore((s) => s.labels);
  const skeleton = useAppStore((s) => s.skeleton);
  const tools = useEnvironmentStore((s) => s.tools);
  const detectionStatus = useEnvironmentStore((s) => s.detectionStatus);
  const refresh = useEnvironmentStore((s) => s.refresh);

  useEffect(() => {
    if (isTauri && detectionStatus === "idle") {
      refresh();
    }
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

  // ── Config state ────────────────────────────────────────────────────────

  const [pipeline, setPipeline] = useState<PipelineType>(DEFAULTS.pipeline);
  const [modelPaths, setModelPaths] = useState<string[]>([]);
  const [selectedVideo, setSelectedVideo] = useState("all");
  const [frameRange, setFrameRange] = useState<FrameRange>("all");
  const [frameStart, setFrameStart] = useState("0");
  const [frameEnd, setFrameEnd] = useState("1000");
  const [excludeUserLabeled, setExcludeUserLabeled] = useState(DEFAULTS.excludeUserLabeled);

  const [batchSize, setBatchSize] = useState(DEFAULTS.batchSize);
  const [device, setDevice] = useState(DEFAULTS.device);
  const [maxInstances, setMaxInstances] = useState<number | null>(DEFAULTS.maxInstances);
  const [noMaxInstances, setNoMaxInstances] = useState(true);
  const [peakThreshold, setPeakThreshold] = useState(DEFAULTS.peakThreshold);
  const [anchorPart, setAnchorPart] = useState<string | null>(DEFAULTS.anchorPart);

  // Bottom-up advanced
  const [integralRefinement, setIntegralRefinement] = useState(DEFAULTS.integralRefinement);
  const [integralPatchSize, setIntegralPatchSize] = useState(DEFAULTS.integralPatchSize);
  const [nPoints, setNPoints] = useState(DEFAULTS.nPoints);
  const [maxEdgeLengthRatio, setMaxEdgeLengthRatio] = useState(DEFAULTS.maxEdgeLengthRatio);
  const [distPenaltyWeight, setDistPenaltyWeight] = useState(DEFAULTS.distPenaltyWeight);
  const [minLineScores, setMinLineScores] = useState(DEFAULTS.minLineScores);

  // Tracking
  const [tracking, setTracking] = useState(DEFAULTS.tracking);
  const [trackerMethod, setTrackerMethod] = useState(DEFAULTS.trackerMethod);
  const [similarityMethod, setSimilarityMethod] = useState(DEFAULTS.similarityMethod);
  const [matchingMethod, setMatchingMethod] = useState(DEFAULTS.matchingMethod);
  const [trackingWindowSize, setTrackingWindowSize] = useState(DEFAULTS.trackingWindowSize);
  const [maxTracks, setMaxTracks] = useState<number | null>(DEFAULTS.maxTracks);
  const [noMaxTracks, setNoMaxTracks] = useState(true);
  const [connectSingleBreaks, setConnectSingleBreaks] = useState(DEFAULTS.connectSingleBreaks);

  // Optical flow
  const [flowImgScale, setFlowImgScale] = useState(DEFAULTS.flowImgScale);
  const [flowWindowSize, setFlowWindowSize] = useState(DEFAULTS.flowWindowSize);
  const [flowMaxLevels, setFlowMaxLevels] = useState(DEFAULTS.flowMaxLevels);

  // Post-processing
  const [filterOverlapping, setFilterOverlapping] = useState(DEFAULTS.filterOverlapping);
  const [filterMethod, setFilterMethod] = useState(DEFAULTS.filterMethod);
  const [filterThreshold, setFilterThreshold] = useState(DEFAULTS.filterThreshold);

  const [merging, setMerging] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

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

  const videos = labels?.videos ?? [];
  const nodes = skeleton?.nodes ?? [];
  const sleapNnAvailable = tools.some(
    (t) => t.name === "sleap-nn" || t.commands?.includes("sleap-nn")
  );
  const isRunning = inferenceStatus === "running";
  const isDone =
    inferenceStatus === "completed" ||
    inferenceStatus === "error" ||
    inferenceStatus === "cancelled";
  const canRun =
    sleapNnAvailable && !isRunning && !isDone && modelPaths.length > 0;

  const isBottomUp = pipeline === "bottom-up" || pipeline === "bottom-up-id";
  const isTopDown = pipeline === "top-down" || pipeline === "top-down-id";

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <p className="text-xs text-muted-foreground">
          Inference is only available in the desktop app.
        </p>
      </div>
    );
  }

  const handleAddModel = async () => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await tauriOpen({
        directory: true,
        title: "Select Model Directory",
      });
      if (selected && !modelPaths.includes(selected as string)) {
        setModelPaths((prev) => [...prev, selected as string]);
      }
    } catch {
      // User cancelled
    }
  };

  const handleRunInference = async () => {
    const config: InferenceConfig = {
      pipeline,
      modelPaths,
      videoIndex: selectedVideo === "all" ? "all" : Number(selectedVideo),
      frameRange:
        frameRange === "custom"
          ? { start: Number(frameStart), end: Number(frameEnd) }
          : frameRange,
      excludeUserLabeled,
      batchSize,
      device,
      maxInstances: noMaxInstances ? null : maxInstances,
      peakThreshold,
      anchorPart: isTopDown ? anchorPart : null,
      integralRefinement,
      integralPatchSize,
      nPoints,
      maxEdgeLengthRatio,
      distPenaltyWeight,
      minLineScores,
      tracking,
      trackerMethod,
      similarityMethod,
      matchingMethod,
      trackingWindowSize,
      maxTracks: noMaxTracks ? null : maxTracks,
      connectSingleBreaks,
      flowImgScale,
      flowWindowSize,
      flowMaxLevels,
      filterOverlapping,
      filterMethod,
      filterThreshold,
    };
    await startInference(config);
  };

  const pct =
    progress && progress.nTotal > 0
      ? (progress.nProcessed / progress.nTotal) * 100
      : 0;

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-0 -m-2">
      {/* ── Progress ─────────────────────────────────────────────────────── */}
      {(isRunning || isDone) && (
        <>
          <div className="px-3 pt-3 space-y-2">
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

            <div className="space-y-1">
              <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>
                  {progress
                    ? `${progress.nProcessed} / ${progress.nTotal} frames`
                    : "Initializing..."}
                </span>
                <span>{pct > 0 ? `${pct.toFixed(1)}%` : ""}</span>
              </div>
            </div>

            {progress && (
              <div className="flex gap-3 text-[10px] text-muted-foreground">
                {progress.rate > 0 && <span>{progress.rate.toFixed(1)} fps</span>}
                {progress.eta > 0 && <span>ETA {formatEta(progress.eta)}</span>}
              </div>
            )}

            {error && (
              <div className="rounded-md bg-destructive/15 border border-destructive/30 px-2 py-1.5 text-[10px] text-destructive whitespace-pre-wrap break-all">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              {isRunning && (
                <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => cancelInference()}>
                  <X className="h-3.5 w-3.5 mr-1" /> Cancel
                </Button>
              )}
              {inferenceStatus === "completed" && outputPath && (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={async () => { setMerging(true); await loadAndMergeResults(); setMerging(false); }}
                  disabled={merging}
                >
                  {merging ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                  {merging ? "Loading..." : "Load Results"}
                </Button>
              )}
              {isDone && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => reset()}>
                  Dismiss
                </Button>
              )}
            </div>

            {log.length > 0 && (
              <pre
                ref={logRef}
                className="max-h-48 overflow-auto rounded border bg-muted p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all"
              >
                {log.join("\n")}
              </pre>
            )}
          </div>
          <Separator className="my-2" />
        </>
      )}

      {/* ── Configuration ──────────────────────────────────────────────── */}
      <div className="px-3 pb-3 space-y-2">
        {!sleapNnAvailable && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-[10px] text-yellow-700 dark:text-yellow-400">
            <p className="font-medium">sleap-nn not detected</p>
            <p className="mt-0.5">Install via the Environment panel first.</p>
          </div>
        )}

        {/* ── Pipeline ───────────────────────────────────────────────── */}
        <div className="space-y-1">
          <Label className="text-xs">Pipeline</Label>
          <Select
            value={pipeline}
            onValueChange={(v) => setPipeline(v as PipelineType)}
            disabled={isRunning}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PIPELINE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {PIPELINE_OPTIONS.find((o) => o.value === pipeline)?.desc}
          </p>
        </div>

        {/* ── Models ─────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Models</Label>
            <Button
              variant="outline" size="sm" className="h-6 text-[10px] px-2"
              onClick={handleAddModel} disabled={isRunning}
            >
              <FolderOpen className="h-3 w-3 mr-1" /> Add
            </Button>
          </div>
          {modelPaths.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {isTopDown
                ? "Add two model directories (centroid + centered-instance)."
                : "Add a model directory."}
            </p>
          ) : (
            <div className="space-y-1">
              {modelPaths.map((p, i) => (
                <div key={i} className="flex items-center gap-1 rounded border bg-muted/50 px-2 py-1">
                  <span className="text-[10px] truncate flex-1" title={p}>
                    {p.split(/[\\/]/).pop()}
                  </span>
                  <button
                    className="text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => setModelPaths((prev) => prev.filter((_, j) => j !== i))}
                    disabled={isRunning} title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <Separator />

        {/* ── Data ───────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label className="text-xs">Data</Label>

          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Video</span>
            <Select value={selectedVideo} onValueChange={setSelectedVideo} disabled={isRunning}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All videos</SelectItem>
                {videos.map((video, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {video.filename ?? video.backendMetadata?.filename ?? `Video ${i + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Frames</span>
            <Select
              value={frameRange}
              onValueChange={(v) => setFrameRange(v as FrameRange)}
              disabled={isRunning}
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All frames</SelectItem>
                <SelectItem value="labeled">Labeled frames only</SelectItem>
                <SelectItem value="suggested">Suggested frames only</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {frameRange === "custom" && (
              <div className="flex items-center gap-1 mt-1">
                <Input type="number" min={0} placeholder="Start" value={frameStart}
                  onChange={(e) => setFrameStart(e.target.value)} className="h-6 text-[10px] flex-1" disabled={isRunning} />
                <span className="text-[10px] text-muted-foreground">to</span>
                <Input type="number" min={0} placeholder="End" value={frameEnd}
                  onChange={(e) => setFrameEnd(e.target.value)} className="h-6 text-[10px] flex-1" disabled={isRunning} />
              </div>
            )}
          </div>

          <Check label="Exclude user-labeled frames" checked={excludeUserLabeled}
            onChange={setExcludeUserLabeled} disabled={isRunning} />
        </div>

        <Separator />

        {/* ── Inference ──────────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label className="text-xs">Inference</Label>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">Batch size</span>
            <Input type="number" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))}
              min={1} max={128} className="h-6 text-[10px] w-16" disabled={isRunning} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">Device</span>
            <Select value={device} onValueChange={(v) => setDevice(v as typeof device)} disabled={isRunning}>
              <SelectTrigger className="h-6 text-[10px] w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DEVICE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">Peak threshold</span>
            <Input type="number" value={peakThreshold} onChange={(e) => setPeakThreshold(Number(e.target.value))}
              min={0} max={1} step={0.05} className="h-6 text-[10px] w-16" disabled={isRunning} />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">Max instances</span>
              <Input type="number" value={maxInstances ?? 0}
                onChange={(e) => setMaxInstances(Number(e.target.value))}
                min={1} max={100} className="h-6 text-[10px] w-16"
                disabled={isRunning || noMaxInstances} />
            </div>
            <Check label="No limit" checked={noMaxInstances}
              onChange={(v) => { setNoMaxInstances(v); if (!v && maxInstances === null) setMaxInstances(2); }}
              disabled={isRunning} />
          </div>

          {isTopDown && nodes.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">Anchor part</span>
              <Select value={anchorPart ?? "none"} onValueChange={(v) => setAnchorPart(v === "none" ? null : v)} disabled={isRunning}>
                <SelectTrigger className="h-6 text-[10px] w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Auto</SelectItem>
                  {nodes.map((n) => (
                    <SelectItem key={n.name} value={n.name}>{n.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <Separator />

        {/* ── Tracking ───────────────────────────────────────────────── */}
        <Section title="Tracking" defaultOpen={true}>
          <Check label="Enable tracking" checked={tracking} onChange={setTracking} disabled={isRunning} />

          {tracking && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Method</span>
                <Select value={trackerMethod} onValueChange={(v) => setTrackerMethod(v as typeof trackerMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="simple">Simple</SelectItem>
                    <SelectItem value="flow">Optical Flow</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Similarity</span>
                <Select value={similarityMethod} onValueChange={(v) => setSimilarityMethod(v as typeof similarityMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SIMILARITY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Matching</span>
                <Select value={matchingMethod} onValueChange={(v) => setMatchingMethod(v as typeof matchingMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hungarian">Hungarian</SelectItem>
                    <SelectItem value="greedy">Greedy</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <NumField label="Window size" value={trackingWindowSize}
                onChange={setTrackingWindowSize} min={1} max={100} disabled={isRunning} />

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">Max tracks</span>
                  <Input type="number" value={maxTracks ?? 0}
                    onChange={(e) => setMaxTracks(Number(e.target.value))}
                    min={1} max={100} className="h-6 text-[10px] w-16"
                    disabled={isRunning || noMaxTracks} />
                </div>
                <Check label="No limit" checked={noMaxTracks}
                  onChange={(v) => { setNoMaxTracks(v); if (!v && maxTracks === null) setMaxTracks(2); }}
                  disabled={isRunning} />
              </div>

              <Check label="Connect single-frame track breaks" checked={connectSingleBreaks}
                onChange={setConnectSingleBreaks} disabled={isRunning} />

              {trackerMethod === "flow" && (
                <Section title="Optical Flow">
                  <NumField label="Image scale" value={flowImgScale}
                    onChange={setFlowImgScale} min={0.1} max={2} step={0.1} disabled={isRunning} />
                  <NumField label="Window size" value={flowWindowSize}
                    onChange={setFlowWindowSize} min={3} max={99} step={2} disabled={isRunning} />
                  <NumField label="Max pyramid levels" value={flowMaxLevels}
                    onChange={setFlowMaxLevels} min={1} max={10} disabled={isRunning} />
                </Section>
              )}
            </>
          )}
        </Section>

        <Separator />

        {/* ── Advanced ────────────────────────────────────────────────── */}
        <Section title="Advanced">
          {/* Integral refinement */}
          <Check label="Integral refinement" checked={integralRefinement}
            onChange={setIntegralRefinement} disabled={isRunning} />
          {integralRefinement && (
            <NumField label="Patch size" value={integralPatchSize}
              onChange={setIntegralPatchSize} min={3} max={15} step={2} disabled={isRunning} />
          )}

          {/* Bottom-up PAF params */}
          {isBottomUp && (
            <>
              <Separator className="my-1" />
              <span className="text-[10px] font-medium text-muted-foreground">PAF Matching</span>
              <NumField label="Sample points" value={nPoints}
                onChange={setNPoints} min={1} max={50} disabled={isRunning} />
              <NumField label="Max edge length ratio" value={maxEdgeLengthRatio}
                onChange={setMaxEdgeLengthRatio} min={0} max={1} step={0.05} disabled={isRunning} />
              <NumField label="Distance penalty" value={distPenaltyWeight}
                onChange={setDistPenaltyWeight} min={0} max={10} step={0.1} disabled={isRunning} />
              <NumField label="Min line scores" value={minLineScores}
                onChange={setMinLineScores} min={-1} max={1} step={0.05} disabled={isRunning} />
            </>
          )}

          {/* Filter overlapping */}
          <Separator className="my-1" />
          <Check label="Filter overlapping instances" checked={filterOverlapping}
            onChange={setFilterOverlapping} disabled={isRunning} />
          {filterOverlapping && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">Method</span>
                <Select value={filterMethod} onValueChange={(v) => setFilterMethod(v as typeof filterMethod)} disabled={isRunning}>
                  <SelectTrigger className="h-6 text-[10px] w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iou">IoU</SelectItem>
                    <SelectItem value="oks">OKS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <NumField label="Threshold" value={filterThreshold}
                onChange={setFilterThreshold} min={0} max={1} step={0.05} disabled={isRunning} />
            </>
          )}
        </Section>

        <Separator />

        {/* ── Run ────────────────────────────────────────────────────── */}
        <Button className="w-full h-8 text-xs" onClick={handleRunInference} disabled={!canRun}>
          <Play className="h-3.5 w-3.5 mr-1.5" /> Run Inference
        </Button>
      </div>
    </div>
  );
}
