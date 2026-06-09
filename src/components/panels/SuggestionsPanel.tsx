/**
 * Suggestions panel: lists suggested frames for labeling.
 *
 * Shows video name and frame index for each suggestion with sorting,
 * score display, and configurable generation methods.
 */

import { useState, useMemo, useReducer } from "react";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import { GoNextSuggestion, GoPrevSuggestion } from "../../commands/navCommands";
import {
  suggestionExists,
  addSuggestionFrame,
  removeSuggestionAt,
  labeledSummary,
} from "../../lib/suggestionEdits";
import { toast } from "@/lib/notify";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { SuggestionFrame, Video } from "../../types";
import {
  generateSuggestionFrames,
  type GenerationMethod,
  type GenerateParams,
} from "../../lib/suggestionStrategies";

/** Extract just the basename from a file path. */
function basename(path: string | string[]): string {
  const p = Array.isArray(path) ? path[0] ?? "" : path;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

type SortColumn = "index" | "video" | "frame" | "score";
type SortDir = "asc" | "desc";

/**
 * Mean prediction *instance* score for a frame.
 *
 * Uses `PredictedInstance.score` (SLEAP's instance/grouping score) — the SAME
 * metric the Frames panel shows (`FramesPanel.tsx`) and that the
 * `prediction_score` generation method filters on (`lib/suggestionStrategies`).
 * This keeps the Score column consistent across panels and meaningful for the
 * prediction-score workflow.
 *
 * NOTE: instance scores are NOT bounded to [0, 1] and are distinct from
 * per-point confidence. A frame can have a high mean here yet still contain a
 * single low-score instance — which is exactly what makes it a prediction_score
 * suggestion (the method counts instances below the limit, not the frame mean).
 */
function computeFrameScore(
  suggestion: SuggestionFrame,
  labels: { find: (opts: { video: Video; frameIdx: number }) => { instances: { score?: number }[] }[] } | null
): number | null {
  if (!labels) return null;

  const frames = labels.find({
    video: suggestion.video,
    frameIdx: suggestion.frameIdx,
  });
  if (frames.length === 0) return null;

  const predicted = frames[0].instances.filter(
    (inst) => inst instanceof PredictedInstance
  );
  if (predicted.length === 0) return null;

  let total = 0;
  let count = 0;
  for (const inst of predicted) {
    if (typeof inst.score === "number" && !isNaN(inst.score)) {
      total += inst.score;
      count++;
    }
  }

  return count > 0 ? total / count : null;
}

/** Check if a frame has user-labeled instances. */
function hasUserLabels(
  suggestion: SuggestionFrame,
  labels: { find: (opts: { video: Video; frameIdx: number }) => { instances: { skeleton: unknown }[] }[] } | null
): boolean {
  if (!labels) return false;

  const frames = labels.find({
    video: suggestion.video,
    frameIdx: suggestion.frameIdx,
  });
  if (frames.length === 0) return false;

  return frames[0].instances.some(
    (inst) => !(inst instanceof PredictedInstance)
  );
}

/** Target video set for generation: all videos or just the current one. */
type GenerationTarget = "all" | "current";

/** Human labels for the method <Select> (keys are GenerationMethod values). */
const METHOD_LABELS: Record<GenerationMethod, string> = {
  stride: "Stride",
  random: "Random",
  frame_chunk: "Frame chunk",
  prediction_score: "Prediction score",
  velocity: "Velocity",
  max_displacement: "Max displacement",
};

/** Parse a positive-int input value, falling back to the previous value. */
function parseIntInput(raw: string, prev: number): number {
  const v = parseInt(raw, 10);
  return Number.isNaN(v) ? prev : v;
}

/** Props for {@link SuggestionsPanel}. */
export interface SuggestionsPanelProps {
  /**
   * Initial generation method. Production callers omit this (defaults to
   * "stride"); it exists as a test seam so the render test can mount directly
   * into a non-default method without driving the Radix <Select> popover, which
   * is unreliable in happy-dom.
   */
  initialMethod?: GenerationMethod;
}

export function SuggestionsPanel({
  initialMethod = "stride",
}: SuggestionsPanelProps = {}) {
  const labels = useAppStore((s) => s.labels);
  const currentVideo = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const skeleton = useAppStore((s) => s.skeleton);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  // THE "underlying labels/instances changed" signal (bumped on canvas label
  // edits). Subscribing here re-renders the panel when frames are labeled
  // elsewhere; see Seekbar.tsx for the same pattern.
  const overlayVersion = useAppStore((s) => s.overlayVersion);

  // --- Generation method + per-method params (PyQt defaults) ---
  const [method, setMethod] = useState<GenerationMethod>(initialMethod);
  // stride/random per-video count.
  const [perVideo, setPerVideo] = useState(20);
  // frame_chunk bounds (1-based).
  const [chunkFrom, setChunkFrom] = useState(1);
  const [chunkTo, setChunkTo] = useState(1000);
  // prediction_score params.
  const [scoreLimit, setScoreLimit] = useState(3);
  const [instanceLimitLower, setInstanceLimitLower] = useState(1);
  const [instanceLimitUpper, setInstanceLimitUpper] = useState(2);
  // velocity params.
  const [velocityNodeIdx, setVelocityNodeIdx] = useState(0);
  const [velocityThreshold, setVelocityThreshold] = useState(0.1);
  // max_displacement param.
  const [displacementThreshold, setDisplacementThreshold] = useState(10);
  // Target (all videos vs current) + optional global frame-range restriction.
  const [target, setTarget] = useState<GenerationTarget>("all");
  const [frameRangeEnabled, setFrameRangeEnabled] = useState(false);
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(1000);

  const [sortCol, setSortCol] = useState<SortColumn>("index");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // markChanged() does not re-render this panel (it doesn't subscribe to
  // hasChanges), so panel-initiated suggestion edits force a re-render here.
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  // Index into labels.suggestions of the currently selected row (null = none).
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const suggestions = labels?.suggestions ?? [];

  // Compute scores and sort
  const sortedSuggestions = useMemo(() => {
    // Build data with indices and scores
    const withMeta = suggestions.map((s, i) => ({
      suggestion: s,
      originalIndex: i,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      score: computeFrameScore(s, labels as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hasLabels: hasUserLabels(s, labels as any),
    }));

    // Sort
    withMeta.sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case "index":
          cmp = a.originalIndex - b.originalIndex;
          break;
        case "video":
          cmp = basename(a.suggestion.video.filename).localeCompare(
            basename(b.suggestion.video.filename)
          );
          break;
        case "frame":
          cmp = a.suggestion.frameIdx - b.suggestion.frameIdx;
          break;
        case "score": {
          const sa = a.score ?? -Infinity;
          const sb = b.score ?? -Infinity;
          cmp = sa - sb;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return withMeta;
    // overlayVersion is in the deps so hasLabels/score (and thus the % status
    // line + green dot) recompute when frames are labeled — labels is mutated
    // in place, so its reference alone won't trigger a recompute (cf. Seekbar).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, sortCol, sortDir, labels, overlayVersion]);

  const navigateToSuggestion = (suggestion: SuggestionFrame) => {
    if (suggestion.video !== currentVideo) {
      setVideo(suggestion.video);
    }
    setFrameIdx(suggestion.frameIdx);
  };

  /** Replace labels.suggestions, mark dirty, and force a re-render. */
  const applySuggestions = (next: SuggestionFrame[]) => {
    if (!labels) return;
    labels.suggestions = next;
    useAppStore.getState().markChanged();
    forceUpdate();
  };

  const addCurrentFrame = () => {
    if (!labels || !currentVideo) return;
    if (suggestionExists(labels.suggestions, currentVideo, frameIdx)) {
      toast.info("This frame is already a suggestion");
      return;
    }
    applySuggestions(
      addSuggestionFrame(labels.suggestions, currentVideo, frameIdx)
    );
    toast.success("Added current frame as a suggestion");
  };

  const removeSelected = () => {
    if (!labels || selectedIdx === null) return;
    applySuggestions(removeSuggestionAt(labels.suggestions, selectedIdx));
    setSelectedIdx(null);
  };

  /**
   * Build GenerateParams from the current panel state, run the selected
   * strategy, and REPLACE labels.suggestions with the result (via the #159
   * applySuggestions helper). Pure dispatch — algorithm lives in
   * lib/suggestionStrategies.
   */
  const handleGenerate = () => {
    if (!labels) return;
    const videos =
      target === "current" && currentVideo
        ? [currentVideo]
        : labels.videos ?? [];
    const params: GenerateParams = {
      method,
      videos,
      perVideo,
      frameFrom: chunkFrom,
      frameTo: chunkTo,
      scoreLimit,
      instanceLimitLower,
      instanceLimitUpper,
      nodeIdx: velocityNodeIdx,
      threshold: velocityThreshold,
      displacementThreshold,
      frameRange: {
        enabled: frameRangeEnabled,
        frameFrom: rangeFrom,
        frameTo: rangeTo,
      },
    };
    const next = generateSuggestionFrames(labels, params);
    applySuggestions(next);
    setSelectedIdx(null);
    toast.success(`Generated ${next.length} suggestion(s)`);
  };

  // % labeled across the (filtered/sorted) suggestion list.
  const summary = labeledSummary(sortedSuggestions.map((e) => e.hasLabels));

  const toggleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const sortIndicator = (col: SortColumn) => {
    if (sortCol !== col) return null;
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  };

  return (
    <div className="flex flex-col h-full">
      {/* Generation controls */}
      <div className="px-2 py-1.5 border-b border-border space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs shrink-0">
            {suggestions.length} suggestion
            {suggestions.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            value={method}
            onValueChange={(v) => setMethod(v as GenerationMethod)}
          >
            <SelectTrigger
              className="h-7 text-xs flex-1"
              size="sm"
              aria-label="Generation method"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stride">{METHOD_LABELS.stride}</SelectItem>
              <SelectItem value="random">{METHOD_LABELS.random}</SelectItem>
              <SelectItem value="frame_chunk">
                {METHOD_LABELS.frame_chunk}
              </SelectItem>
              <SelectItem value="prediction_score">
                {METHOD_LABELS.prediction_score}
              </SelectItem>
              <SelectItem value="velocity">{METHOD_LABELS.velocity}</SelectItem>
              <SelectItem value="max_displacement">
                {METHOD_LABELS.max_displacement}
              </SelectItem>
              <SelectItem value="image_features" disabled>
                Image Features
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Per-method parameters */}
        {(method === "stride" || method === "random") && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground shrink-0">
              Per video
            </span>
            <Input
              type="number"
              min={1}
              max={10000}
              value={perVideo}
              onChange={(e) =>
                setPerVideo(Math.max(1, parseIntInput(e.target.value, perVideo)))
              }
              className="h-7 w-16 text-xs"
              aria-label="Per video"
            />
          </div>
        )}

        {method === "frame_chunk" && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0">
                From
              </span>
              <Input
                type="number"
                min={1}
                value={chunkFrom}
                onChange={(e) =>
                  setChunkFrom(parseIntInput(e.target.value, chunkFrom))
                }
                className="h-7 w-16 text-xs"
                aria-label="Frame chunk from"
              />
              <span className="text-xs text-muted-foreground shrink-0">To</span>
              <Input
                type="number"
                min={1}
                value={chunkTo}
                onChange={(e) =>
                  setChunkTo(parseIntInput(e.target.value, chunkTo))
                }
                className="h-7 w-16 text-xs"
                aria-label="Frame chunk to"
              />
            </div>
            {chunkFrom > chunkTo && (
              <p className="text-xs text-destructive">From must be ≤ To</p>
            )}
          </div>
        )}

        {method === "prediction_score" && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Score limit
              </span>
              <Input
                type="number"
                step="0.1"
                min={0}
                value={scoreLimit}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  // Clamp to >= 0; a negative limit qualifies no instances.
                  if (!Number.isNaN(v)) setScoreLimit(Math.max(0, v));
                }}
                className="h-7 w-16 text-xs"
                aria-label="Score limit"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Instances
              </span>
              <Input
                type="number"
                min={0}
                value={instanceLimitLower}
                onChange={(e) =>
                  setInstanceLimitLower(
                    parseIntInput(e.target.value, instanceLimitLower)
                  )
                }
                className="h-7 w-14 text-xs"
                aria-label="Instance limit lower"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="number"
                min={0}
                value={instanceLimitUpper}
                onChange={(e) =>
                  setInstanceLimitUpper(
                    parseIntInput(e.target.value, instanceLimitUpper)
                  )
                }
                className="h-7 w-14 text-xs"
                aria-label="Instance limit upper"
              />
            </div>
          </div>
        )}

        {method === "velocity" && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0">
                Node
              </span>
              <Select
                value={String(velocityNodeIdx)}
                onValueChange={(v) => setVelocityNodeIdx(parseInt(v, 10))}
              >
                <SelectTrigger
                  className="h-7 text-xs flex-1"
                  size="sm"
                  aria-label="Velocity node"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(skeleton?.nodes ?? []).map((node, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Threshold
              </span>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={velocityThreshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  // Relative threshold in [0, 1]; > 1 makes the
                  // (value-min) > span*threshold test unsatisfiable (no frames).
                  if (!Number.isNaN(v)) {
                    setVelocityThreshold(Math.min(1, Math.max(0, v)));
                  }
                }}
                className="h-7 w-16 text-xs"
                aria-label="Velocity threshold"
              />
            </div>
          </div>
        )}

        {method === "max_displacement" && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground shrink-0 flex-1">
              Displacement
            </span>
            <Input
              type="number"
              min={0}
              value={displacementThreshold}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                // Clamp to >= 0; a negative threshold qualifies every frame.
                if (!Number.isNaN(v)) setDisplacementThreshold(Math.max(0, v));
              }}
              className="h-7 w-16 text-xs"
              aria-label="Displacement threshold"
            />
          </div>
        )}

        {/* Target video set */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground shrink-0">Target</span>
          <Select
            value={target}
            onValueChange={(v) => setTarget(v as GenerationTarget)}
          >
            <SelectTrigger
              className="h-7 text-xs flex-1"
              size="sm"
              aria-label="Target videos"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All videos</SelectItem>
              <SelectItem value="current">Current video</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Optional global frame-range restriction */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={frameRangeEnabled}
              onChange={(e) => setFrameRangeEnabled(e.target.checked)}
              className="accent-primary"
            />
            Limit to frame range
          </label>
          {frameRangeEnabled && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground shrink-0">
                  From
                </span>
                <Input
                  type="number"
                  min={1}
                  value={rangeFrom}
                  onChange={(e) =>
                    setRangeFrom(parseIntInput(e.target.value, rangeFrom))
                  }
                  className="h-7 w-16 text-xs"
                  aria-label="Frame range from"
                />
                <span className="text-xs text-muted-foreground shrink-0">
                  To
                </span>
                <Input
                  type="number"
                  min={1}
                  value={rangeTo}
                  onChange={(e) =>
                    setRangeTo(parseIntInput(e.target.value, rangeTo))
                  }
                  className="h-7 w-16 text-xs"
                  aria-label="Frame range to"
                />
              </div>
              {rangeFrom > rangeTo && (
                <p className="text-xs text-destructive">From must be ≤ To</p>
              )}
            </>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        {suggestions.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No suggestions generated. Click "Generate" to create frame
            suggestions.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b hover:bg-transparent">
                <TableHead
                  className="py-1 px-2 text-xs font-normal h-auto cursor-pointer select-none"
                  onClick={() => toggleSort("index")}
                >
                  #{sortIndicator("index")}
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal h-auto cursor-pointer select-none"
                  onClick={() => toggleSort("video")}
                >
                  Video{sortIndicator("video")}
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal text-right h-auto cursor-pointer select-none"
                  onClick={() => toggleSort("frame")}
                >
                  Frame{sortIndicator("frame")}
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal text-right h-auto cursor-pointer select-none"
                  onClick={() => toggleSort("score")}
                >
                  Score{sortIndicator("score")}
                </TableHead>
                <TableHead className="py-1 px-1 text-xs font-normal h-auto w-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedSuggestions.map((entry) => (
                <TableRow
                  key={entry.originalIndex}
                  onClick={() => {
                    navigateToSuggestion(entry.suggestion);
                    setSelectedIdx(entry.originalIndex);
                  }}
                  className={cn(
                    "cursor-pointer border-b-0",
                    entry.originalIndex === selectedIdx ||
                      (entry.suggestion.video === currentVideo &&
                        entry.suggestion.frameIdx === frameIdx)
                      ? "bg-orange-500/10 border-l-2 border-l-orange-500 text-foreground"
                      : "hover:bg-muted/50 text-foreground"
                  )}
                >
                  <TableCell className="py-0.5 px-2 text-xs text-muted-foreground">
                    {entry.originalIndex + 1}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs">
                    {basename(entry.suggestion.video.filename)}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums">
                    {entry.suggestion.frameIdx}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums text-muted-foreground">
                    {entry.score !== null ? entry.score.toFixed(2) : "--"}
                  </TableCell>
                  <TableCell className="py-0.5 px-1 text-xs text-center w-6">
                    {entry.hasLabels && (
                      <span
                        className="inline-block w-2 h-2 rounded-full bg-green-500"
                        title="Has user labels"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>

      <Separator />
      <div className="flex flex-col gap-1 p-2">
        {/* Nav row: Prev · status · Next */}
        <div className="flex items-center gap-1">
          <Button
            variant="subtle"
            size="xs"
            disabled={suggestions.length === 0}
            onClick={() => commandContext.execute(GoPrevSuggestion)}
          >
            {"◀"} Prev
          </Button>
          {summary.total > 0 ? (
            <span className="flex-1 text-center text-xs text-muted-foreground">
              {summary.labeled}/{summary.total} labeled (
              {summary.pct.toFixed(1)}%)
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            variant="subtle"
            size="xs"
            disabled={suggestions.length === 0}
            onClick={() => commandContext.execute(GoNextSuggestion)}
          >
            Next {"▶"}
          </Button>
        </div>
        {/* Edit row: Add current · Remove · Generate · Clear */}
        <div className="flex gap-1">
          <Button
            variant="subtle"
            size="xs"
            disabled={!currentVideo}
            onClick={addCurrentFrame}
          >
            Add current
          </Button>
          <Button
            variant="subtle"
            size="xs"
            disabled={selectedIdx === null}
            onClick={removeSelected}
          >
            Remove
          </Button>
          <Button variant="subtle" size="xs" onClick={handleGenerate}>
            Generate
          </Button>
          <Button
            variant="subtle"
            size="xs"
            disabled={suggestions.length === 0}
            onClick={() => setClearConfirmOpen(true)}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Clear-all confirmation */}
      <Dialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear suggestions</DialogTitle>
            <DialogDescription>
              Remove all {suggestions.length} suggestions? This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setClearConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                applySuggestions([]);
                setSelectedIdx(null);
                toast.info("Suggestions cleared");
                setClearConfirmOpen(false);
              }}
            >
              Clear all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
