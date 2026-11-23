/**
 * Lets another queue take over the Label QC Review window's step keys
 * (← / → and 0), so the same window can step through something other than QC
 * flags — Claude's suggestions (lib/proposalReview.ts). A separate module so
 * qcStore needn't import the proposal code (which imports qcStore).
 */
export type ReviewStepKey = "frame next" | "frame prev" | "refit";

let override: ((key: ReviewStepKey) => boolean) | null = null;

/** Install (or with null, remove) the handler. It returns whether it took the key. */
export function setReviewKeyOverride(handler: ((key: ReviewStepKey) => boolean) | null): void {
  override = handler;
}

/** Offer a step key to the override first; true when it took it. */
export function reviewKeyOverride(key: ReviewStepKey): boolean {
  return override?.(key) ?? false;
}
