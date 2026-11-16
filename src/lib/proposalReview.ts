/**
 * Which of Claude's proposals the QC Review window shows, and its A / X keys.
 *
 * The proposal shown is the latest one for the selected instance on this
 * frame; with none for it (or nothing selected), the first pending one on the
 * frame.
 */
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { canAccept, useProposalStore, type Proposal } from "@/stores/proposalStore";
import { AutomationError } from "@/automation/errors";
import { toast } from "@/lib/notify";

export function currentProposal(): Proposal | null {
  const app = useAppStore.getState();
  const labels = app.labels;
  const proposals = useProposalStore.getState().proposals;
  if (!labels || !app.video || proposals.length === 0) return null;
  const videoIdx = labels.videos.indexOf(app.video);
  const here = proposals.filter((p) => p.videoIdx === videoIdx && p.frameIdx === app.frameIdx);
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
