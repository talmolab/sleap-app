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
import { reviewGroupsOnFrame, reviewKey, type ReviewGroup } from "@/lib/modelOverlay/reviewPrototype";
import { acceptModelPose } from "@/lib/modelOverlay/canvasActions";
import { useCompareReviewStore } from "@/stores/compareReviewStore";

/** Most frames turned into review items (a prototype; enough to judge the layout). */
export const MAX_REVIEW_FRAMES = 3000;

export interface ReviewQueue {
  shown: OverlayModel[];
  /** 0–1 while the index is filling, 1 when ready. */
  progress: number;
  items: ReviewGroup[];
  /** More disagreement frames than {@link MAX_REVIEW_FRAMES} (the rest aren't listed). */
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
  const { items, truncated } = useMemo(() => {
    if (!ready) return { items: [] as ReviewGroup[], truncated: false };
    const frames = disagreementFrames(index, threshold);
    const out: ReviewGroup[] = [];
    for (const f of frames.slice(0, MAX_REVIEW_FRAMES)) out.push(...reviewGroupsOnFrame(shown, f, index.byTrack, threshold));
    out.sort((a, b) => a.frame - b.frame || a.group - b.group);
    return { items: out, truncated: frames.length > MAX_REVIEW_FRAMES };
  }, [ready, index, threshold, shown]);

  const progress = ready ? 1 : total > 0 ? (filled?.index === index ? filled.done : index.computed) / total : 1;
  return { shown, progress, items, truncated, threshold };
}

/** Go to the item's frame (the main view follows). */
export function goToItem(item: ReviewGroup): void {
  const app = useAppStore.getState();
  if (app.frameIdx !== item.frame) app.setFrameIdx(item.frame);
}

/**
 * Accept one model's pose for an item: go to its frame, then the same Accept
 * as Alt+double-click (user instance, replaces the matching prediction, one
 * undo step). Recorded in the prototype's decisions.
 */
export async function acceptForItem(item: ReviewGroup, modelId: string): Promise<void> {
  const m = item.members.find((x) => x.modelId === modelId);
  if (!m) return;
  goToItem(item);
  await acceptModelPose(modelId, m.poseIdx);
  useCompareReviewStore.getState().accept(reviewKey(item.frame, item.group), modelId);
}
