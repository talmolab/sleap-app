/**
 * Suggestions panel: lists suggested frames for labeling.
 *
 * Shows video name and frame index for each suggestion with sorting,
 * score display, and configurable generation methods.
 */

import { useState, useMemo, useReducer, useRef, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import { GoNextSuggestion, GoPrevSuggestion } from "../../commands/navCommands";
import {
  suggestionExists,
  addSuggestionFrame,
  removeSuggestionAt,
  mergeSuggestionFrames,
  labeledSummary,
} from "../../lib/suggestionEdits";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  frameHasUserLabels,
  frameUserInstanceCount,
} from "@/lib/frameLabeling";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { SuggestionFrame, Video } from "../../types";
import {
  generateSuggestionFrames,
  type GenerationMethod,
  type GenerateParams,
} from "../../lib/suggestionStrategies";
import {
  runImageFeatureSuggestions,
  type ImageFeaturesParams,
  type ProgressPhase,
} from "../../lib/imageFeatures";

/** Extract just the basename from a file path. */
function basename(path: string | string[]): string {
  const p = Array.isArray(path) ? path[0] ?? "" : path;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

type SortColumn = "index" | "video" | "frame" | "score" | "labeled" | "instances";
type SortDir = "asc" | "desc";

/**
 * Per-frame prediction-score summary shown in the Score column.
 *
 * All values are over the frame's PREDICTED instances' `PredictedInstance.score`
 * (SLEAP's instance/grouping score — NOT bounded to [0, 1] and distinct from
 * per-point confidence).
 */
interface FrameScoreInfo {
  /**
   * Lowest instance score in the frame — the weakest instance, and the value
   * the `prediction_score` method actually compares against its Score limit (it
   * counts instances at/below the limit). Shown as the Score column value so a
   * generated row never appears to exceed the limit.
   */
  min: number;
  /** Mean instance score — frame-level quality; matches the Frames panel. */
  mean: number;
  /** All predicted-instance scores, ascending (for the breakdown tooltip). */
  scores: number[];
}

/**
 * Summarize a suggested frame's predicted-instance scores, or `null` when the
 * frame has no scored predictions.
 */
function computeFrameScore(
  suggestion: SuggestionFrame,
  labels: { find: (opts: { video: Video; frameIdx: number }) => { instances: { score?: number }[] }[] } | null
): FrameScoreInfo | null {
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

  const scores: number[] = [];
  for (const inst of predicted) {
    if (typeof inst.score === "number" && !isNaN(inst.score)) {
      scores.push(inst.score);
    }
  }
  if (scores.length === 0) return null;

  scores.sort((a, b) => a - b);
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return { min: scores[0], mean, scores };
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
  image_features: "Image features",
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
  /**
   * Initial target video set. Production callers omit this (defaults to
   * "all"); a test seam like {@link initialMethod} so a test can mount
   * directly into the current-video path without driving the Radix Target
   * popover.
   */
  initialTarget?: GenerationTarget;
}

export function SuggestionsPanel({
  initialMethod = "stride",
  initialTarget = "all",
}: SuggestionsPanelProps = {}) {
  const labels = useAppStore((s) => s.labels);
  const currentVideo = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const skeleton = useAppStore((s) => s.skeleton);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  // Image-features ROI crop tool (session-only store state; shared with the canvas).
  const roiDrawActive = useAppStore((s) => s.imageFeatureRoiDrawActive);
  const setRoiDrawActive = useAppStore((s) => s.setImageFeatureRoiDrawActive);
  const setImageFeatureRoi = useAppStore((s) => s.setImageFeatureRoi);
  const imageFeatureRois = useAppStore((s) => s.imageFeatureRois);
  const resetImageFeatureRoi = useAppStore((s) => s.resetImageFeatureRoi);
  // THE "underlying labels/instances changed" signal (bumped on canvas label
  // edits). Subscribing here re-renders the panel when frames are labeled
  // elsewhere; see Seekbar.tsx for the same pattern.
  const overlayVersion = useAppStore((s) => s.overlayVersion);

  // --- Generation method + per-method params (PyQt defaults) ---
  const [method, setMethod] = useState<GenerationMethod>(initialMethod);

  // The Image Features "Set region" tool (the canvas ROI-draw crosshair + the
  // drawn region) is only meaningful while the Image Features method is on
  // screen. It lives in GLOBAL store state shared with the canvas — VideoPlayer
  // gates drag-capture on imageFeatureRoiDrawActive — so unless it is actively
  // torn down it leaks: the canvas keeps hijacking drags into ROI mode on every
  // tab. Reset it (exit draw-mode AND drop the transient region) whenever the
  // active method isn't image_features, and on unmount (panel closed / collapsed
  // / hidden, or — single-panel mode — switched away). This also covers "Allow
  // Multiple Panels", where the panel never unmounts: a method change fires the
  // first effect, so the reset doesn't depend on unmount.
  useEffect(() => {
    if (method !== "image_features") resetImageFeatureRoi();
  }, [method, resetImageFeatureRoi]);
  useEffect(() => {
    return () => {
      resetImageFeatureRoi();
    };
  }, [resetImageFeatureRoi]);
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
  // image_features params (PyQt defaults; own state, NOT the stride/random perVideo).
  const [ifSampleCount, setIfSampleCount] = useState(200);
  const [ifSampleMethod, setIfSampleMethod] = useState<"stride" | "random">("stride");
  const [ifScaleCap, setIfScaleCap] = useState(128);
  const [ifNClusters, setIfNClusters] = useState(5);
  const [ifPerCluster, setIfPerCluster] = useState(5);
  const [ifPcaComponents, setIfPcaComponents] = useState(5);
  const [ifSeed, setIfSeed] = useState(0);
  const [ifAdvancedOpen, setIfAdvancedOpen] = useState(false);
  // image_features async generation state (decode + worker).
  const [isGenerating, setIsGenerating] = useState(false);
  const [ifProgress, setIfProgress] = useState<{
    phase: ProgressPhase;
    done: number;
    total: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Target (all videos vs current) + optional global frame-range restriction.
  // Default to ALL videos (#324): defaulting to the current video led users to
  // do all their labeling on a single video, hurting generalization. Note
  // this means image_features now decodes every video in a multi-video
  // project by default too, unless the user narrows it to "current" themselves.
  const [target, setTarget] = useState<GenerationTarget>(initialTarget);
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
      hasLabels: frameHasUserLabels(labels, s.video, s.frameIdx),
      instanceCount: frameUserInstanceCount(labels, s.video, s.frameIdx),
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
          // Sort by the displayed value (each frame's lowest instance score).
          const sa = a.score?.min ?? -Infinity;
          const sb = b.score?.min ?? -Infinity;
          cmp = sa - sb;
          break;
        }
        case "labeled":
          cmp = Number(a.hasLabels) - Number(b.hasLabels);
          break;
        case "instances":
          cmp = a.instanceCount - b.instanceCount;
          break;
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
  /**
   * image_features generation: async decode + Worker clustering, with a live
   * 2-phase progress bar and cancellation. On success it replaces the
   * suggestion list exactly like the sync path; abort/error toast and leave the
   * existing suggestions untouched.
   */
  const handleGenerateImageFeatures = async (videos: Video[]) => {
    if (!labels) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setIfProgress({ phase: "decoding", done: 0, total: 0 });
    try {
      const params: ImageFeaturesParams = {
        perVideo: ifSampleCount,
        sampleMethod: ifSampleMethod,
        scaleCap: ifScaleCap,
        pcaComponents: ifPcaComponents,
        nClusters: ifNClusters,
        perCluster: ifPerCluster,
        seed: ifSeed,
        roiByVideo: imageFeatureRois,
      };
      const next = await runImageFeatureSuggestions(labels, videos, params, {
        signal: controller.signal,
        onProgress: (phase, done, total) => setIfProgress({ phase, done, total }),
      });
      // Merge onto whatever's already there rather than replacing it --
      // otherwise a re-generate silently discards prior suggestions
      // (manually added ones included).
      const merged = mergeSuggestionFrames(labels.suggestions, next);
      const added = merged.length - labels.suggestions.length;
      applySuggestions(merged);
      setSelectedIdx(null);
      toast.success(`Added ${added} new suggestion(s)`);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        toast.info("Generation canceled");
      } else {
        console.error("Image-features generation failed:", err);
        toast.error("Image-features generation failed");
      }
    } finally {
      setIsGenerating(false);
      setIfProgress(null);
      abortRef.current = null;
      setRoiDrawActive(false);
    }
  };

  const handleGenerate = () => {
    if (!labels) return;
    const videos =
      target === "current" && currentVideo
        ? [currentVideo]
        : labels.videos ?? [];
    if (method === "image_features") {
      void handleGenerateImageFeatures(videos);
      return;
    }
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
    // Merge onto whatever's already there rather than replacing it -- see
    // handleGenerateImageFeatures above for why.
    const merged = mergeSuggestionFrames(labels.suggestions, next);
    const added = merged.length - labels.suggestions.length;
    applySuggestions(merged);
    setSelectedIdx(null);
    toast.success(`Added ${added} new suggestion(s)`);
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
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col h-full" data-tutorial="suggestions-panel">
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
              data-tutorial="suggestions-method-select"
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
              <SelectItem value="image_features">
                {METHOD_LABELS.image_features}
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
              data-tutorial="suggestions-per-video-input"
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
            <p className="text-xs text-muted-foreground leading-snug">
              Selects frames with {instanceLimitLower} to {instanceLimitUpper}{" "}
              instances scoring ≤ {scoreLimit}. Score shows each frame's lowest
              instance score.
            </p>
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

        {method === "image_features" && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Sample
              </span>
              <Input
                type="number"
                min={1}
                max={3000}
                value={ifSampleCount}
                onChange={(e) =>
                  setIfSampleCount(
                    Math.max(1, parseIntInput(e.target.value, ifSampleCount))
                  )
                }
                className="h-7 w-16 text-xs"
                aria-label="Sample count"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0">
                Sample by
              </span>
              <Select
                value={ifSampleMethod}
                onValueChange={(v) => setIfSampleMethod(v as "stride" | "random")}
              >
                <SelectTrigger
                  className="h-7 text-xs flex-1"
                  size="sm"
                  aria-label="Sample method"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stride">Stride</SelectItem>
                  <SelectItem value="random">Random</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Resolution
              </span>
              <Input
                type="number"
                min={16}
                max={1024}
                value={ifScaleCap}
                onChange={(e) =>
                  setIfScaleCap(
                    Math.max(16, parseIntInput(e.target.value, ifScaleCap))
                  )
                }
                className="h-7 w-16 text-xs"
                aria-label="Resolution cap"
              />
              <span className="text-xs text-muted-foreground">px</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Clusters
              </span>
              <Input
                type="number"
                min={1}
                value={ifNClusters}
                onChange={(e) =>
                  setIfNClusters(
                    Math.max(1, parseIntInput(e.target.value, ifNClusters))
                  )
                }
                className="h-7 w-16 text-xs"
                aria-label="Clusters"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Frames per cluster
              </span>
              <Input
                type="number"
                min={1}
                value={ifPerCluster}
                onChange={(e) =>
                  setIfPerCluster(
                    Math.max(1, parseIntInput(e.target.value, ifPerCluster))
                  )
                }
                className="h-7 w-16 text-xs"
                aria-label="Frames per cluster"
              />
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              ≈ {ifNClusters * ifPerCluster} suggestions per video.
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground shrink-0 flex-1">
                Seed
              </span>
              <Input
                type="number"
                value={ifSeed}
                onChange={(e) => setIfSeed(parseIntInput(e.target.value, ifSeed))}
                className="h-7 w-16 text-xs"
                aria-label="Seed"
              />
              <Button
                variant="subtle"
                size="xs"
                aria-label="Reroll seed"
                title="Reroll seed"
                onClick={() => setIfSeed(Math.floor(Math.random() * 2 ** 31))}
              >
                {"⟳"}
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant={roiDrawActive ? "default" : "subtle"}
                size="xs"
                disabled={!currentVideo}
                onClick={() => setRoiDrawActive(!roiDrawActive)}
              >
                {roiDrawActive ? "Drawing…" : "Set region"}
              </Button>
              {currentVideo && imageFeatureRois.has(currentVideo) && (
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => setImageFeatureRoi(currentVideo, null)}
                >
                  Clear region
                </Button>
              )}
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline decoration-dotted"
              onClick={() => setIfAdvancedOpen((o) => !o)}
            >
              {ifAdvancedOpen ? "▾ Advanced" : "▸ Advanced"}
            </button>
            {ifAdvancedOpen && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground shrink-0 flex-1">
                  PCA components
                </span>
                <Input
                  type="number"
                  min={1}
                  value={ifPcaComponents}
                  onChange={(e) =>
                    setIfPcaComponents(
                      Math.max(1, parseIntInput(e.target.value, ifPcaComponents))
                    )
                  }
                  className="h-7 w-16 text-xs"
                  aria-label="PCA components"
                />
              </div>
            )}
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

      <ScrollArea className="flex-1 min-h-0" data-tutorial="suggestions-table">
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
                  title="Lowest instance score in each frame (hover a row for the full breakdown)"
                >
                  Score{sortIndicator("score")}
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal text-right h-auto cursor-pointer select-none"
                  onClick={() => toggleSort("instances")}
                  title="Number of user-labeled instances in this frame"
                >
                  Instances{sortIndicator("instances")}
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal text-center h-auto cursor-pointer select-none"
                  onClick={() => toggleSort("labeled")}
                  title="Whether this frame has any user labels"
                >
                  Labeled{sortIndicator("labeled")}
                </TableHead>
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
                    {entry.score ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                            {entry.score.min.toFixed(2)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left">
                          <div className="tabular-nums">
                            Instances:{" "}
                            {entry.score.scores
                              .map((s) => s.toFixed(2))
                              .join(", ")}
                            <br />
                            mean {entry.score.mean.toFixed(2)}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      "--"
                    )}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums text-muted-foreground">
                    {entry.instanceCount > 0 ? entry.instanceCount : ""}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-center">
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
        {/* Image-features generation progress (2-phase: decoding then clustering). */}
        {isGenerating && (
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width:
                    ifProgress && ifProgress.total > 0
                      ? `${(ifProgress.done / ifProgress.total) * 100}%`
                      : "100%",
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {ifProgress?.phase === "clustering"
                ? "Clustering…"
                : `Decoding ${ifProgress?.done ?? 0}/${ifProgress?.total ?? 0}`}
            </p>
          </div>
        )}
        {/* Edit row: Generate/Cancel · Add current · Remove · Clear
            (Generate leads so the primary action is the most visible). */}
        <div className="flex gap-1">
          {isGenerating ? (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </Button>
          ) : (
            <Button
              variant="subtle"
              size="xs"
              onClick={handleGenerate}
              data-tutorial="generate-suggestions-button"
            >
              Generate
            </Button>
          )}
          <Button
            variant="subtle"
            size="xs"
            disabled={!currentVideo || isGenerating}
            onClick={addCurrentFrame}
          >
            Add current
          </Button>
          <Button
            variant="subtle"
            size="xs"
            disabled={selectedIdx === null || isGenerating}
            onClick={removeSelected}
          >
            Remove
          </Button>
          <Button
            variant="subtle"
            size="xs"
            disabled={suggestions.length === 0 || isGenerating}
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
    </TooltipProvider>
  );
}
