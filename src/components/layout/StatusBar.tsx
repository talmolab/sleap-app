/**
 * Bottom status bar showing current state information.
 * Includes UI scale controls on the right side.
 */

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
import { Hand, Minus, MousePointer2, Plus } from "lucide-react";
import { isTauri } from "../../platform/index";

export function StatusBar() {
  const filename = useAppStore((s) => s.filename);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const video = useAppStore((s) => s.video);
  const labels = useAppStore((s) => s.labels);
  const hasChanges = useAppStore((s) => s.hasChanges);
  const instance = useAppStore((s) => s.instance);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  const uiScale = useAppStore((s) => s.uiScale);
  const frameRange = useAppStore((s) => s.frameRange);
  const defaultToPan = useAppStore((s) => s.defaultToPan);

  const platformLabel = isTauri ? "Tauri FS" : "Browser";

  const totalFrames = video?.shape?.[0] ?? null;
  const totalLabeledFrames = labels?.labeledFrames.length ?? 0;
  const totalVideos = labels?.videos.length ?? 0;
  const instanceCount = labeledFrame?.instances.length ?? 0;
  const isPredicted = instance instanceof PredictedInstance;

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
            <Separator orientation="vertical" className="h-3.5" />
            <span className="tabular-nums whitespace-nowrap">
              Frame {frameIdx}
              {totalFrames !== null ? ` / ${totalFrames - 1}` : ""}
            </span>
            <Separator orientation="vertical" className="h-3.5" />
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-normal whitespace-nowrap">
              {totalLabeledFrames} labeled
            </Badge>
            <Separator orientation="vertical" className="h-3.5" />
            <span className="whitespace-nowrap">
              {totalVideos} video{totalVideos !== 1 ? "s" : ""}
            </span>
            {instanceCount > 0 && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="whitespace-nowrap">
                  {instanceCount} instance{instanceCount !== 1 ? "s" : ""}
                </span>
              </>
            )}
            {frameRange && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="whitespace-nowrap">
                  Frames {frameRange[0]}-{frameRange[1]} selected
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
