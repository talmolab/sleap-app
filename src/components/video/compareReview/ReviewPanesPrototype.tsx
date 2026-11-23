/**
 * Review prototype B (dev only): side-by-side panes. A large window shows
 * the current disagreement once per model — each pane has only that model's
 * pose on the frame (zoomed to the animal, or the whole frame), with the
 * models' average as white crosses and the disputed nodes ringed red — plus
 * an "all models" pane. Accept / Reject under each pane; ◀ ▶ step through.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rgbToCSS } from "@/lib/colorPalettes";
import { useAppStore } from "@/stores/appStore";
import { useCompareReviewStore } from "@/stores/compareReviewStore";
import { cropAround, itemRings, reviewKey } from "@/lib/modelOverlay/reviewPrototype";
import { videoDims } from "@/lib/modelOverlay/core";
import { acceptForItem, goToItem, useReviewQueue } from "./useReviewQueue";
import { ModelCropCanvas, type CropPose } from "./ModelCropCanvas";
import { QueueStatus, ReviewSummary } from "./reviewParts";

export function ReviewPanesPrototype({ onClose }: { onClose: () => void }) {
  const { shown, progress, items, truncated, threshold } = useReviewQueue();
  const video = useAppStore((s) => s.video);
  const skeleton = useAppStore((s) => s.skeleton);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const decisions = useCompareReviewStore((s) => s.decisions);
  const toggleReject = useCompareReviewStore((s) => s.toggleReject);
  const skip = useCompareReviewStore((s) => s.skip);
  const [pos, setPos] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(true);

  const at = pos ?? Math.max(0, items.findIndex((it) => it.frame >= frameIdx));
  const item = items[Math.min(at, items.length - 1)];
  useEffect(() => {
    if (item) goToItem(item);
  }, [item]);
  const go = (d: number) => setPos(Math.max(0, Math.min(items.length - 1, at + d)));

  const edges = useMemo(() => skeleton?.edgeIndices ?? [], [skeleton]);
  const nodeNames = useMemo(() => skeleton?.nodes.map((n) => n.name) ?? [], [skeleton]);
  const dims = video ? videoDims(video) : null;
  const crop = useMemo(
    () => (item && zoomed ? cropAround(item.members.map((m) => m.xy), dims?.width ?? null, dims?.height ?? null, 0.5) : null),
    [item, zoomed, dims?.width, dims?.height]
  );
  const rings = useMemo(() => (item ? itemRings(item) : []), [item]);
  const allPoses = useMemo<CropPose[]>(
    () =>
      item
        ? item.members.flatMap((m) => {
            const model = shown.find((x) => x.id === m.modelId);
            return model ? [{ modelId: m.modelId, color: model.color, xy: m.xy }] : [];
          })
        : [],
    [item, shown]
  );

  // Keyboard: ← → step, Esc closes (only while this window is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const key = item ? reviewKey(item.frame, item.group) : "";
  const d = decisions[key];
  const cols = Math.min(3, allPoses.length + 1);
  const pane = 260;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="review-proto-panes" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-[92vh] max-w-[95vw] flex-col rounded-lg border border-border bg-background text-xs shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Review disagreements</span>
          <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-600 dark:text-amber-400">prototype B · side by side</span>
          <span className="flex-1" />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={zoomed} onChange={(e) => setZoomed(e.target.checked)} />
            Zoom to the animal
          </label>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => go(-1)} disabled={!item || at === 0} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9rem] text-center tabular-nums">
            {item ? `${at + 1} / ${items.length} · frame ${item.frame}${item.trackName ? ` · ${item.trackName}` : ""}` : "–"}
          </span>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => go(1)} disabled={!item || at >= items.length - 1} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <button type="button" className="ml-2 rounded p-1 hover:bg-muted" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <QueueStatus progress={progress} count={items.length} truncated={truncated} threshold={threshold} shown={shown.length} />
        {item && video && (
          <>
            <div className="px-3 pb-1 text-muted-foreground">
              Disputed:{" "}
              {item.flagged.map((k) => `${nodeNames[k] ?? k} (${item.spread[k].toFixed(0)} px)`).join(", ")} · white crosses = the models' average
            </div>
            <div className="min-h-0 overflow-auto px-3 pb-2">
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, ${pane}px)` }}>
                <div className="rounded border border-border p-1">
                  <ModelCropCanvas video={video} frame={item.frame} crop={crop} poses={allPoses} consensus={null} rings={rings} edges={edges} width={pane - 10} height={pane - 50} />
                  <div className="flex items-center gap-1 px-1 pt-1">
                    <span className="font-medium">All models</span>
                    <span className="flex-1" />
                    <Button
                      size="sm"
                      variant={d?.skipped ? "default" : "outline"}
                      className="h-6 text-[11px]"
                      onClick={() => {
                        skip(key);
                        go(1);
                      }}
                    >
                      <SkipForward className="mr-1 h-3 w-3" /> Fine, next
                    </Button>
                  </div>
                </div>
                {item.members.map((m) => {
                  const model = shown.find((x) => x.id === m.modelId);
                  if (!model) return null;
                  const accepted = d?.accepted === m.modelId;
                  const rejected = d?.rejected.includes(m.modelId) ?? false;
                  return (
                    <div
                      key={m.modelId}
                      className={`rounded border p-1 ${accepted ? "border-green-500 bg-green-500/10" : "border-border"} ${rejected ? "opacity-50" : ""}`}
                      data-testid="review-proto-pane"
                    >
                      <ModelCropCanvas
                        video={video}
                        frame={item.frame}
                        crop={crop}
                        poses={[{ modelId: m.modelId, color: model.color, xy: m.xy }]}
                        consensus={item.consensus}
                        rings={rings}
                        edges={edges}
                        width={pane - 10}
                        height={pane - 50}
                      />
                      <div className="flex items-center gap-1 px-1 pt-1">
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: rgbToCSS(model.color) }} />
                        <span className={`min-w-0 flex-1 truncate ${rejected ? "line-through" : ""}`} title={model.source}>
                          {model.name}
                        </span>
                        <span className="tabular-nums text-muted-foreground">{Number.isFinite(m.distance) ? `${m.distance.toFixed(1)} px` : "–"}</span>
                        <Button size="sm" variant={accepted ? "default" : "outline"} className="h-6 px-1.5" onClick={() => void acceptForItem(item, m.modelId).then(() => go(1))} title="Accept this pose (undoable), then next">
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant={rejected ? "destructive" : "outline"} className="h-6 px-1.5" onClick={() => toggleReject(key, m.modelId)} title="Mark this model wrong here">
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
        <ReviewSummary items={items} />
      </div>
    </div>
  );
}
