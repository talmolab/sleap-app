/**
 * Which of Claude's proposals the Review window shows, its A / X keys, and
 * stepping through Claude's suggestions.
 *
 * The proposal shown is the latest one for the selected instance on this
 * frame (for a correction: the prediction, or the user instance accepting it
 * made); with none for it (or nothing selected), the first pending one on the
 * frame. In Claude's-suggestions mode, the one stepped to, while it is on
 * screen and about the selection. With an instance selected, A / X only act
 * on its own proposal, so they never change an animal the user isn't looking at.
 *
 * "Claude's suggestions" mode (proposalStore.claudeReview): the same Review
 * window, but ← / → and Prev / Next step through Claude's proposals — every
 * kind, in video and frame order — instead of Label QC flags, so predictions
 * Claude corrected can be reviewed without a QC run. Opened from the toast
 * that appears when Claude proposes something, or from the Claude section of
 * the Environment panel.
 */
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import {
  canAccept,
  correctionResult,
  proposalInstance,
  proposalState,
  useProposalStore,
  type Proposal,
} from "@/stores/proposalStore";
import { AutomationError } from "@/automation/errors";
import { toast } from "@/lib/notify";
import { setReviewKeyOverride } from "@/lib/reviewKeyOverride";
import type { Instance } from "@/types";

/** Whether `p` is about `inst` (the instance it would change, or — accepted — did). */
export function proposalIsAbout(p: Proposal, inst: Instance | null): boolean {
  if (!inst) return false;
  if (p.kind === "correct") return proposalInstance(p) === inst || correctionResult(p) === inst;
  return proposalInstance(p) === inst;
}

export function currentProposal(): Proposal | null {
  const app = useAppStore.getState();
  const labels = app.labels;
  const proposals = useProposalStore.getState().proposals;
  if (!labels || !app.video || proposals.length === 0) return null;
  const videoIdx = labels.videos.indexOf(app.video);
  const here = proposals.filter((p) => p.videoIdx === videoIdx && p.frameIdx === app.frameIdx);
  if (here.length === 0) return null;
  const { claudeReview, claudeShown } = useProposalStore.getState();
  if (claudeReview && claudeShown) {
    const shown = here.find((p) => p.id === claudeShown);
    if (shown && (!app.instance || proposalIsAbout(shown, app.instance))) return shown;
  }
  const mine = here.filter((p) => proposalIsAbout(p, app.instance));
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

// ---------------------------------------------------------------------------
// Claude's suggestions mode

/** Every proposal, in video, frame, then proposal order (what ← / → step through). */
export function claudeQueue(proposals: readonly Proposal[] = useProposalStore.getState().proposals): Proposal[] {
  return [...proposals].sort(
    (a, b) => a.videoIdx - b.videoIdx || a.frameIdx - b.frameIdx || Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
}

/** Proposals the user can still decide on (pending, or undone). */
export const undecidedCount = (proposals: readonly Proposal[]) =>
  proposals.filter((p) => {
    const st = proposalState(p);
    return st === "pending" || st === "undone";
  }).length;

/** Show a proposal: go to its frame, select what it is about, zoom to it. */
export function goToProposal(p: Proposal): void {
  const app = useAppStore.getState();
  const video = app.labels?.videos[p.videoIdx];
  if (!video) return;
  useProposalStore.getState().setClaudeShown(p.id);
  if (app.video !== video) app.setVideo(video);
  // setFrameIdx clears the selection, so select after it.
  useAppStore.getState().setFrameIdx(p.frameIdx);
  const inst = proposalInstance(p) ?? correctionResult(p);
  useAppStore.getState().setInstance(inst);
  if (inst) useAppStore.getState().set("fitSelection", true);
}

/**
 * The next (dir 1) or previous (-1) of Claude's proposals. From a frame with
 * none, the first (or last) one.
 */
export function stepClaudeReview(dir: 1 | -1): void {
  const queue = claudeQueue();
  if (queue.length === 0) {
    toast.info("Claude hasn't suggested anything yet.");
    return;
  }
  const cur = currentProposal();
  const pos = cur ? queue.indexOf(cur) : -1;
  const i = pos < 0 ? (dir === 1 ? 0 : queue.length - 1) : (pos + dir + queue.length) % queue.length;
  goToProposal(queue[i]);
}

/**
 * Open the Review window on Claude's suggestions: at the one on screen if
 * there is one to decide, else the first undecided one. False (with a hint)
 * when Claude hasn't proposed anything.
 */
export function openClaudeReview(): boolean {
  const queue = claudeQueue();
  if (!useAppStore.getState().labels || queue.length === 0) {
    toast.info("Claude hasn't suggested anything yet.");
    return false;
  }
  useQcStore.getState().setReviewOpen(true);
  useProposalStore.getState().setClaudeReview(true);
  const cur = currentProposal();
  const target = cur && canAccept(cur) ? cur : (queue.find((p) => canAccept(p)) ?? queue[0]);
  goToProposal(target);
  return true;
}

// ← / → / 0 in the Review window, while it shows Claude's suggestions.
setReviewKeyOverride((key) => {
  if (!useProposalStore.getState().claudeReview) return false;
  if (key === "refit") {
    const p = currentProposal();
    if (p) goToProposal(p);
  } else {
    stepClaudeReview(key === "frame next" ? 1 : -1);
  }
  return true;
});

// ---------------------------------------------------------------------------
// "Claude suggested N changes" toast

const TOAST_ID = "claude-suggestions";
/** Wait for Claude to finish a batch before telling the user. */
const TOAST_DELAY_MS = 1500;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showSuggestionsToast(): void {
  toastTimer = null;
  const s = useProposalStore.getState();
  // Already looking at them.
  if (useQcStore.getState().reviewOpen && s.claudeReview) return;
  const n = undecidedCount(s.proposals);
  if (n === 0) return;
  toast.info(`Claude suggested ${n} change${n === 1 ? "" : "s"}`, {
    id: TOAST_ID,
    description: "Nothing changes until you accept them in the Review window.",
    duration: 15_000,
    action: { label: "Review", onClick: () => void openClaudeReview() },
  });
}

useProposalStore.subscribe((s, prev) => {
  if (typeof window === "undefined") return;
  const seen = new Set(prev.proposals.map((p) => p.id));
  if (!s.proposals.some((p) => !seen.has(p.id))) return;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(showSuggestionsToast, TOAST_DELAY_MS);
});
