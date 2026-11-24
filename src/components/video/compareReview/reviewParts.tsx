/** Review prototypes (dev only): small parts every prototype shows. */
import { useMemo, useState } from "react";
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
  else if (count === 0) text = `No disagreements above ${threshold} px. Lower "above … px" to see smaller ones.`;
  else text = `${count} disagreement${count === 1 ? "" : "s"} above ${threshold} px, worst first${truncated ? ` — only the worst frames: ${totalFrames} frames disagree in all` : ""}`;
  return (
    <div className="px-2 py-1 text-muted-foreground" data-testid="review-proto-status">
      {text}
    </div>
  );
}

/** Used / skipped / to label by hand / left, over the whole queue. */
export function ReviewSummary({ items }: { items: readonly ReviewGroup[] }) {
  const decisions = useCompareReviewStore((s) => s.decisions);
  if (items.length === 0) return null;
  let used = 0;
  let skipped = 0;
  let byHand = 0;
  let left = 0;
  for (const it of items) {
    const d = decisions[reviewItemKey(it)];
    if (!isReviewed(d)) left++;
    else if (d!.used) used++;
    else if (d!.byHand) byHand++;
    else skipped++;
  }
  return (
    <div className="flex gap-2 border-t border-border px-2 py-1 tabular-nums text-muted-foreground" data-testid="review-proto-summary">
      <span className="text-green-600 dark:text-green-400">{used} used</span>
      <span>· {skipped} skipped</span>
      {byHand > 0 && <span>· {byHand} to label by hand</span>}
      <span>· {left} left</span>
    </div>
  );
}

/** The typed threshold in px, or null when it isn't a number ≥ 0 (empty, "-", "abc"). 0 is allowed: every disagreement. */
export function parseReviewThreshold(text: string): number | null {
  if (text.trim() === "") return null;
  const v = Number(text);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * "Above [25] px": the review's own threshold (the corner panel's rings keep
 * theirs). The box keeps what you type, so it can be cleared and retyped
 * (e.g. to 0); only a valid number ≥ 0 reaches the review. Blur or Esc puts
 * back the value in use; Enter commits it.
 */
export function ReviewThresholdInput() {
  const threshold = useCompareReviewStore((s) => s.threshold);
  const setThreshold = useCompareReviewStore((s) => s.setThreshold);
  // The box's own text while editing; null = show the value in use.
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-1 text-muted-foreground" title="Only disagreements bigger than this (RMS spread across the models) are listed; 0 lists all">
      above
      <input
        type="number"
        min={0}
        step={5}
        className="w-12 rounded border border-border bg-background px-1 text-right tabular-nums text-foreground"
        value={text ?? String(threshold)}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseReviewThreshold(e.target.value);
          if (v !== null) setThreshold(v);
        }}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setText(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            // Esc here only reverts the box (the review window ignores keys typed in a field).
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label="Review disagreements above, px"
        data-testid="review-proto-threshold"
      />
      px
    </label>
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
