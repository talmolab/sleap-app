/**
 * Legend for Compare Model Predictions, in the canvas's top-right corner.
 *
 * One row per loaded model: show/hide checkbox, colour swatch, name, and a
 * remove button. Hidden when no model is loaded. Collapses to a single chip so
 * it can be moved out of the way of the animals.
 */
import { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { rgbToCSS } from "@/lib/colorPalettes";
import { toast } from "@/lib/notify";
import { findDisagreementFrame, useModelOverlayFrame } from "@/hooks/useModelOverlayFrame";
import { DISAGREEMENT_COLOR } from "@/canvas/modelOverlayRenderer";

export function ModelOverlayLegend() {
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
  const { disagreements } = useModelOverlayFrame();
  const [collapsed, setCollapsed] = useState(false);

  if (models.length === 0) return null;
  const forVideo = models.filter((m) => m.video === video);
  const shownCount = forVideo.filter((m) => m.visible).length;

  const jump = (dir: 1 | -1) => {
    const f = findDisagreementFrame(models, video, threshold, frameIdx, dir);
    if (f === null) toast.info(dir === 1 ? "No disagreement after this frame" : "No disagreement before this frame");
    else useAppStore.getState().setFrameIdx(f);
  };

  return (
    <div
      className="absolute top-2 right-2 z-30 max-w-[18rem] rounded-md bg-black/75 px-2 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm pointer-events-auto"
      data-testid="model-overlay-legend"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex items-center gap-1 font-semibold text-white/80 hover:text-white"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Show the model list" : "Hide the model list"}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          Models ({forVideo.length})
        </button>
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
      </div>
      {!collapsed && (
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
              <span title="Ring nodes where the models' positions spread by more than this many pixels (RMS distance from their mean)">
                Disagree &gt;
              </span>
              <input
                type="number"
                min={0}
                step={1}
                className="w-10 rounded bg-white/10 px-1 text-right tabular-nums"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                aria-label="Disagreement threshold in pixels"
              />
              <span className="text-white/60">px</span>
              <span className="flex-1" />
              {highlight && shownCount >= 2 && (
                <span className="tabular-nums text-white/70" title="Nodes flagged on this frame">
                  {disagreements.length}
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
        </div>
      )}
    </div>
  );
}
