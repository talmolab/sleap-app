/**
 * Compare Model Predictions — Review disagreements (opened with "Review" in
 * the corner panel). Side by side: a large window shows
 * the current disagreement once per model — each pane has only that model's
 * pose on the frame (zoomed to the animal, or the whole frame), with the
 * models' average as white crosses and the disputed nodes ringed red — plus
 * an "all models" pane. Worst disagreements first. One decision per item:
 * "Use this one" under a model (its pose becomes a user instance, undoable),
 * "None are right" (go label it by hand in the main view), or "Skip" (either
 * is fine). ◀ ▶ or ← → step through; click the item number (or the frame)
 * in the header to jump. Only disagreements above the window's own
 * threshold (default 25 px) are listed.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, PenLine, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { rgbToCSS } from "@/lib/colorPalettes";
import { useAppStore } from "@/stores/appStore";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { cropAround, itemRings, reviewItemKey } from "@/lib/modelOverlay/review";
import { videoDims } from "@/lib/modelOverlay/core";
import { acceptForItem, goToItem, keysBelongElsewhere, labelByHand, useReviewQueue } from "./useReviewQueue";
import { ModelCropCanvas, type CropPose } from "./ModelCropCanvas";
import {
  JumpNumber,
  nearestItemToFrame,
  ProjectInstancesKey,
  QueueStatus,
  ReviewSummary,
  ReviewThresholdInput,
  useProjectPoses,
} from "./reviewParts";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";

/** The window, when open and models are loaded (mounted once, by VideoPlayer). */
export function CompareReviewWindow() {
  const open = useCompareReviewStore((s) => s.open);
  const setOpen = useCompareReviewStore((s) => s.setOpen);
  const hasModels = useModelOverlayStore((s) => s.models.length > 0);
  const video = useAppStore((s) => s.video);
  if (!open || !hasModels || !video) return null;
  return <ReviewWindow onClose={() => setOpen(false)} />;
}

export function ReviewWindow({ onClose }: { onClose: () => void }) {
  const { shown, progress, items, truncated, totalFrames, threshold } = useReviewQueue();
  const video = useAppStore((s) => s.video);
  const skeleton = useAppStore((s) => s.skeleton);
  const decisions = useCompareReviewStore((s) => s.decisions);
  const skip = useCompareReviewStore((s) => s.skip);
  const [pos, setPos] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(true);

  // Start at the worst item not decided yet, then stay put until the user moves
  // (a decision on this item must not make the view jump to another one).
  const firstOpen = Math.max(0, items.findIndex((it) => !isReviewed(decisions[reviewItemKey(it)])));
  useEffect(() => {
    if (pos === null && items.length > 0) setPos(firstOpen);
  }, [pos, items.length, firstOpen]);
  const at = pos ?? firstOpen;
  const item = items[Math.min(at, items.length - 1)];
  useEffect(() => {
    if (item) goToItem(item);
  }, [item]);
  const go = (d: number) => setPos(Math.max(0, Math.min(items.length - 1, at + d)));
  /** After a decision: the next item not decided yet (else just the next one). */
  const next = () => {
    for (let i = at + 1; i < items.length; i++) if (!isReviewed(decisions[reviewItemKey(items[i])])) return setPos(i);
    go(1);
  };

  const edges = useMemo(() => skeleton?.edgeIndices ?? [], [skeleton]);
  const nodeNames = useMemo(() => skeleton?.nodes.map((n) => n.name) ?? [], [skeleton]);
  const dims = video ? videoDims(video) : null;
  const crop = useMemo(
    () => (item && zoomed ? cropAround(item.members.map((m) => m.xy), dims?.width ?? null, dims?.height ?? null, 0.5) : null),
    [item, zoomed, dims?.width, dims?.height]
  );
  const rings = useMemo(() => (item ? itemRings(item) : []), [item]);
  const projectPoses = useProjectPoses(item?.frame ?? null);
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
      // Leave keys to "Replace your instance?" and other dialogs / text fields.
      if (keysBelongElsewhere(e)) return;
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

  const key = item ? reviewItemKey(item) : "";
  const d = decisions[key];
  const cols = Math.min(3, allPoses.length + 1);
  const pane = 260;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="review-window" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-[92vh] max-w-[95vw] flex-col rounded-lg border border-border bg-background text-xs shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Review disagreements</span>
          <ReviewThresholdInput />
          <span className="flex-1" />
          <label htmlFor="review-zoom" className="flex items-center gap-1.5">
            <Checkbox id="review-zoom" checked={zoomed} onCheckedChange={(v) => setZoomed(v === true)} />
            Zoom to the animal
          </label>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => go(-1)} disabled={!item || at === 0} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9rem] text-center tabular-nums" data-testid="review-position">
            {item ? (
              <>
                <JumpNumber
                  value={at + 1}
                  min={1}
                  max={items.length}
                  onCommit={(n) => setPos(n - 1)}
                  label="Go to item number"
                  testId="review-jump-item"
                />{" "}
                / {items.length} · frame{" "}
                <JumpNumber
                  value={item.frame}
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  onCommit={(f) => setPos(nearestItemToFrame(items, f))}
                  label="Go to the item nearest this frame"
                  testId="review-jump-frame"
                />
                {item.trackName ? ` · ${item.trackName}` : ""}
              </>
            ) : (
              "–"
            )}
          </span>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => go(1)} disabled={!item || at >= items.length - 1} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <button type="button" className="ml-2 rounded p-1 hover:bg-muted" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <QueueStatus progress={progress} count={items.length} truncated={truncated} totalFrames={totalFrames} threshold={threshold} shown={shown.length} />
        {item && video && (
          <>
            <div className="px-3 pb-1 text-muted-foreground">
              Disputed:{" "}
              {item.flagged.map((k) => `${nodeNames[k] ?? k} (${item.spread[k].toFixed(0)} px)`).join(", ")} · white crosses = the models' average
            </div>
            <div className="px-3 pb-1">
              <ProjectInstancesKey count={projectPoses ? projectPoses.length : null} />
            </div>
            <div className="min-h-0 overflow-auto px-3 pb-2">
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, ${pane}px)` }}>
                <div className="flex flex-col rounded border border-border p-1">
                  <ModelCropCanvas video={video} frame={item.frame} crop={crop} poses={allPoses} consensus={null} rings={rings} projectPoses={projectPoses} edges={edges} width={pane - 10} height={pane - 76} />
                  <div className="px-1 pt-1 font-medium">All models</div>
                  <div className="flex items-center gap-1 px-1 pt-1">
                    <Button
                      size="sm"
                      variant={d?.byHand ? "default" : "outline"}
                      className="h-7 flex-1 text-[11px]"
                      onClick={() => labelByHand(item)}
                      title="No model got it right: go to this frame in the main view (this window closes) to label it by hand"
                      data-testid="review-none-right"
                    >
                      <PenLine className="mr-1 h-3 w-3" /> None are right
                    </Button>
                    <Button
                      size="sm"
                      variant={d?.skipped ? "default" : "outline"}
                      className="h-7 flex-1 text-[11px]"
                      onClick={() => {
                        skip(key);
                        next();
                      }}
                      title="Either is acceptable: leave it as is and go to the next one"
                      data-testid="review-skip"
                    >
                      <SkipForward className="mr-1 h-3 w-3" /> Skip
                    </Button>
                  </div>
                </div>
                {item.members.map((m) => {
                  const model = shown.find((x) => x.id === m.modelId);
                  if (!model) return null;
                  const accepted = d?.accepted === m.modelId;
                  return (
                    <div
                      key={m.modelId}
                      className={`flex flex-col rounded border p-1 ${accepted ? "border-green-500 bg-green-500/10" : "border-border"}`}
                      data-testid="review-pane"
                    >
                      <ModelCropCanvas
                        video={video}
                        frame={item.frame}
                        crop={crop}
                        poses={[{ modelId: m.modelId, color: model.color, xy: m.xy }]}
                        consensus={item.consensus}
                        rings={rings}
                        projectPoses={projectPoses}
                        edges={edges}
                        width={pane - 10}
                        height={pane - 76}
                      />
                      <div className="flex items-center gap-1 px-1 pt-1">
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: rgbToCSS(model.color) }} />
                        <span className="min-w-0 flex-1 truncate" title={model.source}>
                          {model.name}
                        </span>
                        <span className="tabular-nums text-muted-foreground" title="Mean distance of its nodes from the models' average">
                          {Number.isFinite(m.distance) ? `${m.distance.toFixed(1)} px` : "–"}
                        </span>
                      </div>
                      <div className="px-1 pt-1">
                        <Button
                          size="sm"
                          variant={accepted ? "default" : "outline"}
                          className="h-7 w-full text-[11px]"
                          onClick={() => void acceptForItem(item, m.modelId).then((ok) => ok && next())}
                          title="Make this model's pose a user instance (replaces the matching prediction; asks before replacing your own instance; ⌘Z undoes), then the next one"
                          data-testid="review-use"
                        >
                          <Check className="mr-1 h-3 w-3" /> Use this one
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
