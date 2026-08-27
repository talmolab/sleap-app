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
  labeledSummary,
  mergeSuggestions,
  shuffleSuggestions,
  removeUnlabeledSuggestions,
  userLabeledFramesAsSuggestions,
} from "../../lib/suggestionEdits";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { frameHasUserLabels } from "@/lib/frameLabeling";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

type SortColumn = "index" | "video" | "frame" | "score";
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
   * "current"); a test seam like {@link initialMethod} so a test can mount
   * directly into the all-videos path without driving the Radix Target popover.
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
  const [perVideo, setPerVideo] = useState<number | "">(20);
  // frame_chunk bounds (1-based).
  const [chunkFrom, setChunkFrom] = useState<number | "">(1);
  const [chunkTo, setChunkTo] = useState<number | "">(1000);
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
  // Generate mode: append to the existing list ("add", default) or replace it.
  const [genMode, setGenMode] = useState<"add" | "replace">("add");
  // image_features async generation state (decode + worker).
  const [isGenerating, setIsGenerating] = useState(false);
  const [ifProgress, setIfProgress] = useState<{
    phase: ProgressPhase;
    done: number;
    total: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Target (all videos vs current) + optional global frame-range restriction.
  // Default to the CURRENT video: least-surprising for a labeling workflow and,
  // for image_features, avoids decoding every video in a multi-video project.
  const [target, setTarget] = useState<GenerationTarget>(initialTarget);
  const [frameRangeEnabled, setFrameRangeEnabled] = useState(false);
  const [rangeFrom, setRangeFrom] = useState<number | "">(1);
  const [rangeTo, setRangeTo] = useState<number | "">(1000);

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
          // Sort by the displayed value (each frame's mean instance score).
          const sa = a.score?.mean ?? -Infinity;
          const sb = b.score?.mean ?? -Infinity;
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

  /**
   * Commit freshly generated suggestions per the Add/Replace mode: "add"
   * appends the new frames to the existing list (deduped); "replace" swaps the
   * list wholesale (the legacy behavior).
   */
  const commitGenerated = (next: SuggestionFrame[]) => {
    if (!labels) return;
    applySuggestions(
      genMode === "add" ? mergeSuggestions(labels.suggestions, next) : next
    );
  };

  /** Tools: add every user-labeled frame to the suggestions (deduped). */
  const addAllLabeledFrames = () => {
    if (!labels) return;
    const before = labels.suggestions.length;
    const merged = mergeSuggestions(
      labels.suggestions,
      userLabeledFramesAsSuggestions(labels.labeledFrames)
    );
    applySuggestions(merged);
    setSelectedIdx(null);
    const added = merged.length - before;
    toast.success(
      added > 0
        ? `Added ${added} labeled frame${added === 1 ? "" : "s"} to suggestions`
        : "No new labeled frames to add"
    );
  };

  /** Tools: shuffle order so users don't over-label one video top-to-bottom. */
  const shuffleAllSuggestions = () => {
    if (!labels || labels.suggestions.length === 0) return;
    applySuggestions(shuffleSuggestions(labels.suggestions, Math.random));
    setSelectedIdx(null);
    toast.success("Shuffled suggestions");
  };

  /** Tools: drop suggestions for frames with no user labeling; keep annotated. */
  const removeUnlabeled = () => {
    if (!labels) return;
    const before = labels.suggestions.length;
    const kept = removeUnlabeledSuggestions(labels.suggestions, (s) =>
      frameHasUserLabels(labels, s.video, s.frameIdx)
    );
    applySuggestions(kept);
    setSelectedIdx(null);
    const removed = before - kept.length;
    toast.info(
      removed > 0
        ? `Removed ${removed} unlabeled suggestion${removed === 1 ? "" : "s"}`
        : "No unlabeled suggestions to remove"
    );
  };

  /** Prev/Next: navigate to the neighbouring suggestion AND select it, so the
   *  landed frame is highlighted in the table (and Remove targets it). */
  const navSuggestion = (cmd: typeof GoNextSuggestion) => {
    commandContext.execute(cmd);
    const s = useAppStore.getState();
    const idx = (labels?.suggestions ?? []).findIndex(
      (sg) => sg.video === s.video && sg.frameIdx === s.frameIdx
    );
    if (idx !== -1) setSelectedIdx(idx);
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
      commitGenerated(next);
      setSelectedIdx(null);
      toast.success(`Generated ${next.length} suggestion(s)`);
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

  /** A positive-integer numeric input value (not empty / NaN / < 1). */
  const validPosInt = (v: number | "") =>
    typeof v === "number" && Number.isInteger(v) && v >= 1;
  /** Coerce an empty box to 0 for the params object (only the validated fields matter). */
  const asInt = (v: number | "") => (typeof v === "number" ? v : 0);
  /** number-input onChange that allows an EMPTY box (stored as "") so the user
   *  can clear it and retype; the value is validated on Generate. */
  const onNumInput =
    (setter: (v: number | "") => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = e.target.valueAsNumber;
      setter(Number.isNaN(n) ? "" : n);
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
    // Validate the numeric inputs the selected method / options require — an
    // empty or invalid (e.g. negative) box aborts with a toast rather than
    // silently coercing (#327).
    if ((method === "stride" || method === "random") && !validPosInt(perVideo)) {
      toast.error("Per video can't be none or invalid");
      return;
    }
    if (
      method === "frame_chunk" &&
      (!validPosInt(chunkFrom) || !validPosInt(chunkTo))
    ) {
      toast.error("Frame chunk From/To can't be none or invalid");
      return;
    }
    if (
      frameRangeEnabled &&
      (!validPosInt(rangeFrom) || !validPosInt(rangeTo))
    ) {
      toast.error("Frame range From/To can't be none or invalid");
      return;
    }
    const params: GenerateParams = {
      method,
      videos,
      perVideo: asInt(perVideo),
      frameFrom: asInt(chunkFrom),
      frameTo: asInt(chunkTo),
      scoreLimit,
      instanceLimitLower,
      instanceLimitUpper,
      nodeIdx: velocityNodeIdx,
      threshold: velocityThreshold,
      displacementThreshold,
      frameRange: {
        enabled: frameRangeEnabled,
        frameFrom: asInt(rangeFrom),
        frameTo: asInt(rangeTo),
      },
    };
    const next = generateSuggestionFrames(labels, params);
    commitGenerated(next);
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
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col h-full" data-tutorial="suggestions-panel">
      {/* Generation controls */}
      <div className="@container px-2 py-1.5 border-b border-border space-y-1.5">
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
              onChange={onNumInput(setPerVideo)}
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
                onChange={onNumInput(setChunkFrom)}
                className="h-7 w-16 text-xs"
                aria-label="Frame chunk from"
              />
              <span className="text-xs text-muted-foreground shrink-0">To</span>
              <Input
                type="number"
                min={1}
                value={chunkTo}
                onChange={onNumInput(setChunkTo)}
                className="h-7 w-16 text-xs"
                aria-label="Frame chunk to"
              />
            </div>
            {typeof chunkFrom === "number" &&
              typeof chunkTo === "number" &&
              chunkFrom > chunkTo && (
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

        {/* Add vs Replace on generate (by the per-video / count controls) */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground shrink-0">
            On Generate
          </span>
          <Button
            variant={genMode === "add" ? "default" : "subtle"}
            size="xs"
            aria-pressed={genMode === "add"}
            onClick={() => setGenMode("add")}
          >
            Add
          </Button>
          <Button
            variant={genMode === "replace" ? "default" : "subtle"}
            size="xs"
            aria-pressed={genMode === "replace"}
            onClick={() => setGenMode("replace")}
          >
            Replace
          </Button>
        </div>

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

        {/* Bulk suggestion tools — fill the width; stack when the panel is narrow */}
        <div className="flex flex-col gap-1 @[18rem]:flex-row">
          <Button
            variant="subtle"
            size="xs"
            className="@[18rem]:flex-1 min-w-0"
            disabled={isGenerating}
            onClick={addAllLabeledFrames}
          >
            Add labeled frames
          </Button>
          <Button
            variant="subtle"
            size="xs"
            className="@[18rem]:flex-1 min-w-0"
            disabled={suggestions.length === 0 || isGenerating}
            onClick={shuffleAllSuggestions}
          >
            Shuffle
          </Button>
          <Button
            variant="subtle"
            size="xs"
            className="@[18rem]:flex-1 min-w-0"
            disabled={suggestions.length === 0 || isGenerating}
            onClick={removeUnlabeled}
          >
            Remove unlabeled
          </Button>
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
                  onChange={onNumInput(setRangeFrom)}
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
                  onChange={onNumInput(setRangeTo)}
                  className="h-7 w-16 text-xs"
                  aria-label="Frame range to"
                />
              </div>
              {typeof rangeFrom === "number" &&
                typeof rangeTo === "number" &&
                rangeFrom > rangeTo && (
                  <p className="text-xs text-destructive">From must be ≤ To</p>
                )}
            </>
          )}
        </div>

        {/* Generate — wide primary action, isolated by dividers (PyQt-style) */}
        <Separator />
        {isGenerating ? (
          <Button
            variant="outline"
            className="w-full h-8 text-xs"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </Button>
        ) : (
          <Button
            className="w-full h-8 text-xs"
            onClick={handleGenerate}
            data-tutorial="generate-suggestions-button"
          >
            Generate Suggestions
          </Button>
        )}
        <Separator />
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
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        data-tutorial="suggestions-table"
      >
        {suggestions.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No suggestions generated. Click "Generate" to create frame
            suggestions.
          </p>
        ) : (
          <Table className="table-fixed border-separate border-spacing-0">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="border-b hover:bg-transparent">
                <TableHead
                  className="py-1 px-2 text-xs font-normal h-auto border-b cursor-pointer select-none"
                  onClick={() => toggleSort("video")}
                >
                  Video{sortIndicator("video")}
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal text-right h-auto w-14 border-b cursor-pointer select-none"
                  onClick={() => toggleSort("frame")}
                >
                  Frame{sortIndicator("frame")}
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal text-right h-auto w-12 border-b">
                  Group
                </TableHead>
                <TableHead className="py-1 px-1 text-xs font-normal text-center h-auto w-14 border-b">
                  Labeled
                </TableHead>
                <TableHead
                  className="py-1 px-2 text-xs font-normal text-right h-auto w-20 border-b cursor-pointer select-none"
                  onClick={() => toggleSort("score")}
                  title="Mean instance score in each frame (hover a row for the full breakdown)"
                >
                  Mean Score{sortIndicator("score")}
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
                  <TableCell className="py-0.5 px-2 text-xs overflow-hidden">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block truncate">
                          {basename(entry.suggestion.video.filename)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        {basename(entry.suggestion.video.filename)}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums">
                    {entry.suggestion.frameIdx}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums text-muted-foreground">
                    {entry.suggestion.group || "0"}
                  </TableCell>
                  <TableCell className="py-0.5 px-1 text-xs text-center">
                    {entry.hasLabels && (
                      <span
                        className="inline-block w-2 h-2 rounded-full bg-green-500"
                        title="Has user labels"
                      />
                    )}
                  </TableCell>
                  <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums text-muted-foreground">
                    {entry.score ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                            {entry.score.mean.toFixed(2)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left">
                          <div className="tabular-nums">
                            Instances:{" "}
                            {entry.score.scores
                              .map((s) => s.toFixed(2))
                              .join(", ")}
                            <br />
                            min {entry.score.min.toFixed(2)}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      "--"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Separator />
      <div className="@container flex flex-col gap-1 p-2">
        {/* Edit row: Add current frame · Remove · Clear all — stack when narrow */}
        <div className="flex flex-col gap-1 @[18rem]:flex-row">
          <Button
            variant="subtle"
            size="xs"
            className="@[18rem]:flex-1 min-w-0"
            disabled={!currentVideo || isGenerating}
            onClick={addCurrentFrame}
          >
            Add current frame
          </Button>
          <Button
            variant="subtle"
            size="xs"
            className="@[18rem]:flex-1 min-w-0"
            disabled={selectedIdx === null || isGenerating}
            onClick={removeSelected}
          >
            Remove
          </Button>
          <Button
            variant="subtle"
            size="xs"
            className="@[18rem]:flex-1 min-w-0"
            disabled={suggestions.length === 0 || isGenerating}
            onClick={() => setClearConfirmOpen(true)}
          >
            Clear all
          </Button>
        </div>
        {/* Nav row: Prev · status · Next */}
        <div className="flex items-center gap-1">
          <Button
            variant="subtle"
            size="xs"
            disabled={suggestions.length === 0}
            onClick={() => navSuggestion(GoPrevSuggestion)}
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
            onClick={() => navSuggestion(GoNextSuggestion)}
          >
            Next {"▶"}
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
