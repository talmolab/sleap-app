/** Review prototypes (dev only): small parts every prototype shows. */
import { useMemo } from "react";
import { Eye, EyeOff } from "lucide-react";
import { projectPosesOnFrame, reviewItemKey, type ProjectPose, type ReviewGroup } from "@/lib/modelOverlay/reviewPrototype";
import { useAppStore } from "@/stores/appStore";
import { toggleProjectInstances } from "@/lib/modelOverlay/canvasActions";
import { rgbToCSS } from "@/lib/colorPalettes";
import { PROJECT_POSE_COLOR } from "./ModelCropCanvas";
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

/**
 * The project's own instances on `frame` for the crops, or undefined while
 * "Show project instances (H)" is off (then the crops leave them out, like
 * the main view). Refreshes after an Accept changes the frame.
 */
export function useProjectPoses(frame: number | null): ProjectPose[] | undefined {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const skeleton = useAppStore((s) => s.skeleton);
  const show = useAppStore((s) => s.showInstances);
  const version = useAppStore((s) => s.overlayVersion);
  return useMemo(() => {
    void version;
    if (!show || frame === null) return undefined;
    return projectPosesOnFrame(labels, video, frame, skeleton?.nodes.map((n) => n.name) ?? []);
  }, [labels, video, skeleton, show, frame, version]);
}

/**
 * Says how the project's instances look in the crops, or — very visibly —
 * that they're hidden (H), with a button to show them.
 */
export function ProjectInstancesKey({ count }: { count: number | null }) {
  const show = useAppStore((s) => s.showInstances);
  if (!show) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 rounded bg-amber-500/25 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-500/40 dark:text-amber-300"
        onClick={toggleProjectInstances}
        data-testid="review-proto-project-hidden"
        title="Your labels and the project's predictions are hidden (H). Click to show them in the crops and the main view."
      >
        <EyeOff className="h-3 w-3" /> Project instances hidden (H) · show
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-muted-foreground" data-testid="review-proto-project-key">
      <span className="inline-block h-0.5 w-4" style={{ backgroundColor: rgbToCSS(PROJECT_POSE_COLOR) }} />
      Project instances{count !== null ? ` (${count} here)` : ""}: solid = yours, dashed = predictions
      <button type="button" className="ml-1 rounded p-0.5 hover:bg-muted" onClick={toggleProjectInstances} title="Hide project instances (H)" aria-label="Hide project instances">
        <Eye className="h-3 w-3" />
      </button>
    </span>
  );
}
