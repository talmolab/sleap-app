/** Review prototypes (dev only): small parts every prototype shows. */
import { reviewItemKey, type ReviewGroup } from "@/lib/modelOverlay/reviewPrototype";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";

/** "Indexing… 40%" while the index fills; then how many items, at what threshold. */
export function QueueStatus({
  progress,
  count,
  truncated,
  totalFrames,
  threshold,
  shown,
}: {
  progress: number;
  count: number;
  truncated: boolean;
  totalFrames: number;
  threshold: number;
  shown: number;
}) {
  let text: string;
  if (shown < 2) text = "Show two or more models to compare.";
  else if (progress < 1) text = `Finding disagreements… ${Math.round(progress * 100)}%`;
  else if (count === 0) text = `No disagreements above ${threshold} px. Lower the threshold in the corner panel.`;
  else text = `${count} disagreement${count === 1 ? "" : "s"} above ${threshold} px${truncated ? ` — only the worst frames: ${totalFrames} frames disagree in all` : ""}`;
  return (
    <div className="px-2 py-1 text-muted-foreground" data-testid="review-proto-status">
      {text}
    </div>
  );
}

/** Accepted / rejected / skipped / left, over the whole queue. */
export function ReviewSummary({ items }: { items: readonly ReviewGroup[] }) {
  const decisions = useCompareReviewStore((s) => s.decisions);
  if (items.length === 0) return null;
  let accepted = 0;
  let rejected = 0;
  let skipped = 0;
  let left = 0;
  for (const it of items) {
    const d = decisions[reviewItemKey(it)];
    if (!isReviewed(d)) left++;
    else if (d!.accepted) accepted++;
    else if (d!.rejected.length > 0) rejected++;
    else skipped++;
  }
  return (
    <div className="flex gap-2 border-t border-border px-2 py-1 tabular-nums text-muted-foreground" data-testid="review-proto-summary">
      <span className="text-green-600 dark:text-green-400">{accepted} accepted</span>
      <span>{rejected} rejected</span>
      <span>{skipped} fine</span>
      <span className="flex-1" />
      <span>{left} left</span>
    </div>
  );
}
