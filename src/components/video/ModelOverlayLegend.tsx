/**
 * The Compare Model Predictions panel, in the canvas's top-right corner.
 *
 * Title and a one-line summary (video, models shown, frames with 2+ models,
 * frames where they disagree); the disagreement threshold with ◀ ▶; a
 * button that hides the project's own instances (same as H) so the models
 * can be compared alone; and one row per loaded model (show/hide, colour,
 * name, poses on this frame, remove). "–" folds the whole panel into a small
 * pill in the same corner; the models stay drawn. Hidden when no model is
 * loaded.
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, Eye, EyeOff, LineChart, Minus, Plus, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { rgbToCSS } from "@/lib/colorPalettes";
import { toast } from "@/lib/notify";
import { compareSummary, findDisagreementFrame } from "@/hooks/useModelOverlayFrame";
import { DISAGREEMENT_COLOR } from "@/canvas/modelOverlayRenderer";
import { toggleProjectInstances } from "@/lib/modelOverlay/canvasActions";

/** The panel's summary line, e.g. "mice.mp4 · 3 models · 1,200 frames with 2+ · 87 disagree". */
export function summaryLine(s: ReturnType<typeof compareSummary>, highlight: boolean): string {
  const parts = [
    s.videoName,
    `${s.shown} model${s.shown === 1 ? "" : "s"} shown`,
    `${s.overlapFrames.toLocaleString()} frame${s.overlapFrames === 1 ? "" : "s"} with 2+`,
  ];
  if (highlight && s.overlapFrames > 0) parts.push(`${s.disagreeFrames.toLocaleString()} disagree`);
  return parts.filter((p) => p !== "").join(" · ");
}

const RMS_HELP =
  "How far apart the models put the same body part: the average distance of each model's point from their middle (the RMS spread, in pixels). Nodes above this get a red ring.";

/** The typed threshold in px, or null for empty / not a number / negative (then ignored). */
export function parseThreshold(text: string): number | null {
  if (text.trim() === "") return null;
  const v = Number(text);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * `disagreementCount` is the number of flagged nodes on this frame, passed in
 * by the canvas so the per-frame matching runs once (VideoPlayer already
 * computes it to draw the rings).
 */
export function ModelOverlayLegend({ disagreementCount }: { disagreementCount: number }) {
  const models = useModelOverlayStore((s) => s.models);
  const setVisible = useModelOverlayStore((s) => s.setVisible);
  const removeModel = useModelOverlayStore((s) => s.removeModel);
  const clear = useModelOverlayStore((s) => s.clear);
  const setDialogOpen = useModelOverlayStore((s) => s.setDialogOpen);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const highlight = useModelOverlayStore((s) => s.highlightDisagreement);
  const setHighlight = useModelOverlayStore((s) => s.setHighlightDisagreement);
  const threshold = useModelOverlayStore((s) => s.threshold);
  const setThreshold = useModelOverlayStore((s) => s.setThreshold);
  // The box's own text, so clearing it to type a new value doesn't set 0.
  const [thresholdText, setThresholdText] = useState<string | null>(null);
  const tracesOpen = useModelOverlayStore((s) => s.tracesOpen);
  const setTracesOpen = useModelOverlayStore((s) => s.setTracesOpen);
  const minimized = useModelOverlayStore((s) => s.legendMinimized);
  const setMinimized = useModelOverlayStore((s) => s.setLegendMinimized);
  const showInstances = useAppStore((s) => s.showInstances);
  // Counts over every frame: recomputed only when the models, video or threshold change.
  const summary = useMemo(
    () => compareSummary(models, video, threshold, highlight),
    [models, video, threshold, highlight]
  );

  if (models.length === 0) return null;
  const forVideo = models.filter((m) => m.video === video);
  const shownCount = forVideo.filter((m) => m.visible).length;

  if (minimized) {
    return (
      <button
        type="button"
        className="absolute top-2 right-2 z-30 rounded-full bg-black/75 px-2.5 py-1 text-xs font-semibold text-white shadow-lg backdrop-blur-sm pointer-events-auto hover:bg-black/90"
        data-testid="model-overlay-pill"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setMinimized(false)}
        title="Show the Compare Model Predictions panel"
      >
        Compare Models ({forVideo.length})
      </button>
    );
  }

  const jump = (dir: 1 | -1) => {
    const f = findDisagreementFrame(models, video, threshold, frameIdx, dir);
    if (f === null) toast.info(dir === 1 ? "No disagreement after this frame" : "No disagreement before this frame");
    else useAppStore.getState().setFrameIdx(f);
  };

  return (
    <div
      className="absolute top-2 right-2 z-30 max-w-[21rem] rounded-md bg-black/75 px-2 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm pointer-events-auto"
      data-testid="model-overlay-legend"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <span className="font-semibold text-white" data-testid="model-overlay-title">
          Compare Model Predictions
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={() => setDialogOpen(true)}
          title="Add prediction files…"
          aria-label="Add prediction files"
        >
          <Plus className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={clear}
          title="Stop comparing (remove every model)"
          aria-label="Remove all models"
        >
          <X className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={() => setMinimized(true)}
          title="Minimize (the models stay drawn)"
          aria-label="Minimize"
        >
          <Minus className="h-3 w-3" />
        </button>
      </div>
      <div className="text-[10px] text-white/60" data-testid="model-overlay-summary">
        {summaryLine(summary, highlight)}
      </div>
      <div className="mt-1 space-y-0.5">
        {forVideo.length === 0 && (
          <div className="text-white/60">No model loaded for this video.</div>
        )}
        {forVideo.length > 0 && (
          <div className="mb-1 flex items-center gap-1.5 border-b border-white/15 pb-1" data-testid="model-overlay-disagreement">
            <input
              type="checkbox"
              className="h-3 w-3 accent-white"
              checked={highlight}
              onChange={(e) => setHighlight(e.target.checked)}
              aria-label="Highlight disagreement"
            />
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2"
              style={{ borderColor: rgbToCSS(DISAGREEMENT_COLOR) }}
            />
            <span>RMS spread &gt;</span>
            <input
              type="number"
              min={0}
              step={1}
              className="w-10 rounded bg-white/10 px-1 text-right tabular-nums"
              value={thresholdText ?? String(threshold)}
              onChange={(e) => {
                setThresholdText(e.target.value);
                const v = parseThreshold(e.target.value);
                if (v !== null) setThreshold(v);
              }}
              onBlur={() => setThresholdText(null)}
              aria-label="Disagreement threshold in pixels"
            />
            <span className="text-white/60">px</span>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button aria-label="What is the RMS spread?" className="text-white/60 hover:text-white">
                    <CircleHelp className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-64 text-[11px]">
                  {RMS_HELP}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="flex-1" />
            {highlight && shownCount >= 2 && (
              <span className="tabular-nums text-white/70" title="Nodes flagged on this frame">
                {disagreementCount}
              </span>
            )}
            <button
              type="button"
              className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30"
              onClick={() => jump(-1)}
              disabled={shownCount < 2}
              title="Previous frame where the models disagree"
              aria-label="Previous disagreement"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30"
              onClick={() => jump(1)}
              disabled={shownCount < 2}
              title="Next frame where the models disagree"
              aria-label="Next disagreement"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}
        {forVideo.map((m) => {
          const onFrame = m.frames.get(frameIdx)?.length ?? 0;
          return (
            <div key={m.id} className="flex items-center gap-1.5" data-testid="model-overlay-row">
              <input
                type="checkbox"
                className="h-3 w-3 accent-white"
                checked={m.visible}
                onChange={(e) => setVisible(m.id, e.target.checked)}
                aria-label={`Show ${m.name}`}
              />
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: rgbToCSS(m.color) }}
              />
              <span className="min-w-0 flex-1 truncate" title={m.source}>
                {m.name}
              </span>
              <span className="text-white/50 tabular-nums" title="Poses on this frame">
                {onFrame}
              </span>
              <button
                type="button"
                className="rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
                onClick={() => removeModel(m.id)}
                title={`Remove ${m.name}`}
                aria-label={`Remove ${m.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {forVideo.length > 0 && (
          <div className="flex items-center gap-1 border-t border-white/15 pt-1">
            <button
              type="button"
              className={`flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/10 hover:text-white ${showInstances ? "text-white/70" : "bg-white/20 text-white"}`}
              onClick={toggleProjectInstances}
              aria-pressed={!showInstances}
              data-testid="model-overlay-hide-instances"
              title="Hide or show the project's own instances, so you see only the models (same as H)"
            >
              {showInstances ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showInstances ? "Hide project instances (H)" : "Show project instances (H)"}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              className={`flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/10 hover:text-white ${tracesOpen ? "bg-white/20 text-white" : "text-white/70"}`}
              onClick={() => setTracesOpen(!tracesOpen)}
              title="Plot each node's x and y over time, one line per model (opens under the video)"
              aria-pressed={tracesOpen}
              data-testid="model-overlay-traces"
            >
              <LineChart className="h-3 w-3" /> Traces
            </button>
          </div>
        )}
        {forVideo.length > 0 && (
          <div className="pt-0.5 text-[10px] text-white/50" data-testid="model-overlay-accept-hint">
            Alt+click a model's pose to accept it
          </div>
        )}
      </div>
    </div>
  );
}
