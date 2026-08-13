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
import { Clipboard, Check, Eye, Focus, Ghost } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { rgbToCSS, getInstanceColor } from "../../lib/colorPalettes";
import { instanceShowsNonVisible } from "@/lib/instanceVisibility";
import {
  commandContext,
  AddInstance,
  DeleteSelectedInstance,
  AddInstancesFromAllPredictions,
  SetTrackName,
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
import { instanceNamedPoints } from "@/lib/instancePoints";
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

/** Compact icon column header with a hover tooltip (the panel is narrow). */
function IconHeader({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <TableHead className="py-1 px-1 text-center w-8 h-auto">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex justify-center">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="sr-only">{label}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </TableHead>
  );
}

/**
 * One per-instance visibility checkbox cell. Stops click propagation so
 * toggling a box never also selects the row. Muted (but still clickable) when
 * `muted` is set (view-only greying); disabled in non-manual QC modes.
 */
function VisibilityCheckbox({
  label,
  checked,
  disabled,
  muted,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  muted?: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <TableCell
      className={cn("py-0.5 px-1 text-center", muted && "opacity-40")}
      // A native title= on a disabled <input> isn't reliably shown on hover, so
      // the read-only hint lives on the enclosing cell instead.
      title={disabled ? "Set Display: Manual to edit" : undefined}
    >
      <input
        type="checkbox"
        aria-label={label}
        className="h-3.5 w-3.5 cursor-pointer accent-primary align-middle"
        checked={checked}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        onChange={onChange}
      />
    </TableCell>
  );
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
  visibilityChecked,
  viewOnlyChecked,
  invisibleNodesChecked,
  viewOnlyActive,
  readOnly,
  onToggleVisibility,
  onToggleViewOnly,
  onToggleInvisibleNodes,
}: {
  instance: Instance | PredictedInstance;
  index: number;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  palette: string;
  labels: Labels | null;
  distinctlyColor: string;
  colorPredicted: boolean;
  visibilityChecked: boolean;
  viewOnlyChecked: boolean;
  invisibleNodesChecked: boolean;
  viewOnlyActive: boolean;
  readOnly: boolean;
  onToggleVisibility: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleViewOnly: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleInvisibleNodes: (e: React.ChangeEvent<HTMLInputElement>) => void;
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

  // Inline track rename (double-click the name; propagates to all instances).
  const [editingTrack, setEditingTrack] = useState(false);
  const [trackDraft, setTrackDraft] = useState("");
  const canRenameTrack = !!instance.track && !readOnly;
  const commitTrackName = () => {
    setEditingTrack(false);
    if (instance.track) {
      commandContext.execute(SetTrackName, {
        track: instance.track,
        name: trackDraft,
      });
    }
  };

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
      <TableCell className="py-0.5 px-2 text-xs">
        {editingTrack ? (
          <input
            autoFocus
            value={trackDraft}
            onChange={(e) => setTrackDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTrackName();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditingTrack(false);
              }
            }}
            onBlur={commitTrackName}
            className="w-full rounded border border-border bg-background px-1 py-0 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              if (!canRenameTrack) return;
              e.stopPropagation();
              setTrackDraft(instance.track?.name ?? "");
              setEditingTrack(true);
            }}
            title={canRenameTrack ? "Double-click to rename track" : undefined}
          >
            {trackName}
          </span>
        )}
      </TableCell>
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
      <VisibilityCheckbox
        label="Visibility"
        checked={visibilityChecked}
        disabled={readOnly}
        muted={viewOnlyActive}
        onChange={onToggleVisibility}
      />
      <VisibilityCheckbox
        label="View Only"
        checked={viewOnlyChecked}
        disabled={readOnly}
        onChange={onToggleViewOnly}
      />
      <VisibilityCheckbox
        label="Invisible Nodes"
        checked={invisibleNodesChecked}
        disabled={readOnly}
        onChange={onToggleInvisibleNodes}
      />
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
  // Copy payload stays the plain np.array([...]); the on-screen list below is a
  // human-readable node-name view only (names never enter the clipboard).
  const pointsStr = formatPointsAsPython(instance);
  const namedPoints = instanceNamedPoints(instance);

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
          className="absolute top-1 right-1 h-6 w-6 z-10"
          onClick={handleCopy}
          title="Copy points as np.array"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Clipboard className="h-3 w-3" />
          )}
        </Button>
        {/* Readable named list (node name + coords). Must stay inside a
            max-h + overflow-auto box so many-node skeletons scroll here rather
            than pushing the Add/Delete/Accept buttons off-screen. */}
        <div className="text-[10px] leading-tight font-mono bg-muted/50 rounded p-2 pr-8 max-h-32 overflow-auto">
          {namedPoints.map((pt, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto] gap-x-3 whitespace-nowrap"
            >
              {/* Node name white; coords green when visible, "not visible" red
                  — same red/green as the Frames tab (text-red-500/green-500). */}
              <span className="text-foreground truncate">{pt.name}</span>
              <span
                className={cn(
                  "tabular-nums text-right",
                  pt.visible ? "text-green-500" : "text-red-500",
                )}
              >
                {pt.visible
                  ? `${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}`
                  : "not visible"}
              </span>
            </div>
          ))}
        </div>
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

  // Per-instance visibility state + actions (Task 5). These live in the store
  // keyed by instance object identity and are read/written here; the overlay
  // renderer applies them elsewhere.
  const hiddenInstances = useAppStore((s) => s.hiddenInstances);
  const viewOnlyInstance = useAppStore((s) => s.viewOnlyInstance);
  const showNonVisibleOverride = useAppStore((s) => s.showNonVisibleOverride);
  const showNonVisibleNodes = useAppStore((s) => s.showNonVisibleNodes);
  const qcDisplayMode = useAppStore((s) => s.qcDisplayMode);
  const setInstanceHidden = useAppStore((s) => s.setInstanceHidden);
  const setViewOnlyInstance = useAppStore((s) => s.setViewOnlyInstance);
  const setInstanceInvisibleOverride = useAppStore(
    (s) => s.setInstanceInvisibleOverride,
  );
  // The QC mode owns this state programmatically; only "manual" allows editing.
  const visibilityReadOnly = qcDisplayMode !== "manual";

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
  const hasPredictions = instances.some(isPredicted);

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
      // Zoom/pan the canvas viewport to fit the clicked instance. No-op in
      // VideoPlayer if the current selection has no visible points; harmless
      // when a Cmd/Ctrl+click cleared the selection.
      useAppStore.getState().set("fitSelection", true);
    },
    [instances, selectedIndices, setInstance],
  );

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1 min-h-0">
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
                <IconHeader icon={Eye} label="Visibility" />
                <IconHeader icon={Focus} label="View Only" />
                <IconHeader icon={Ghost} label="Invisible Nodes" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.map((inst, i) => {
                const visibilityChecked =
                  !hiddenInstances.has(inst) &&
                  (!viewOnlyInstance || viewOnlyInstance === inst);
                return (
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
                    visibilityChecked={visibilityChecked}
                    viewOnlyChecked={viewOnlyInstance === inst}
                    invisibleNodesChecked={instanceShowsNonVisible(
                      { showNonVisibleOverride },
                      inst,
                      showNonVisibleNodes,
                    )}
                    viewOnlyActive={viewOnlyInstance !== null}
                    readOnly={visibilityReadOnly}
                    onToggleVisibility={(e) =>
                      setInstanceHidden(inst, !e.target.checked)
                    }
                    onToggleViewOnly={() =>
                      setViewOnlyInstance(
                        viewOnlyInstance === inst ? null : inst,
                      )
                    }
                    onToggleInvisibleNodes={(e) =>
                      setInstanceInvisibleOverride(inst, e.target.checked)
                    }
                  />
                );
              })}
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
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapper span keeps the tooltip hoverable while disabled. */}
              <span className="inline-flex">
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={!hasPredictions}
                  onClick={() =>
                    commandContext.execute(AddInstancesFromAllPredictions)
                  }
                >
                  Accept Predictions
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                {hasPredictions
                  ? "Convert all predictions on this frame to editable user instances"
                  : "No predictions on this frame"}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
