/**
 * Compare model predictions — review-window PROTOTYPES (dev only; see
 * lib/modelOverlay/reviewPrototype.ts): which prototype is open, and what was
 * decided on each disagreement, shared by all three so they can be compared on
 * the same queue. Session only; nothing here is saved.
 */
import { create } from "zustand";
import type { ReviewLayout } from "@/lib/modelOverlay/reviewPrototype";

export interface ReviewDecision {
  /** The model whose pose was accepted (became a user instance). */
  accepted: string | null;
  /** Models marked wrong here. */
  rejected: string[];
  /** Looked at and left as is. */
  skipped: boolean;
}

interface CompareReviewState {
  open: ReviewLayout | null;
  setOpen: (layout: ReviewLayout | null) => void;
  decisions: Record<string, ReviewDecision>;
  accept: (key: string, modelId: string) => void;
  /** Toggle "this model is wrong here". */
  toggleReject: (key: string, modelId: string) => void;
  skip: (key: string) => void;
  /** Undo every decision on this item (the project edit itself is undone with ⌘Z). */
  reset: (key: string) => void;
  clearAll: () => void;
}

const empty: ReviewDecision = { accepted: null, rejected: [], skipped: false };

export const useCompareReviewStore = create<CompareReviewState>()((set) => ({
  open: null,
  setOpen: (layout) => set({ open: layout }),
  decisions: {},
  accept: (key, modelId) =>
    set((s) => ({
      decisions: {
        ...s.decisions,
        [key]: { ...(s.decisions[key] ?? empty), accepted: modelId, rejected: (s.decisions[key]?.rejected ?? []).filter((m) => m !== modelId), skipped: false },
      },
    })),
  toggleReject: (key, modelId) =>
    set((s) => {
      const d = s.decisions[key] ?? empty;
      const rejected = d.rejected.includes(modelId) ? d.rejected.filter((m) => m !== modelId) : [...d.rejected, modelId];
      return {
        decisions: { ...s.decisions, [key]: { ...d, rejected, accepted: d.accepted === modelId ? null : d.accepted } },
      };
    }),
  skip: (key) => set((s) => ({ decisions: { ...s.decisions, [key]: { ...(s.decisions[key] ?? empty), skipped: true } } })),
  reset: (key) =>
    set((s) => {
      const decisions = { ...s.decisions };
      delete decisions[key];
      return { decisions };
    }),
  clearAll: () => set({ decisions: {} }),
}));

/** Whether an item has any decision (accepted, a model rejected, or skipped). */
export function isReviewed(d: ReviewDecision | undefined): boolean {
  return !!d && (d.accepted !== null || d.rejected.length > 0 || d.skipped);
}
