/**
 * Compare model predictions — review-window PROTOTYPES (dev only; see
 * lib/modelOverlay/reviewPrototype.ts): which prototype is open, and what was
 * decided on each disagreement, shared by all three so they can be compared on
 * the same queue. Session only; nothing here is saved.
 */
import { create } from "zustand";
import type { ReviewLayout } from "@/lib/modelOverlay/reviewPrototype";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";

/**
 * What happened to one disagreement. Model predictions are expected to be
 * wrong sometimes; the review's job is to find the worst disagreements and
 * turn the best option into an instance, so there is no per-model "wrong".
 */
export interface ReviewDecision {
  /** "Use this one": the model whose pose became a user instance. */
  used: string | null;
  /** "Skip": either is acceptable, left as is. */
  skipped: boolean;
  /** "None are right": sent to the main view to label by hand. */
  byHand: boolean;
}

/** Default "show disagreements above" for the review prototypes, px (the corner panel keeps its own 10 px). */
export const DEFAULT_REVIEW_THRESHOLD_PX = 25;

interface CompareReviewState {
  open: ReviewLayout | null;
  setOpen: (layout: ReviewLayout | null) => void;
  /** Only disagreements above this many px are reviewed (bigger than the corner panel's rings). */
  threshold: number;
  setThreshold: (px: number) => void;
  decisions: Record<string, ReviewDecision>;
  use: (key: string, modelId: string) => void;
  skip: (key: string) => void;
  markByHand: (key: string) => void;
  /** Forget the decision on this item (the project edit itself is undone with ⌘Z). */
  reset: (key: string) => void;
  clearAll: () => void;
}

const empty: ReviewDecision = { used: null, skipped: false, byHand: false };

export const useCompareReviewStore = create<CompareReviewState>()((set) => ({
  open: null,
  setOpen: (layout) => set({ open: layout }),
  threshold: DEFAULT_REVIEW_THRESHOLD_PX,
  setThreshold: (px) => set((s) => ({ threshold: Number.isFinite(px) && px >= 0 ? px : s.threshold })),
  decisions: {},
  use: (key, modelId) => set((s) => ({ decisions: { ...s.decisions, [key]: { ...empty, used: modelId } } })),
  skip: (key) => set((s) => ({ decisions: { ...s.decisions, [key]: { ...empty, skipped: true } } })),
  markByHand: (key) => set((s) => ({ decisions: { ...s.decisions, [key]: { ...empty, byHand: true } } })),
  reset: (key) =>
    set((s) => {
      const decisions = { ...s.decisions };
      delete decisions[key];
      return { decisions };
    }),
  clearAll: () => set({ decisions: {} }),
}));

/** Whether an item has a decision (used, skipped, or sent to label by hand). */
export function isReviewed(d: ReviewDecision | undefined): boolean {
  return !!d && (d.used !== null || d.skipped || d.byHand);
}

/** Which models (and which poses) are loaded — not whether they're shown. */
function modelSetSignature(models: readonly OverlayModel[]): readonly unknown[] {
  return models.flatMap((m) => [m.id, m.frames, m.video]);
}

// Decisions belong to the models they were made on: loading, replacing or
// removing models (or opening another project, which removes them) forgets
// them. Hiding or showing a model doesn't (its items just change key).
let lastSignature = modelSetSignature(useModelOverlayStore.getState().models);
useModelOverlayStore.subscribe((s) => {
  const sig = modelSetSignature(s.models);
  const same = sig.length === lastSignature.length && sig.every((v, i) => v === lastSignature[i]);
  lastSignature = sig;
  if (!same && Object.keys(useCompareReviewStore.getState().decisions).length > 0) {
    useCompareReviewStore.getState().clearAll();
  }
});
