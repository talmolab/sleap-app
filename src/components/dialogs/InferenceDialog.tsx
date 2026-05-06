/**
 * Inference / prediction dialog.
 *
 * Configures and submits real inference jobs via sleap-nn.
 * Requires the sleap-nn backend tool to be installed.
 */

import { useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useEnvironmentStore } from "../../stores/environmentStore";
import { useInferenceStore } from "../../stores/inferenceStore";
import type { InferenceConfig } from "@/stores/inferenceStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";

type FrameRange = "all_videos" | "suggestions" | "custom";
type TrackingMethod = "simple" | "flow" | "identity";

const TRACKING_LABELS: Record<TrackingMethod, string> = {
  simple: "Simple (greedy matching)",
  flow: "Optical Flow",
  identity: "Identity (re-ID network)",
};

export function InferenceDialog() {
  const open = useAppStore((s) => s.inferenceDialogOpen);
  const setOpen = useAppStore((s) => s.setInferenceDialogOpen);
  const labels = useAppStore((s) => s.labels);

  const pythonCheck = useEnvironmentStore((s) => s.pythonCheck);
  const inferenceStatus = useInferenceStore((s) => s.status);
  const startInference = useInferenceStore((s) => s.startInference);

  const [modelPath, setModelPath] = useState("");
  const [selectedVideo, setSelectedVideo] = useState("all");
  const [frameRange, setFrameRange] = useState<FrameRange>("all_videos");
  const [frameStart, setFrameStart] = useState("0");
  const [frameEnd, setFrameEnd] = useState("1000");
  const [trackingMethod, setTrackingMethod] =
    useState<TrackingMethod>("simple");
  const [maxInstances, setMaxInstances] = useState("2");

  const videos = labels?.videos ?? [];

  const sleapNnAvailable = !!(pythonCheck?.sleapNnVersion);
  const isRunning = inferenceStatus === "running";
  const canRun = sleapNnAvailable && !isRunning && modelPath.trim().length > 0;

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
      // User cancelled or not in Tauri
    }
  };

  const handleRunInference = async () => {
    const config: InferenceConfig = {
      pipeline: "top-down",
      modelPaths: [modelPath.trim()],
      videoIndex: selectedVideo === "all" ? "all" : Number(selectedVideo),
      frameRange:
        frameRange === "custom"
          ? { start: Number(frameStart), end: Number(frameEnd) }
          : frameRange,
      sampleCount: 20,
      excludeUserLabeled: false,
      batchSize: 4,
      device: "auto",
      maxInstances: Number(maxInstances),
      peakThreshold: 0.2,
      anchorPart: null,
      integralRefinement: true,
      integralPatchSize: 5,
      nPoints: 10,
      maxEdgeLengthRatio: 0.25,
      distPenaltyWeight: 1.0,
      minLineScores: 0.25,
      tracking: true,
      trackerMethod: trackingMethod as "simple" | "flow",
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

    setOpen(false);
    await startInference(config);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run Inference</DialogTitle>
          <DialogDescription>
            Configure and run pose estimation inference on video frames.
            Requires trained models and the sleap-nn backend.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Environment warning */}
          {!sleapNnAvailable && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              <p className="font-medium">sleap-nn not detected</p>
              <p className="mt-0.5 text-xs">
                Install sleap-nn via the Environment panel before running
                inference.
              </p>
            </div>
          )}

          {/* Model Directory */}
          <div className="space-y-2">
            <Label>Model Directory</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Path to trained model directory"
                value={modelPath}
                onChange={(e) => setModelPath(e.target.value)}
                className="flex-1"
              />
              <Button variant="outline" onClick={handleBrowseModel}>
                Browse
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Select a directory containing a trained sleap-nn model.
            </p>
          </div>

          <Separator />

          {/* Video Selection */}
          <div className="space-y-2">
            <Label>Video</Label>
            <Select value={selectedVideo} onValueChange={setSelectedVideo}>
              <SelectTrigger className="w-full">
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
          <div className="space-y-2">
            <Label>Frame Range</Label>
            <Select
              value={frameRange}
              onValueChange={(v) => setFrameRange(v as FrameRange)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All frames</SelectItem>
                <SelectItem value="labeled">Labeled frames only</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {frameRange === "custom" && (
              <div className="flex items-center gap-2 mt-2">
                <Input
                  type="number"
                  min={0}
                  placeholder="Start"
                  value={frameStart}
                  onChange={(e) => setFrameStart(e.target.value)}
                  className="flex-1"
                />
                <span className="text-sm text-muted-foreground">to</span>
                <Input
                  type="number"
                  min={0}
                  placeholder="End"
                  value={frameEnd}
                  onChange={(e) => setFrameEnd(e.target.value)}
                  className="flex-1"
                />
              </div>
            )}
          </div>

          <Separator />

          {/* Tracking */}
          <div className="space-y-2">
            <Label>Tracking Method</Label>
            <Select
              value={trackingMethod}
              onValueChange={(v) => setTrackingMethod(v as TrackingMethod)}
            >
              <SelectTrigger className="w-full">
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
          <div className="space-y-2">
            <Label>Max Instances per Frame</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={maxInstances}
              onChange={(e) => setMaxInstances(e.target.value)}
            />
          </div>
        </div>

        <Separator />

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleRunInference} disabled={!canRun}>
            {isRunning ? "Running..." : "Run Inference"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
