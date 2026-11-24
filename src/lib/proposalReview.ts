/**
 * Where the user reviews Claude's proposals, and the QC Review window's A / X
 * keys for them.
 *
 * - Fixes and ignores (QC flags on user instances) show in the Label QC
 *   Review window, as a "Claude suggests" row for the instance on screen.
 * - Corrections (predictions) show in Compare Models' "Review disagreements"
 *   window as a "Claude's suggestion" pane — next to the models' panes when
 *   the models disagree on that animal, else next to the project's own
 *   prediction (no models needed).
 *
 * In QC Review the proposal shown is the latest one for the selected instance
 * on this frame; with none for it (or nothing selected), the first pending
 * one on the frame. With an instance selected, A / X only act on its own
 * proposal, so they never change an animal the user isn't looking at.
 */
import { useAppStore } from "@/stores/appStore";
import { openQcReview, useQcStore } from "@/stores/qcStore";
import { useCompareReviewStore } from "@/stores/compareReviewStore";
import { canAccept, proposalInstance, proposalState, useProposalStore, type Proposal } from "@/stores/proposalStore";
import { AutomationError } from "@/automation/errors";
import { toast } from "@/lib/notify";
import type { Instance } from "@/types";

/** Whether `p` is about `inst`. */
export function proposalIsAbout(p: Proposal, inst: Instance | null): boolean {
  return !!inst && proposalInstance(p) === inst;
}

/** The QC proposal (fix or ignore) the Label QC Review window shows for the frame on screen. */
export function currentProposal(): Proposal | null {
  const app = useAppStore.getState();
  const labels = app.labels;
  const proposals = useProposalStore.getState().proposals;
  if (!labels || !app.video || proposals.length === 0) return null;
  const videoIdx = labels.videos.indexOf(app.video);
  // Corrections are reviewed in Compare Models' Review disagreements window.
  const here = proposals.filter((p) => p.kind !== "correct" && p.videoIdx === videoIdx && p.frameIdx === app.frameIdx);
  if (here.length === 0) return null;
  const mine = here.filter((p) => proposalIsAbout(p, app.instance));
  if (mine.length > 0) return mine[mine.length - 1];
  return here.find((p) => canAccept(p)) ?? null;
}

/** Run a proposal action from the UI: errors become a toast. */
async function attempt(what: string, fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toast.error(e instanceof AutomationError ? e.message : `Couldn't ${what}: ${String(e)}`);
    return false;
  }
}

export const acceptProposal = (id: string) =>
  attempt("apply Claude's suggestion", () => useProposalStore.getState().accept(id));
export const revertProposal = (id: string) =>
  attempt("revert Claude's suggestion", () => useProposalStore.getState().revert(id));
export const rejectProposal = (id: string) => void attempt("reject", () => useProposalStore.getState().reject(id));
export const unrejectProposal = (id: string) => void attempt("undo the reject", () => useProposalStore.getState().unreject(id));

/**
 * Review's A (accept) / X (reject) for the proposal shown. Returns false (key
 * not handled) outside Review or with no pending proposal on screen.
 */
export function handleProposalKey(key: "accept" | "reject"): boolean {
  if (!useQcStore.getState().reviewOpen) return false;
  const p = currentProposal();
  // With an instance selected, only its own suggestion: the row falls back to
  // another animal's when the selected one has none, and A mustn't change that.
  const selected = useAppStore.getState().instance;
  if (!p || (selected && !proposalIsAbout(p, selected))) return false;
  if (key === "accept") {
    // An outdated one is refused with a message (handled, so A isn't passed on).
    if (p.status !== "pending" && !canAccept(p)) return false;
    void acceptProposal(p.id);
  } else {
    if (p.status !== "pending") return false;
    rejectProposal(p.id);
  }
  return true;
}

/** Proposals the user can still decide on (pending, or undone). */
export const undecidedCount = (proposals: readonly Proposal[]) =>
  proposals.filter((p) => {
    const st = proposalState(p);
    return st === "pending" || st === "undone";
  }).length;

/** In frame order. */
const byFrame = (a: Proposal, b: Proposal) => a.videoIdx - b.videoIdx || a.frameIdx - b.frameIdx;

/**
 * Open the window where Claude's proposals are reviewed: Compare Models'
 * Review disagreements window at the first correction still to decide (or
 * the first correction), else Label QC Review at the first QC proposal.
 * False (with a hint) when there is nothing to show.
 */
export function openClaudeSuggestions(): boolean {
  const app = useAppStore.getState();
  const proposals = [...useProposalStore.getState().proposals].sort(byFrame);
  const corrections = proposals.filter((p) => p.kind === "correct");
  if (!app.labels || proposals.length === 0) {
    toast.info("Claude hasn't suggested anything yet.");
    return false;
  }
  if (corrections.length > 0) {
    const first = corrections.find((p) => canAccept(p)) ?? corrections[0];
    const video = app.labels.videos[first.videoIdx];
    if (video && app.video !== video) app.setVideo(video);
    const review = useCompareReviewStore.getState();
    review.setFocusProposal(first.id);
    review.setOpen(true);
    return true;
  }
  const first = proposals.find((p) => canAccept(p)) ?? proposals[0];
  if (!openQcReview()) return false;
  const video = app.labels.videos[first.videoIdx];
  if (video && useAppStore.getState().video !== video) useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(first.frameIdx);
  useAppStore.getState().setInstance(proposalInstance(first));
  return true;
}

// ---------------------------------------------------------------------------
// "Claude suggested N changes" toast

const TOAST_ID = "claude-suggestions";
/** Wait for Claude to finish a batch before telling the user. */
const TOAST_DELAY_MS = 1500;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showSuggestionsToast(): void {
  toastTimer = null;
  // Already looking at them.
  if (useCompareReviewStore.getState().open) return;
  const n = undecidedCount(useProposalStore.getState().proposals);
  if (n === 0) return;
  toast.info(`Claude suggested ${n} change${n === 1 ? "" : "s"}`, {
    id: TOAST_ID,
    description: "Nothing changes until you accept them.",
    duration: 15_000,
    action: { label: "Review", onClick: () => void openClaudeSuggestions() },
  });
}

useProposalStore.subscribe((s, prev) => {
  if (typeof window === "undefined") return;
  const seen = new Set(prev.proposals.map((p) => p.id));
  if (!s.proposals.some((p) => !seen.has(p.id))) return;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(showSuggestionsToast, TOAST_DELAY_MS);
});
