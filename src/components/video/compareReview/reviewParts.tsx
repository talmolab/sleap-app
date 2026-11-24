/** Compare Models review window: small shared parts (status, footer, threshold, project instances). */
import { useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { projectPosesOnFrame, reviewItemKey, type ProjectPose, type ReviewGroup } from "@/lib/modelOverlay/review";
import { useAppStore } from "@/stores/appStore";
import { toggleProjectInstances } from "@/lib/modelOverlay/canvasActions";
import { rgbToCSS } from "@/lib/colorPalettes";
import { PROJECT_POSE_COLOR } from "./ModelCropCanvas";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { proposalState, type Proposal } from "@/stores/proposalStore";

/** "Finding disagreements… 40%", "none above N px", or the cap note — nothing when the header already says it all. */
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
  else if (truncated) text = `Only the worst frames are listed: ${totalFrames} frames disagree in all.`;
  // The count and threshold are already in the header ("above N px", "i / N").
  else return null;
  return (
    <div className="px-2 py-1 text-muted-foreground" data-testid="review-status">
      {text}
    </div>
  );
}

/**
 * Accepted / skipped / to label by hand / left, over the whole queue. With
 * `entries` (the queue including Claude's items), an item whose Claude
 * suggestion was accepted counts as accepted.
 */
export function ReviewSummary({
  items,
  entries,
}: {
  items: readonly ReviewGroup[];
  entries?: readonly { key: string; claude: Proposal | null }[];
}) {
  const decisions = useCompareReviewStore((s) => s.decisions);
  const list = entries ?? items.map((it) => ({ key: reviewItemKey(it), claude: null }));
  if (list.length === 0) return null;
  let accepted = 0;
  let skipped = 0;
  let byHand = 0;
  let left = 0;
  for (const it of list) {
    const d = decisions[it.key];
    if (it.claude && proposalState(it.claude) === "accepted") accepted++;
    else if (!isReviewed(d)) left++;
    else if (d!.accepted) accepted++;
    else if (d!.byHand) byHand++;
    else skipped++;
  }
  return (
    <div className="flex gap-2 border-t border-border px-2 py-1 tabular-nums text-muted-foreground" data-testid="review-summary">
      <span className="text-green-600 dark:text-green-400" title='Poses you turned into instances with "Use this one"'>
        {accepted} accepted
      </span>
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
        data-testid="review-threshold"
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
        data-testid="review-project-hidden"
        title="Your labels and the project's predictions are hidden (H). Click to show them in the crops and the main view."
      >
        <EyeOff className="h-3 w-3" /> Project instances hidden (H) · show
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-muted-foreground" data-testid="review-project-key">
      <span className="inline-block h-0.5 w-4" style={{ backgroundColor: rgbToCSS(PROJECT_POSE_COLOR) }} />
      Project instances{count !== null ? ` (${count} here)` : ""}: solid = yours, dashed = predictions
      <button type="button" className="ml-1 rounded p-0.5 hover:bg-muted" onClick={toggleProjectInstances} title="Hide project instances (H)" aria-label="Hide project instances">
        <Eye className="h-3 w-3" />
      </button>
    </span>
  );
}

/** A typed whole number in [min, max], or null (empty, not a number, out of range). */
export function parseJumpNumber(text: string, min: number, max: number): number | null {
  if (text.trim() === "") return null;
  const v = Number(text);
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** The queue position of the item whose frame is nearest `frame` (ties: the earlier frame), or -1. */
export function nearestItemToFrame(items: readonly { frame: number }[], frame: number): number {
  let best = -1;
  for (let i = 0; i < items.length; i++) {
    if (best < 0) {
      best = i;
      continue;
    }
    const d = Math.abs(items[i].frame - frame);
    const bd = Math.abs(items[best].frame - frame);
    if (d < bd || (d === bd && items[i].frame < items[best].frame)) best = i;
  }
  return best;
}

/**
 * A number in the header you can click to type a new one: "3" → an input.
 * Keeps what you type (clear and retype freely); Enter or clicking away
 * commits a whole number in [min, max] — anything else puts the old value
 * back; Esc cancels.
 */
export function JumpNumber({
  value,
  min,
  max,
  onCommit,
  label,
  testId,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
  label: string;
  testId: string;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text !== null) {
      const v = parseJumpNumber(text, min, max);
      if (v !== null && v !== value) onCommit(v);
    }
    setText(null);
  };
  if (text === null) {
    return (
      <button
        type="button"
        className={`rounded px-0.5 tabular-nums underline decoration-dotted underline-offset-2 hover:bg-muted ${className ?? ""}`}
        onClick={() => setText(String(value))}
        title={`${label}: click to type a number`}
        data-testid={testId}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type="number"
      min={min}
      max={max}
      className="w-16 rounded border border-border bg-background px-1 text-right tabular-nums text-foreground"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(null);
      }}
      aria-label={label}
      data-testid={`${testId}-input`}
    />
  );
}
