/**
 * Review prototype A (dev only): a stepper. A narrow panel docked on the
 * right walks through the disagreements one at a time, like the QC Review
 * window: the main view jumps to each one, and every model gets a row with
 * how far it is from the others, Accept (its pose becomes a user instance)
 * and Reject (mark it wrong here). Accept moves on to the next item.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rgbToCSS } from "@/lib/colorPalettes";
import { useAppStore } from "@/stores/appStore";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { reviewKey } from "@/lib/modelOverlay/reviewPrototype";
import { acceptForItem, goToItem, useReviewQueue } from "./useReviewQueue";
import { QueueStatus, ReviewSummary } from "./reviewParts";

export function ReviewStepperPrototype({ onClose }: { onClose: () => void }) {
  const { shown, progress, items, truncated, threshold } = useReviewQueue();
  const skeleton = useAppStore((s) => s.skeleton);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const decisions = useCompareReviewStore((s) => s.decisions);
  const toggleReject = useCompareReviewStore((s) => s.toggleReject);
  const skip = useCompareReviewStore((s) => s.skip);
  const [pos, setPos] = useState(0);

  // Start at the first item on or after the frame on screen.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started || items.length === 0) return;
    const i = items.findIndex((it) => it.frame >= frameIdx);
    setPos(i >= 0 ? i : 0);
    setStarted(true);
  }, [items, frameIdx, started]);

  const at = Math.min(pos, Math.max(0, items.length - 1));
  const item = items[at];
  useEffect(() => {
    if (item) goToItem(item);
  }, [item]);

  const nodeNames = useMemo(() => skeleton?.nodes.map((n) => n.name) ?? [], [skeleton]);
  const go = (d: number) => setPos(Math.max(0, Math.min(items.length - 1, at + d)));
  const nextUnreviewed = () => {
    for (let i = at + 1; i < items.length; i++) {
      if (!isReviewed(decisions[reviewKey(items[i].frame, items[i].group)])) return setPos(i);
    }
    go(1);
  };
  const key = item ? reviewKey(item.frame, item.group) : "";
  const d = decisions[key];

  return (
    <div
      className="fixed right-2 top-14 bottom-24 z-40 flex w-80 flex-col rounded-md border border-border bg-background/95 text-xs shadow-xl backdrop-blur"
      data-testid="review-proto-stepper"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="font-semibold">Review disagreements</span>
        <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-600 dark:text-amber-400">prototype A</span>
        <span className="flex-1" />
        <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={onClose} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <QueueStatus progress={progress} count={items.length} truncated={truncated} threshold={threshold} shown={shown.length} />
      {item && (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5">
            <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => go(-1)} disabled={at === 0} aria-label="Previous">
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <div className="flex-1 text-center tabular-nums">
              <div className="font-semibold">
                {at + 1} / {items.length}
              </div>
              <div className="text-muted-foreground">
                frame {item.frame}
                {item.trackName ? ` · ${item.trackName}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 w-6 p-0"
              onClick={() => go(1)}
              disabled={at >= items.length - 1}
              aria-label="Next"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="border-t border-border px-2 py-1.5">
            <div className="mb-1 font-medium text-muted-foreground">Nodes the models disagree on</div>
            <div className="flex flex-wrap gap-1">
              {item.flagged.map((k) => (
                <span key={k} className="rounded bg-red-500/15 px-1.5 py-0.5 tabular-nums text-red-600 dark:text-red-400">
                  {nodeNames[k] ?? `node ${k}`} {item.spread[k].toFixed(0)} px
                </span>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-1 py-1">
            {[...item.members]
              .sort((a, b) => a.distance - b.distance)
              .map((m) => {
                const model = shown.find((x) => x.id === m.modelId);
                if (!model) return null;
                const accepted = d?.accepted === m.modelId;
                const rejected = d?.rejected.includes(m.modelId) ?? false;
                return (
                  <div
                    key={m.modelId}
                    className={`flex items-center gap-1.5 rounded px-1 py-1 ${accepted ? "bg-green-500/15" : ""} ${rejected ? "opacity-50" : ""}`}
                    data-testid="review-proto-model-row"
                  >
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: rgbToCSS(model.color) }} />
                    <span className={`min-w-0 flex-1 truncate ${rejected ? "line-through" : ""}`} title={model.source}>
                      {model.name}
                    </span>
                    <span className="tabular-nums text-muted-foreground" title="Mean distance of its nodes from the models' average">
                      {Number.isFinite(m.distance) ? `${m.distance.toFixed(1)} px` : "–"}
                    </span>
                    <Button
                      size="sm"
                      variant={accepted ? "default" : "outline"}
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => void acceptForItem(item, m.modelId).then(nextUnreviewed)}
                      title="Make this model's pose a user instance (undoable), then go to the next item"
                    >
                      <Check className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant={rejected ? "destructive" : "outline"}
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => toggleReject(key, m.modelId)}
                      title="Mark this model wrong here"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
          </div>
          <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              onClick={() => {
                skip(key);
                nextUnreviewed();
              }}
            >
              <SkipForward className="mr-1 h-3 w-3" /> Looks fine, next
            </Button>
            <span className="flex-1" />
            <span className="text-muted-foreground">sorted closest to the others first</span>
          </div>
        </>
      )}
      <ReviewSummary items={items} />
    </div>
  );
}
