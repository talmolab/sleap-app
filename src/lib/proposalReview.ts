/**
 * Where the user reviews Claude's proposals.
 *
 * - Fixes and ignores (QC flags on the user's own labels) show in the Label
 *   QC Review window, as a "Claude suggests" row for the instance on screen,
 *   with its A / X keys (unchanged from phase 1). The proposal shown is the
 *   latest one for the selected instance on this frame; with none for it (or
 *   nothing selected), the first pending one on the frame.
 * - Corrections (predictions) show in Compare Models' "Review disagreements"
 *   window as a "Claude's suggestion" pane — next to the models' panes when
 *   the models disagree on that animal, else next to the project's own
 *   prediction (no models needed). The toast and the Environment panel's
 *   button open that window.
 */
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { useCompareReviewStore } from "@/stores/compareReviewStore";
import { canAccept, correctionResult, proposalInstance, proposalState, useProposalStore, type Proposal } from "@/stores/proposalStore";
import { AutomationError } from "@/automation/errors";
import { toast } from "@/lib/notify";

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
  const lf = app.labeledFrame;
  const instIdx = app.instance && lf ? lf.userInstances.indexOf(app.instance) : -1;
  const mine = here.filter((p) => p.instIdx === instIdx);
  if (mine.length > 0) return mine[mine.length - 1];
  return here.find((p) => canAccept(p)) ?? null;
}

/** Accept a proposal from the UI: errors become a toast. */
export async function acceptProposal(id: string): Promise<boolean> {
  try {
    await useProposalStore.getState().accept(id);
    return true;
  } catch (e) {
    toast.error(e instanceof AutomationError ? e.message : `Couldn't apply Claude's suggestion: ${String(e)}`);
    return false;
  }
}

export function rejectProposal(id: string): void {
  try {
    useProposalStore.getState().reject(id);
  } catch (e) {
    toast.error(e instanceof AutomationError ? e.message : String(e));
  }
}

/** Revert an accepted correction from the UI (Review disagreements): errors become a toast. */
export async function revertProposal(id: string): Promise<boolean> {
  try {
    await useProposalStore.getState().revert(id);
    return true;
  } catch (e) {
    toast.error(e instanceof AutomationError ? e.message : `Couldn't revert Claude's suggestion: ${String(e)}`);
    return false;
  }
}

/** Undo a reject from the UI (Review disagreements). */
export function unrejectProposal(id: string): void {
  try {
    useProposalStore.getState().unreject(id);
  } catch (e) {
    toast.error(e instanceof AutomationError ? e.message : String(e));
  }
}

/**
 * Review's A (accept) / X (reject) for the proposal shown. Returns false (key
 * not handled) outside Review or with no pending proposal on screen.
 */
export function handleProposalKey(key: "accept" | "reject"): boolean {
  if (!useQcStore.getState().reviewOpen) return false;
  const p = currentProposal();
  if (!p) return false;
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

/** Claude's corrections of predictions, in frame order. */
const corrections = () =>
  useProposalStore
    .getState()
    .proposals.filter((p) => p.kind === "correct")
    .sort(byFrame);

/**
 * Open Compare Models' Review disagreements window on Claude's first
 * correction still to decide (or the first one). False (with a hint) when
 * Claude hasn't corrected any prediction.
 */
export function openClaudeSuggestions(): boolean {
  const app = useAppStore.getState();
  const list = corrections();
  if (!app.labels || list.length === 0) {
    toast.info("Claude hasn't suggested any corrections yet.");
    return false;
  }
  const first = list.find((p) => canAccept(p)) ?? list[0];
  const video = app.labels.videos[first.videoIdx];
  if (video && app.video !== video) app.setVideo(video);
  const review = useCompareReviewStore.getState();
  review.setFocusProposal(first.id);
  review.setOpen(true);
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
  const n = undecidedCount(corrections());
  if (n === 0) return;
  toast.info(`Claude suggested ${n} correction${n === 1 ? "" : "s"}`, {
    id: TOAST_ID,
    description: "Nothing changes until you accept them.",
    duration: 15_000,
    action: { label: "Review", onClick: () => void openClaudeSuggestions() },
  });
}

// Only corrections: QC fixes show in Label QC Review, as in phase 1.
useProposalStore.subscribe((s, prev) => {
  if (typeof window === "undefined") return;
  const seen = new Set(prev.proposals.map((p) => p.id));
  if (!s.proposals.some((p) => p.kind === "correct" && !seen.has(p.id))) return;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(showSuggestionsToast, TOAST_DELAY_MS);
});

/**
 * What Claude's proposal changes, naming the nodes, for the review windows:
 * "Moves head, torso · hides tail_base". "Ignore this flag" for an ignore,
 * "Accepts the prediction as is" for a correction with no changes. Names come
 * from the instance's own skeleton (else `fallbackNames`, else "node k").
 */
export function proposalChangeText(p: Proposal, fallbackNames: readonly string[] = []): string {
  if (p.kind === "ignore") return "Ignore this flag";
  const names = (proposalInstance(p) ?? correctionResult(p))?.skeleton.nodeNames ?? fallbackNames;
  const moved: string[] = [];
  const hidden: string[] = [];
  for (const [k, v] of Object.entries(p.after)) (v === null ? hidden : moved).push(names[Number(k)] ?? `node ${k}`);
  const parts: string[] = [];
  if (moved.length) parts.push(`moves ${moved.join(", ")}`);
  if (hidden.length) parts.push(`hides ${hidden.join(", ")}`);
  if (parts.length === 0) return p.kind === "correct" ? "Accepts the prediction as is" : "No changes";
  const text = parts.join(" · ");
  return text[0].toUpperCase() + text.slice(1);
}
