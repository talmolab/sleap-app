/**
 * Compare model predictions — the review window: whether it is open, its own
 * threshold, and what was decided on each disagreement. Session only;
 * nothing here is saved (the instances "Use this one" makes are, as edits).
 */
import { create } from "zustand";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";

/**
 * What happened to one disagreement. Model predictions are expected to be
 * wrong sometimes; the review's job is to find the worst disagreements and
 * turn the best option into an instance, so there is no per-model "wrong".
 */
export interface ReviewDecision {
  /** Accepted with "Use this one": the model whose pose became a user instance. */
  accepted: string | null;
  /** "Skip": either is acceptable, left as is. */
  skipped: boolean;
  /** "None are right": sent to the main view to label by hand. */
  byHand: boolean;
}

/** Default "show disagreements above" for the review, px (the corner panel keeps its own 10 px). */
export const DEFAULT_REVIEW_THRESHOLD_PX = 25;

interface CompareReviewState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Only disagreements above this many px are reviewed (bigger than the corner panel's rings). */
  threshold: number;
  setThreshold: (px: number) => void;
  decisions: Record<string, ReviewDecision>;
  accept: (key: string, modelId: string) => void;
  skip: (key: string) => void;
  markByHand: (key: string) => void;
  /** Forget the decision on this item (the project edit itself is undone with ⌘Z). */
  reset: (key: string) => void;
  clearAll: () => void;
}

const empty: ReviewDecision = { accepted: null, skipped: false, byHand: false };

export const useCompareReviewStore = create<CompareReviewState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  threshold: DEFAULT_REVIEW_THRESHOLD_PX,
  setThreshold: (px) => set((s) => ({ threshold: Number.isFinite(px) && px >= 0 ? px : s.threshold })),
  decisions: {},
  accept: (key, modelId) => set((s) => ({ decisions: { ...s.decisions, [key]: { ...empty, accepted: modelId } } })),
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

/** Whether an item has a decision (accepted, skipped, or sent to label by hand). */
export function isReviewed(d: ReviewDecision | undefined): boolean {
  return !!d && (d.accepted !== null || d.skipped || d.byHand);
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
