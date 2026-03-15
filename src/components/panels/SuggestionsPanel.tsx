/**
 * Suggestions panel: lists suggested frames for labeling.
 *
 * Shows video name and frame index for each suggestion with sorting,
 * score display, and configurable generation methods.
 */

import { useState, useMemo } from "react";
import { useAppStore } from "../../stores/appStore";
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
import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { SuggestionFrame, Video } from "../../types";

/** Extract just the basename from a file path. */
function basename(path: string | string[]): string {
  const p = Array.isArray(path) ? path[0] ?? "" : path;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

type SortColumn = "index" | "video" | "frame" | "score";
type SortDir = "asc" | "desc";

/** Compute mean prediction score for a frame. */
function computeFrameScore(
  suggestion: SuggestionFrame,
  labels: { find: (opts: { video: Video; frameIdx: number }) => { instances: { points: { xy: [number, number] }[] }[] }[] } | null
): number | null {
  if (!labels) return null;

  const frames = labels.find({
    video: suggestion.video,
    frameIdx: suggestion.frameIdx,
  });
  if (frames.length === 0) return null;

  const lf = frames[0];
  const predicted = lf.instances.filter(
    (inst) => inst instanceof PredictedInstance
  );
  if (predicted.length === 0) return null;

  let totalScore = 0;
  let count = 0;
  for (const inst of predicted) {
    for (const pt of inst.points) {
      if (pt.score != null && !isNaN(pt.score)) {
        totalScore += pt.score;
        count++;
      }
    }
  }

  return count > 0 ? totalScore / count : null;
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

type SuggestionMethod = "stride" | "random";

/** Generate frame suggestions using the selected method. */
function generateSuggestions(method: SuggestionMethod, count: number) {
  const { labels } = useAppStore.getState();
  if (!labels) return;

  const suggestions: SuggestionFrame[] = [];

  for (const video of labels.videos) {
    const totalFrames = video.shape?.[0] ?? 0;
    if (totalFrames === 0) continue;

    const perVideo = Math.max(1, Math.round(count / labels.videos.length));

    if (method === "stride") {
      const step = Math.max(1, Math.floor(totalFrames / perVideo));
      for (let i = 0; i < perVideo && i * step < totalFrames; i++) {
        suggestions.push({
          video,
          frameIdx: i * step,
        } as SuggestionFrame);
      }
    } else if (method === "random") {
      // Random sampling without replacement
      const frameIndices = new Set<number>();
      const maxSamples = Math.min(perVideo, totalFrames);
      while (frameIndices.size < maxSamples) {
        frameIndices.add(Math.floor(Math.random() * totalFrames));
      }
      const sorted = [...frameIndices].sort((a, b) => a - b);
      for (const frameIdx of sorted) {
        suggestions.push({
          video,
          frameIdx,
        } as SuggestionFrame);
      }
    }
  }

  labels.suggestions = suggestions;
  useAppStore.getState().markChanged();

  const methodLabel = method === "stride" ? "evenly spaced" : "random";
  toast.success(`Generated ${suggestions.length} suggestions`, {
    description: `${methodLabel} across ${labels.videos.length} video(s)`,
  });
}

export function SuggestionsPanel() {
  const labels = useAppStore((s) => s.labels);
  const currentVideo = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);

  const [method, setMethod] = useState<SuggestionMethod>("stride");
  const [count, setCount] = useState(20);
  const [sortCol, setSortCol] = useState<SortColumn>("index");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
  }, [suggestions, sortCol, sortDir, labels]);

  const navigateToSuggestion = (suggestion: SuggestionFrame) => {
    if (suggestion.video !== currentVideo) {
      setVideo(suggestion.video);
    }
    setFrameIdx(suggestion.frameIdx);
  };

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
            onValueChange={(v) => setMethod(v as SuggestionMethod)}
          >
            <SelectTrigger className="h-7 text-xs flex-1" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stride">Stride</SelectItem>
              <SelectItem value="random">Random</SelectItem>
              <SelectItem value="image_features" disabled>
                Image Features
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={1}
            max={10000}
            value={count}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v > 0) setCount(v);
            }}
            className="h-7 w-16 text-xs"
          />
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
                  onClick={() => navigateToSuggestion(entry.suggestion)}
                  className={cn(
                    "cursor-pointer border-b-0",
                    entry.suggestion.video === currentVideo &&
                      entry.suggestion.frameIdx === frameIdx
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
      <div className="flex gap-1 p-2">
        <Button
          variant="subtle"
          size="xs"
          onClick={() => generateSuggestions(method, count)}
        >
          Generate
        </Button>
        <Button
          variant="subtle"
          size="xs"
          onClick={() => {
            if (!labels) return;
            labels.suggestions = [];
            useAppStore.getState().markChanged();
            toast.info("Suggestions cleared");
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
