/**
 * Review prototype C (dev only): a grid of crops. Many disagreements at once,
 * each a crop around the animal with every model's pose and the disputed
 * nodes ringed red. Under each crop, one colour chip per model: click a chip
 * to accept that model's pose there; ✓ marks the crop fine. Page through, or
 * sort by how badly the models disagree. Double-click a crop to look at it in
 * the main view.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rgbToCSS } from "@/lib/colorPalettes";
import { useAppStore } from "@/stores/appStore";
import { useCompareReviewStore } from "@/stores/compareReviewStore";
import { cropAround, itemRings, reviewKey, type ReviewGroup } from "@/lib/modelOverlay/reviewPrototype";
import { videoDims } from "@/lib/modelOverlay/core";
import type { OverlayModel } from "@/stores/modelOverlayStore";
import type { Video } from "@/types";
import { acceptForItem, goToItem, useReviewQueue } from "./useReviewQueue";
import { ModelCropCanvas } from "./ModelCropCanvas";
import { QueueStatus, ReviewSummary } from "./reviewParts";

const PAGE = 12;
const CELL = 200;

function GridCell({
  item,
  shown,
  video,
  edges,
  onOpen,
}: {
  item: ReviewGroup;
  shown: readonly OverlayModel[];
  video: Video;
  edges: readonly (readonly [number, number])[];
  onOpen: () => void;
}) {
  const key = reviewKey(item.frame, item.group);
  const d = useCompareReviewStore((s) => s.decisions[key]);
  const skip = useCompareReviewStore((s) => s.skip);
  const reset = useCompareReviewStore((s) => s.reset);
  const dims = useMemo(() => videoDims(video), [video]);
  const crop = useMemo(() => cropAround(item.members.map((m) => m.xy), dims.width, dims.height, 0.5), [item, dims]);
  const rings = useMemo(() => itemRings(item), [item]);
  const poses = useMemo(
    () =>
      item.members.flatMap((m) => {
        const model = shown.find((x) => x.id === m.modelId);
        return model ? [{ modelId: m.modelId, color: model.color, xy: m.xy }] : [];
      }),
    [item, shown]
  );
  const done = d?.accepted || d?.skipped;
  return (
    <div
      className={`rounded border p-1 ${d?.accepted ? "border-green-500 bg-green-500/10" : d?.skipped ? "border-border opacity-60" : "border-border"}`}
      data-testid="review-proto-cell"
    >
      <div onDoubleClick={onOpen} title="Double-click to look at it in the main view" className="cursor-zoom-in">
        <ModelCropCanvas video={video} frame={item.frame} crop={crop} poses={poses} rings={rings} edges={edges} width={CELL - 10} height={CELL - 50} />
      </div>
      <div className="flex items-center gap-1 px-0.5 pt-1 tabular-nums text-muted-foreground">
        <span>f {item.frame}</span>
        <span className="text-red-600 dark:text-red-400">{item.maxSpread.toFixed(0)} px</span>
        <span className="flex-1" />
        {done ? (
          <button type="button" className="rounded px-1 hover:bg-muted" onClick={() => reset(key)} title="Clear this decision (⌘Z undoes an Accept in the project)">
            undo
          </button>
        ) : (
          <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={() => skip(key)} title="Fine as is" aria-label="Fine as is">
            <Check className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1 px-0.5 pt-0.5">
        {item.members.map((m) => {
          const model = shown.find((x) => x.id === m.modelId);
          if (!model) return null;
          const accepted = d?.accepted === m.modelId;
          return (
            <button
              key={m.modelId}
              type="button"
              className={`h-4 w-4 rounded-full border-2 ${accepted ? "border-foreground" : "border-transparent hover:border-muted-foreground"}`}
              style={{ backgroundColor: rgbToCSS(model.color) }}
              onClick={() => void acceptForItem(item, m.modelId)}
              title={`Accept ${model.name} here (${Number.isFinite(m.distance) ? m.distance.toFixed(1) : "–"} px from the average)`}
              aria-label={`Accept ${model.name}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ReviewGridPrototype({ onClose }: { onClose: () => void }) {
  const { shown, progress, items, truncated, threshold } = useReviewQueue();
  const video = useAppStore((s) => s.video);
  const skeleton = useAppStore((s) => s.skeleton);
  const [page, setPage] = useState(0);
  const [order, setOrder] = useState<"frame" | "spread">("spread");
  const edges = useMemo(() => skeleton?.edgeIndices ?? [], [skeleton]);

  const sorted = useMemo(
    () => (order === "frame" ? items : [...items].sort((a, b) => b.maxSpread - a.maxSpread || a.frame - b.frame)),
    [items, order]
  );
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const p = Math.min(page, pages - 1);
  const onPage = sorted.slice(p * PAGE, (p + 1) * PAGE);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "PageDown") setPage((x) => Math.min(pages - 1, x + 1));
      else if (e.key === "ArrowLeft" || e.key === "PageUp") setPage((x) => Math.max(0, x - 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pages]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="review-proto-grid" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-[92vh] max-w-[95vw] flex-col rounded-lg border border-border bg-background text-xs shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Review disagreements</span>
          <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-600 dark:text-amber-400">prototype C · crop grid</span>
          <span className="flex-1" />
          <select className="rounded border border-border bg-background px-1 py-0.5" value={order} onChange={(e) => setOrder(e.target.value as "frame" | "spread")} aria-label="Order">
            <option value="spread">Worst first</option>
            <option value="frame">By frame</option>
          </select>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => setPage(p - 1)} disabled={p === 0} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[5rem] text-center tabular-nums">
            page {p + 1} / {pages}
          </span>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => setPage(p + 1)} disabled={p >= pages - 1} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <button type="button" className="ml-2 rounded p-1 hover:bg-muted" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <QueueStatus progress={progress} count={items.length} truncated={truncated} threshold={threshold} shown={shown.length} />
        <div className="px-3 pb-1 text-muted-foreground">Click a colour to accept that model's pose · ✓ = fine as is · double-click a crop to open it in the main view</div>
        {video && (
          <div className="min-h-0 overflow-auto px-3 pb-2">
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(4, ${CELL}px)` }}>
              {onPage.map((it) => (
                <GridCell
                  key={reviewKey(it.frame, it.group)}
                  item={it}
                  shown={shown}
                  video={video}
                  edges={edges}
                  onOpen={() => {
                    goToItem(it);
                    onClose();
                  }}
                />
              ))}
            </div>
          </div>
        )}
        <ReviewSummary items={items} />
      </div>
    </div>
  );
}
