/**
 * Review prototypes (dev only): the queue of disagreements every prototype
 * steps through, and the shared Accept action.
 *
 * The queue is built from the disagreement index (filled in time slices, with
 * progress) at the corner panel's threshold: one item per animal per frame
 * where the shown models disagree, in frame order.
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
import { reviewGroupsOnFrame, reviewItemKey, type ReviewGroup } from "@/lib/modelOverlay/reviewPrototype";
import { isMockSource } from "@/lib/modelOverlay/core";
import { useConfirmStore } from "@/stores/confirmStore";
import { acceptModelPose } from "@/lib/modelOverlay/canvasActions";
import { useCompareReviewStore } from "@/stores/compareReviewStore";

/**
 * Most frames turned into review items (a prototype; enough to judge the
 * layout). When the video has more, the frames where the models disagree
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
  const threshold = useModelOverlayStore((s) => s.threshold);
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
    out.sort((a, b) => a.frame - b.frame || a.group - b.group);
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
 * undo step). Recorded in the prototype's decisions only when the project
 * really changed — not when "Replace your instance?" is cancelled or the
 * frame moved on. A mock model's pose is never written to the project; its
 * Accept only records the choice. Resolves whether it was accepted.
 */
export async function acceptForItem(item: ReviewGroup, modelId: string): Promise<boolean> {
  const m = item.members.find((x) => x.modelId === modelId);
  const model = useModelOverlayStore.getState().models.find((x) => x.id === modelId);
  if (!m || !model) return false;
  goToItem(item);
  const ok = isMockSource(model.source) ? true : await acceptModelPose(modelId, m.poseIdx);
  if (ok) useCompareReviewStore.getState().accept(reviewItemKey(item), modelId);
  return ok;
}

/**
 * Whether another dialog (e.g. "Replace your instance?") or a text field has
 * the keyboard, so a prototype's own keys (Esc, ←, →) must leave it alone.
 */
export function keysBelongElsewhere(e: KeyboardEvent): boolean {
  if (useConfirmStore.getState().request !== null) return true;
  if (typeof document !== "undefined" && document.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
