/**
 * Inference panel for configuring and running sleap-nn predictions.
 *
 * Combines model configuration, job control, and progress monitoring
 * in a single sidebar panel.
 */

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useEnvironmentStore } from "../../stores/environmentStore";
import { useInferenceStore } from "../../stores/inferenceStore";
import type { InferenceConfig } from "@/stores/inferenceStore";
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
} from "lucide-react";

type FrameRange = "all" | "labeled" | "custom";
type TrackingMethod = "simple" | "flow" | "identity";

const TRACKING_LABELS: Record<TrackingMethod, string> = {
  simple: "Simple (greedy)",
  flow: "Optical Flow",
  identity: "Identity (re-ID)",
};

export function InferencePanel() {
  const labels = useAppStore((s) => s.labels);
  const tools = useEnvironmentStore((s) => s.tools);
  const inferenceStatus = useInferenceStore((s) => s.status);
  const progress = useInferenceStore((s) => s.progress);
  const log = useInferenceStore((s) => s.log);
  const error = useInferenceStore((s) => s.error);
  const outputPath = useInferenceStore((s) => s.outputPath);
  const startInference = useInferenceStore((s) => s.startInference);
  const cancelInference = useInferenceStore((s) => s.cancelInference);
  const loadAndMergeResults = useInferenceStore((s) => s.loadAndMergeResults);
  const reset = useInferenceStore((s) => s.reset);

  const [modelPath, setModelPath] = useState("");
  const [selectedVideo, setSelectedVideo] = useState("all");
  const [frameRange, setFrameRange] = useState<FrameRange>("all");
  const [frameStart, setFrameStart] = useState("0");
  const [frameEnd, setFrameEnd] = useState("1000");
  const [trackingMethod, setTrackingMethod] =
    useState<TrackingMethod>("simple");
  const [maxInstances, setMaxInstances] = useState("2");
  const [logExpanded, setLogExpanded] = useState(false);
  const [merging, setMerging] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const videos = labels?.videos ?? [];
  const sleapNnAvailable = tools.some(
    (t) => t.name === "sleap-nn" || t.commands?.includes("sleap-nn")
  );
  const isRunning = inferenceStatus === "running";
  const isDone =
    inferenceStatus === "completed" ||
    inferenceStatus === "error" ||
    inferenceStatus === "cancelled";
  const canRun =
    sleapNnAvailable && !isRunning && !isDone && modelPath.trim().length > 0;

  // Auto-scroll log
  useEffect(() => {
    if (logExpanded && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, logExpanded]);

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <p className="text-xs text-muted-foreground">
          Inference is only available in the desktop app.
        </p>
      </div>
    );
  }

  const handleBrowseModel = async () => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await tauriOpen({
        directory: true,
        title: "Select Model Directory",
      });
      if (selected) {
        setModelPath(selected as string);
      }
    } catch {
      // User cancelled
    }
  };

  const handleRunInference = async () => {
    const config: InferenceConfig = {
      modelPath: modelPath.trim(),
      videoIndex: selectedVideo === "all" ? "all" : Number(selectedVideo),
      frameRange:
        frameRange === "custom"
          ? { start: Number(frameStart), end: Number(frameEnd) }
          : frameRange,
      trackingMethod,
      maxInstances: Number(maxInstances),
    };
    await startInference(config);
  };

  const pct =
    progress && progress.nTotal > 0
      ? (progress.nProcessed / progress.nTotal) * 100
      : 0;

  return (
    <div className="flex flex-col gap-3 -m-2">
      {/* ── Status / Progress ──────────────────────────────────────────── */}
      {(isRunning || isDone) && (
        <>
          <div className="px-3 pt-3 space-y-2">
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
            </div>

            {/* Progress bar */}
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
                    : "Waiting..."}
                </span>
                <span>{pct > 0 ? `${pct.toFixed(1)}%` : ""}</span>
              </div>
            </div>

            {/* Stats */}
            {progress && progress.rate > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {progress.rate.toFixed(1)} fps &middot; ETA:{" "}
                {progress.eta > 0
                  ? `${Math.floor(progress.eta / 60)}m ${Math.round(progress.eta % 60)}s`
                  : "0s"}
              </p>
            )}

            {/* Error */}
            {error && (
              <div className="rounded-md bg-destructive/15 border border-destructive/30 px-2 py-1.5 text-[10px] text-destructive">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              {isRunning && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => cancelInference()}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Cancel
                </Button>
              )}
              {inferenceStatus === "completed" && outputPath && (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={async () => {
                    setMerging(true);
                    await loadAndMergeResults();
                    setMerging(false);
                  }}
                  disabled={merging}
                >
                  {merging ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5 mr-1" />
                  )}
                  {merging ? "Loading..." : "Load Results"}
                </Button>
              )}
              {isDone && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => reset()}
                >
                  Dismiss
                </Button>
              )}
            </div>

            {/* Log */}
            {log.length > 0 && (
              <div>
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={() => setLogExpanded((v) => !v)}
                >
                  {logExpanded ? "Hide" : "Show"} log ({log.length} lines)
                </button>
                {logExpanded && (
                  <pre
                    ref={logRef}
                    className="mt-1 max-h-36 overflow-auto rounded border bg-muted p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all"
                  >
                    {log.join("\n")}
                  </pre>
                )}
              </div>
            )}
          </div>
          <Separator />
        </>
      )}

      {/* ── Configuration ──────────────────────────────────────────────── */}
      <div className="px-3 pb-3 space-y-3">
        {/* sleap-nn warning */}
        {!sleapNnAvailable && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-[10px] text-yellow-700 dark:text-yellow-400">
            <p className="font-medium">sleap-nn not detected</p>
            <p className="mt-0.5">
              Install via the Environment panel first.
            </p>
          </div>
        )}

        {/* Model Directory */}
        <div className="space-y-1">
          <Label className="text-xs">Model Directory</Label>
          <div className="flex gap-1">
            <Input
              placeholder="Path to model..."
              value={modelPath}
              onChange={(e) => setModelPath(e.target.value)}
              className="h-7 text-xs flex-1"
              disabled={isRunning}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={handleBrowseModel}
              disabled={isRunning}
              title="Browse"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <Separator />

        {/* Video Selection */}
        <div className="space-y-1">
          <Label className="text-xs">Video</Label>
          <Select
            value={selectedVideo}
            onValueChange={setSelectedVideo}
            disabled={isRunning}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All videos</SelectItem>
              {videos.map((video, i) => (
                <SelectItem key={i} value={String(i)}>
                  {video.filename ??
                    video.backendMetadata?.filename ??
                    `Video ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Frame Range */}
        <div className="space-y-1">
          <Label className="text-xs">Frame Range</Label>
          <Select
            value={frameRange}
            onValueChange={(v) => setFrameRange(v as FrameRange)}
            disabled={isRunning}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All frames</SelectItem>
              <SelectItem value="labeled">Labeled frames only</SelectItem>
              <SelectItem value="custom">Custom range</SelectItem>
            </SelectContent>
          </Select>
          {frameRange === "custom" && (
            <div className="flex items-center gap-1 mt-1">
              <Input
                type="number"
                min={0}
                placeholder="Start"
                value={frameStart}
                onChange={(e) => setFrameStart(e.target.value)}
                className="h-7 text-xs flex-1"
                disabled={isRunning}
              />
              <span className="text-[10px] text-muted-foreground">to</span>
              <Input
                type="number"
                min={0}
                placeholder="End"
                value={frameEnd}
                onChange={(e) => setFrameEnd(e.target.value)}
                className="h-7 text-xs flex-1"
                disabled={isRunning}
              />
            </div>
          )}
        </div>

        <Separator />

        {/* Tracking */}
        <div className="space-y-1">
          <Label className="text-xs">Tracking</Label>
          <Select
            value={trackingMethod}
            onValueChange={(v) => setTrackingMethod(v as TrackingMethod)}
            disabled={isRunning}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.entries(TRACKING_LABELS) as [TrackingMethod, string][]
              ).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Max Instances */}
        <div className="space-y-1">
          <Label className="text-xs">Max Instances</Label>
          <Input
            type="number"
            min={1}
            max={100}
            value={maxInstances}
            onChange={(e) => setMaxInstances(e.target.value)}
            className="h-7 text-xs"
            disabled={isRunning}
          />
        </div>

        <Separator />

        {/* Run button */}
        <Button
          className="w-full h-8 text-xs"
          onClick={handleRunInference}
          disabled={!canRun}
        >
          <Play className="h-3.5 w-3.5 mr-1.5" />
          Run Inference
        </Button>
      </div>
    </div>
  );
}
