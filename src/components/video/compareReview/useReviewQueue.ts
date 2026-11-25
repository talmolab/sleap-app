/**
 * Compare Models review window: the queue of disagreements it steps
 * through, and the Accept action.
 *
 * The queue is built from the disagreement index (filled in time slices, with
 * progress) at the review's own threshold (default 25 px, bigger than the
 * corner panel's 10 px rings, so only big disagreements show): one item per
 * animal per frame where the shown models disagree, worst first.
 */
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import {
  disagreementFrames,
  disagreementIndexFor,
  fillIndexAsync,
  shownOn,
} from "@/lib/modelOverlay/disagreementIndex";
import { reviewGroupsOnFrame, reviewItemKey, type ReviewGroup } from "@/lib/modelOverlay/review";
import { useConfirmStore } from "@/stores/confirmStore";
import { acceptModelPose } from "@/lib/modelOverlay/canvasActions";
import { useCompareReviewStore } from "@/stores/compareReviewStore";

/**
 * Most frames turned into review items. When the video has more, the frames where the models disagree
 * most are kept, wherever they are in the video.
 */
export const MAX_REVIEW_FRAMES = 3000;

/** The `max` frames with the largest spread (ties: earlier frame), in frame order. */
export function worstFrames(frames: readonly number[], spreadOf: (frame: number) => number, max: number): number[] {
  if (frames.length <= max) return [...frames];
  return [...frames]
    .sort((a, b) => spreadOf(b) - spreadOf(a) || a - b)
    .slice(0, max)
    .sort((a, b) => a - b);
}

export interface ReviewQueue {
  shown: OverlayModel[];
  /** 0–1 while the index is filling, 1 when ready. */
  progress: number;
  items: ReviewGroup[];
  /** Disagreement frames in the whole video (more than listed when over {@link MAX_REVIEW_FRAMES}). */
  totalFrames: number;
  /** Only the worst {@link MAX_REVIEW_FRAMES} frames are listed. */
  truncated: boolean;
  threshold: number;
}

export function useReviewQueue(): ReviewQueue {
  const models = useModelOverlayStore((s) => s.models);
  const threshold = useCompareReviewStore((s) => s.threshold);
  const video = useAppStore((s) => s.video);
  const shown = useMemo(() => shownOn(models, video), [models, video]);
  const index = useMemo(() => disagreementIndexFor(models, video), [models, video]);
  const total = index.frames.length;
  const [filled, setFilled] = useState<{ index: typeof index; done: number } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void fillIndexAsync(index, {
      signal: ctrl.signal,
      onProgress: (done) => setFilled({ index, done }),
    });
    return () => ctrl.abort();
  }, [index]);

  const ready = total === 0 || (filled?.index === index && filled.done >= total) || index.computed >= total;
  const { items, truncated, totalFrames } = useMemo(() => {
    if (!ready) return { items: [] as ReviewGroup[], truncated: false, totalFrames: 0 };
    const frames = disagreementFrames(index, threshold);
    const rowOf = new Map<number, number>();
    index.frames.forEach((f, r) => rowOf.set(f, r));
    const kept = worstFrames(frames, (f) => index.maxSpread[rowOf.get(f) ?? -1] ?? -Infinity, MAX_REVIEW_FRAMES);
    const out: ReviewGroup[] = [];
    for (const f of kept) out.push(...reviewGroupsOnFrame(shown, f, index.byTrack, threshold));
    // Worst first: the biggest disagreements are the ones worth fixing.
    out.sort((a, b) => b.maxSpread - a.maxSpread || a.frame - b.frame || a.group - b.group);
    return { items: out, truncated: frames.length > MAX_REVIEW_FRAMES, totalFrames: frames.length };
  }, [ready, index, threshold, shown]);

  const progress = ready ? 1 : total > 0 ? (filled?.index === index ? filled.done : index.computed) / total : 1;
  return { shown, progress, items, truncated, totalFrames, threshold };
}

/** Go to the item's frame (the main view follows). */
export function goToItem(item: ReviewGroup): void {
  const app = useAppStore.getState();
  if (app.frameIdx !== item.frame) app.setFrameIdx(item.frame);
}

/**
 * Accept one model's pose for an item: go to its frame, then the same Accept
 * as Alt+double-click (user instance, replaces the matching prediction, one
 * undo step). Recorded in the review's decisions only when the project
 * really changed — not when "Replace your instance?" is cancelled or the
 * frame moved on. Resolves whether it was accepted.
 */
export async function acceptForItem(item: ReviewGroup, modelId: string): Promise<boolean> {
  const m = item.members.find((x) => x.modelId === modelId);
  if (!m) return false;
  goToItem(item);
  const ok = await acceptModelPose(modelId, m.poseIdx);
  if (ok) useCompareReviewStore.getState().accept(reviewItemKey(item), modelId);
  return ok;
}

/**
 * "None are right": go to the item's frame in the main view and close the
 * review, so the animal can be labeled by hand there.
 */
export function labelByHand(item: ReviewGroup): void {
  goToItem(item);
  const store = useCompareReviewStore.getState();
  store.markByHand(reviewItemKey(item));
  store.setOpen(false);
}

/**
 * Whether another dialog (e.g. "Replace your instance?") or a text field has
 * the keyboard, so the review's own keys (Esc, ←, →) must leave it alone.
 */
export function keysBelongElsewhere(e: KeyboardEvent): boolean {
  if (useConfirmStore.getState().request !== null) return true;
  if (typeof document !== "undefined" && document.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
