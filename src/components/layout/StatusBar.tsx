/**
 * Bottom status bar showing current state information.
 * Includes UI scale controls on the right side.
 */

import { useMemo } from "react";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Crosshair, Hand, Minus, MousePointer2, Pencil, Plus } from "lucide-react";
import { isTauri } from "../../platform/index";
import { computeStatusStats, instancesToShowCount } from "@/lib/statusStats";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";

export function StatusBar() {
  const filename = useAppStore((s) => s.filename);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const video = useAppStore((s) => s.video);
  const videoRevision = useAppStore((s) => s.videoRevision);
  const labels = useAppStore((s) => s.labels);
  const hasChanges = useAppStore((s) => s.hasChanges);
  const instance = useAppStore((s) => s.instance);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  const uiScale = useAppStore((s) => s.uiScale);
  const frameRange = useAppStore((s) => s.frameRange);
  const defaultToPan = useAppStore((s) => s.defaultToPan);
  const labelingMode = useAppStore((s) => s.labelingMode);
  const showInstances = useAppStore((s) => s.showInstances);

  const platformLabel = isTauri ? "Tauri FS" : "Browser";

  // videoRevision dep: a deferred backend opening corrects video.shape[0] to the
  // true source count; re-read it so the status bar shows the real frame total.
  const totalFrames = useMemo(
    () => video?.shape?.[0] ?? null,
    [video, videoRevision]
  );
  const stats = computeStatusStats(labels, video, totalFrames);
  const instanceCount = instancesToShowCount(labeledFrame);
  const hidden = instanceCount > 0 && !showInstances;
  const isNegative = labeledFrame?.isNegative ?? false;
  const isPredicted = instance instanceof PredictedInstance;

  // Display string for the "show instances" shortcut, e.g. "KeyH" -> "H".
  const showInstancesKey = DEFAULT_SHORTCUTS["show instances"].replace(
    /^Key/,
    "",
  );

  const adjustScale = (delta: number) => {
    const newScale = Math.max(0.75, Math.min(1.5, uiScale + delta));
    useAppStore.getState().set("uiScale", Math.round(newScale * 100) / 100);
    document.documentElement.style.setProperty("--ui-scale", String(newScale));
  };

  const resetScale = () => {
    useAppStore.getState().set("uiScale", 1);
    document.documentElement.style.setProperty("--ui-scale", "1");
  };

  return (
    <div className="flex items-center h-7 px-2 text-xs bg-card border-t border-border text-muted-foreground gap-2 shrink-0">
      {/* Left: project info */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {filename ? (
          <>
            <span className="text-foreground truncate">
              {filename}
              {hasChanges ? " *" : ""}
            </span>
            {/* Video index / total. Gate on a valid (>=0) index so a broken/
                missing video reference does not render a misleading "Video 0 / N". */}
            {stats.videoIndex >= 0 && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="tabular-nums whitespace-nowrap">
                  Video {stats.videoIndex + 1} / {stats.totalVideos}
                </span>
              </>
            )}
            <Separator orientation="vertical" className="h-3.5" />
            <button
              type="button"
              title="Go to frame (Ctrl+J)"
              onClick={() => useAppStore.getState().setGoToFrameDialogOpen(true)}
              className="tabular-nums whitespace-nowrap cursor-pointer rounded-sm px-1 -mx-1 hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {/* 0-based frame index (matches the seekbar/overlay convention). */}
              Frame {frameIdx.toLocaleString()}
              {totalFrames !== null ? ` / ${(totalFrames - 1).toLocaleString()}` : ""}
            </button>
            <Separator orientation="vertical" className="h-3.5" />
            <span className="whitespace-nowrap">
              Labeled: {stats.userInVideo.toLocaleString()}
              {stats.totalVideos > 1
                ? ` in video, ${stats.userInProject.toLocaleString()} in project`
                : ""}
            </span>
            {stats.predictedInVideo > 0 && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="whitespace-nowrap">
                  Predicted: {stats.predictedInVideo.toLocaleString()} (
                  {stats.predictedPct.toFixed(2)}%) in video
                </span>
              </>
            )}
            {instanceCount > 0 && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span
                  className={`whitespace-nowrap${hidden ? " text-red-500" : ""}`}
                >
                  {instanceCount} instance{instanceCount !== 1 ? "s" : ""}
                  {hidden
                    ? ` [Hidden] Press '${showInstancesKey}' to toggle.`
                    : ""}
                </span>
              </>
            )}
            {isNegative && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="whitespace-nowrap text-amber-500">
                  [NEGATIVE FRAME]
                </span>
              </>
            )}
            {frameRange && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="whitespace-nowrap">
                  {/* 0-based to stay consistent with the Frame counter above.
                      frameRange stores 0-based inclusive indices. */}
                  Frames {frameRange[0].toLocaleString()}-
                  {frameRange[1].toLocaleString()} selected
                </span>
              </>
            )}
            {instance && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <Badge
                  variant={isPredicted ? "outline" : "default"}
                  className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-normal"
                >
                  {isPredicted ? "Pred" : "User"}
                </Badge>
                <span className="whitespace-nowrap">
                  {instance.track?.name ?? "[no track]"} ({instance.nVisible}/
                  {instance.points.length} nodes)
                  {isPredicted &&
                    ` score=${instance.score.toFixed(3)}`}
                </span>
              </>
            )}
          </>
        ) : (
          <span>No project loaded</span>
        )}
      </div>

      {/* Right: platform indicator, interaction mode + UI scale controls */}
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-normal cursor-default"
              >
                {platformLabel}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>File I/O backend: {platformLabel === "Tauri FS" ? "Native filesystem (Tauri plugins)" : "Browser APIs (File System Access / download)"}</p>
            </TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="h-3.5 mx-0.5" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={defaultToPan ? "secondary" : "ghost"}
                size="icon"
                className="h-5 w-5"
                onClick={() => useAppStore.getState().toggle("defaultToPan")}
              >
                {defaultToPan ? (
                  <Hand className="h-3 w-3" />
                ) : (
                  <MousePointer2 className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{defaultToPan ? "Pan mode (P to switch to Select)" : "Select mode (P to switch to Pan)"}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={labelingMode === "place" ? "secondary" : "ghost"}
                size="icon"
                className="h-5 w-5"
                disabled={!instance}
                onClick={() => {
                  const s = useAppStore.getState();
                  if (s.labelingMode === "place") {
                    s.exitPlacementMode();
                  } else if (s.instance) {
                    s.enterPlacementMode();
                  }
                }}
              >
                {labelingMode === "place" ? (
                  <Crosshair className="h-3 w-3" />
                ) : (
                  <Pencil className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{labelingMode === "place" ? "Place mode (N to switch to Select)" : "Select mode (N to switch to Place)"}</p>
            </TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="h-3.5 mr-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => adjustScale(-0.05)}
              >
                <Minus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Decrease text size</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-[10px] tabular-nums"
                onClick={resetScale}
              >
                {Math.round(uiScale * 100)}%
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Reset text size</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => adjustScale(0.05)}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Increase text size</p></TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}
