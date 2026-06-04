/**
 * Instances panel: lists instances on the current labeled frame.
 *
 * Shows track name, predicted status, visible node count, score,
 * and a color indicator matching the instance's palette color.
 * When an instance is selected, shows a detail panel with metadata
 * and copyable Python points.
 * Supports multi-select via Shift+click (range) and Cmd/Ctrl+click (toggle).
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Clipboard, Check } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { rgbToCSS, getInstanceColor } from "../../lib/colorPalettes";
import {
  commandContext,
  AddInstance,
  DeleteSelectedInstance,
} from "../../commands";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { Instance, Labels } from "../../types";

function isPredicted(instance: Instance): instance is PredictedInstance {
  return instance instanceof PredictedInstance;
}

function formatPointsAsPython(instance: Instance | PredictedInstance): string {
  const rows = instance.points.map((pt) => {
    if (!pt.visible) return "  [np.nan, np.nan]";
    return `  [${pt.xy[0].toFixed(1)}, ${pt.xy[1].toFixed(1)}]`;
  });
  return `np.array([\n${rows.join(",\n")}\n])`;
}

function InstanceRow({
  instance,
  index,
  isSelected,
  onSelect,
  palette,
  labels,
  distinctlyColor,
  colorPredicted,
}: {
  instance: Instance | PredictedInstance;
  index: number;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  palette: string;
  labels: Labels | null;
  distinctlyColor: string;
  colorPredicted: boolean;
}) {
  const predicted = isPredicted(instance);
  const color = getInstanceColor(
    palette,
    distinctlyColor,
    index,
    instance.track,
    labels?.tracks ?? [],
    predicted,
    colorPredicted,
  );
  const trackName = instance.track?.name ?? "[no track]";
  const visibleNodes = instance.nVisible;
  const totalNodes = instance.points.length;
  const score = predicted ? (instance as PredictedInstance).score : null;

  return (
    <TableRow
      onClick={onSelect}
      className={cn(
        "cursor-pointer border-b-0",
        isSelected
          ? "bg-orange-500/10 border-l-2 border-l-orange-500 text-foreground"
          : "hover:bg-muted/50 text-foreground",
      )}
    >
      <TableCell className="py-0.5 px-2">
        <div
          className="w-3 h-3 rounded-sm"
          style={{ backgroundColor: rgbToCSS(color) }}
        />
      </TableCell>
      <TableCell className="py-0.5 px-2 text-xs">{trackName}</TableCell>
      <TableCell className="py-0.5 px-2 text-xs">
        <Badge
          variant={predicted ? "secondary" : "outline"}
          className="text-[10px] px-1.5 py-0"
        >
          {predicted ? "pred" : "user"}
        </Badge>
      </TableCell>
      <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums">
        {visibleNodes}/{totalNodes}
      </TableCell>
      <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums text-muted-foreground">
        {score !== null ? score.toFixed(2) : "--"}
      </TableCell>
    </TableRow>
  );
}

function InstanceDetailPanel({
  instance,
}: {
  instance: Instance | PredictedInstance;
}) {
  const [copied, setCopied] = useState(false);
  const predicted = isPredicted(instance);
  const trackName = instance.track?.name ?? "Untracked";
  const visibleNodes = instance.nVisible;
  const totalNodes = instance.points.length;
  const score = predicted ? (instance as PredictedInstance).score : null;
  const pointsStr = formatPointsAsPython(instance);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(pointsStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="px-2 py-1.5 space-y-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          <span className="text-foreground">{trackName}</span>
        </span>
        <span>
          {predicted ? "Predicted" : "User"}
          {score !== null && ` (${score.toFixed(2)})`}
        </span>
        <span>
          Nodes: {visibleNodes}/{totalNodes}
        </span>
      </div>
      <div className="relative">
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1 h-6 w-6"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Clipboard className="h-3 w-3" />
          )}
        </Button>
        <ScrollArea className="max-h-32">
          <pre className="text-[10px] leading-tight font-mono bg-muted/50 rounded p-2 pr-8">
            {pointsStr}
          </pre>
        </ScrollArea>
      </div>
    </div>
  );
}

export function InstancesPanel() {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const currentInstance = useAppStore((s) => s.instance);
  const setInstance = useAppStore((s) => s.setInstance);
  // Instances require a skeleton with at least one node; a node-less skeleton
  // would yield a null instance. Re-evaluates when the node count changes
  // (skeleton commands bump overlayVersion, which notifies this selector).
  const skeletonHasNodes = useAppStore((s) => (s.skeleton?.nodes?.length ?? 0) > 0);
  const palette = useAppStore((s) => s.palette);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const colorPredicted = useAppStore((s) => s.colorPredicted);

  // Local multi-select state
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    new Set(),
  );
  const lastClickedRef = useRef<number | null>(null);

  // Find the labeled frame for current video + frame
  const labeledFrames =
    labels && video ? labels.find({ video, frameIdx }) : [];
  const labeledFrame = labeledFrames.length > 0 ? labeledFrames[0] : null;
  const instances = labeledFrame?.instances ?? [];

  // Derive the selected index from the store's currentInstance
  const currentIndex = currentInstance
    ? instances.indexOf(currentInstance)
    : -1;

  // Sync local selection when store's instance changes externally
  // (e.g. from canvas click or keyboard shortcut)
  useEffect(() => {
    if (currentIndex >= 0) {
      setSelectedIndices((prev) => {
        if (prev.size === 1 && prev.has(currentIndex)) return prev;
        return new Set([currentIndex]);
      });
    } else {
      setSelectedIndices((prev) => {
        if (prev.size === 0) return prev;
        return new Set();
      });
    }
  }, [currentIndex]);

  // Clear selection on frame change
  useEffect(() => {
    setSelectedIndices(new Set());
    lastClickedRef.current = null;
  }, [frameIdx, video]);

  const handleSelect = useCallback(
    (index: number, e: React.MouseEvent) => {
      const instance = instances[index];
      if (!instance) return;

      if (e.shiftKey && lastClickedRef.current !== null) {
        // Shift+click: select range from last clicked to current
        const start = Math.min(lastClickedRef.current, index);
        const end = Math.max(lastClickedRef.current, index);
        const newIndices = new Set(selectedIndices);
        for (let i = start; i <= end; i++) newIndices.add(i);
        setSelectedIndices(newIndices);
        setInstance(instance);
      } else if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+click: toggle individual instance
        const newIndices = new Set(selectedIndices);
        if (newIndices.has(index)) {
          newIndices.delete(index);
          if (newIndices.size > 0) {
            const last = [...newIndices].pop()!;
            setInstance(instances[last]);
          } else {
            setInstance(null);
          }
        } else {
          newIndices.add(index);
          setInstance(instance);
        }
        setSelectedIndices(newIndices);
      } else {
        // Plain click: single select
        setSelectedIndices(new Set([index]));
        setInstance(instance);
      }
      lastClickedRef.current = index;
    },
    [instances, selectedIndices, setInstance],
  );

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        {instances.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No instances on this frame.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="py-1 px-2 text-xs font-normal w-6 h-auto" />
                <TableHead className="py-1 px-2 text-xs font-normal h-auto">
                  Track
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal h-auto">
                  Type
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal text-right h-auto">
                  Nodes
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal text-right h-auto">
                  Score
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.map((inst, i) => (
                <InstanceRow
                  key={i}
                  instance={inst}
                  index={i}
                  isSelected={selectedIndices.has(i)}
                  onSelect={(e) => handleSelect(i, e)}
                  palette={palette}
                  labels={labels}
                  distinctlyColor={distinctlyColor}
                  colorPredicted={colorPredicted}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>

      {currentInstance && (
        <>
          <Separator />
          <InstanceDetailPanel instance={currentInstance} />
        </>
      )}

      <Separator />
      <div className="flex gap-1 p-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapper span keeps the tooltip hoverable when the button is
                  disabled (disabled buttons don't emit pointer events). */}
              <span className="inline-flex">
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={!skeletonHasNodes}
                  onClick={() => commandContext.execute(AddInstance)}
                >
                  Add Instance
                </Button>
              </span>
            </TooltipTrigger>
            {!skeletonHasNodes && (
              <TooltipContent side="top">
                <p>Add a node to the skeleton first</p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        <Button
          variant="subtle"
          size="xs"
          onClick={() => commandContext.execute(DeleteSelectedInstance)}
        >
          Delete Instance
        </Button>
      </div>
    </div>
  );
}
