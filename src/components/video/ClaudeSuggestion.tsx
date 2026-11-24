/**
 * The QC Review window's "Claude suggests" row: the reason for Claude's
 * proposal on the instance on screen, and Accept / Reject (then Revert /
 * Undo reject). The proposed pose itself is drawn on the canvas as a dashed
 * ghost (useProposalGhosts). Claude's corrections of predictions are reviewed
 * in Compare Models' Review disagreements window instead; the header link
 * (ClaudeSuggestionsLink) opens it.
 */
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { canRevert, proposalState, useProposalStore, type Proposal } from "@/stores/proposalStore";
import {
  acceptProposal,
  currentProposal,
  openClaudeSuggestions,
  rejectProposal,
  revertProposal,
  unrejectProposal,
} from "@/lib/proposalReview";

/** What the proposal would do, in a few words. */
export function proposalSummary(p: Proposal): string {
  if (p.kind === "ignore") return "ignore this flag";
  const vals = Object.values(p.after);
  const moved = vals.filter((v) => v !== null).length;
  const hidden = vals.length - moved;
  const parts = [];
  if (moved) parts.push(`move ${moved} node${moved === 1 ? "" : "s"}`);
  if (hidden) parts.push(`hide ${hidden} node${hidden === 1 ? "" : "s"}`);
  if (p.kind === "correct" && parts.length === 0) return "accept the prediction as is";
  return parts.join(", ");
}

/** Revert / Undo reject for a decided proposal (both new edits or plain state, never ⌘Z). */
export function DecidedActions({ p, className }: { p: Proposal; className?: string }) {
  const st = proposalState(p);
  if (st === "accepted" && p.kind !== "ignore") {
    const ok = canRevert(p);
    return (
      <Button
        size="sm"
        variant="outline"
        className={cn("h-6 px-2 text-[11px]", className)}
        disabled={!ok}
        onClick={() => void revertProposal(p.id)}
        title={
          ok
            ? "Put it back as it was before you accepted (a new edit you can undo)"
            : "You changed this instance after accepting, so Revert would lose your edits"
        }
        data-testid="claude-revert"
      >
        Revert
      </Button>
    );
  }
  if (st === "rejected") {
    return (
      <Button
        size="sm"
        variant="outline"
        className={cn("h-6 px-2 text-[11px]", className)}
        onClick={() => unrejectProposal(p.id)}
        title="Take the reject back: the suggestion is pending again"
        data-testid="claude-unreject"
      >
        Undo reject
      </Button>
    );
  }
  return null;
}

export function ClaudeSuggestionRow() {
  // Re-pick on selection, frame, proposal or edit changes.
  useAppStore((s) => s.instance);
  useAppStore((s) => s.frameIdx);
  useAppStore((s) => s.labeledFrame);
  useAppStore((s) => s.editSeq);
  useProposalStore((s) => s.proposals);
  const p = currentProposal();
  if (!p) return null;
  const st = proposalState(p);
  const outdated = st === "outdated";
  const actionable = st === "pending" || st === "outdated" || st === "undone";

  const status =
    st === "accepted"
      ? p.kind === "ignore"
        ? "Ignored"
        : "Accepted"
      : st === "rejected"
        ? "Rejected"
        : st === "outdated"
          ? "Outdated: the instance changed since Claude looked"
          : st === "undone"
            ? "Undone"
            : null;

  return (
    <div
      className="flex min-h-8 items-center gap-2 border-t border-border/60 bg-orange-500/5 px-3 py-1.5"
      data-testid="claude-suggestion"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-orange-400" aria-hidden />
      <span className="shrink-0 font-medium text-orange-400">Claude suggests</span>
      <span className="shrink-0 text-muted-foreground">{proposalSummary(p)}:</span>
      <span className="min-w-0 truncate" title={p.reason}>
        {p.reason}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {status && (
          <span
            className={cn(
              "text-[11px]",
              st === "accepted" ? "text-green-500" : outdated ? "text-amber-500" : "text-muted-foreground",
            )}
          >
            {status}
          </span>
        )}
        <DecidedActions p={p} />
        {actionable && (
          <>
            <Button
              size="sm"
              className="h-6 bg-orange-500/90 px-2 text-[11px] text-white hover:bg-orange-500"
              disabled={outdated}
              onClick={() => void acceptProposal(p.id)}
              title={
                outdated
                  ? "The instance changed after Claude's suggestion; ask Claude to look again"
                  : p.kind === "ignore"
                    ? "Mark this instance OK, as 3 does (A)"
                    : "Apply Claude's fix; one undo step (A)"
              }
            >
              {p.kind === "ignore" ? "Ignore flag" : "Accept"}
            </Button>
            {p.status === "pending" && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => rejectProposal(p.id)}
                title="Dismiss Claude's suggestion; nothing changes (X)"
              >
                Reject
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/**
 * In the QC Review header, while Claude has corrected predictions: opens
 * Compare Models' Review disagreements window, where they are reviewed.
 */
export function ClaudeSuggestionsLink() {
  const n = useProposalStore((s) => s.proposals.filter((p) => p.kind === "correct").length);
  if (n === 0) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px] text-orange-400 hover:text-orange-300"
      onClick={() => openClaudeSuggestions()}
      title="Claude's corrections of predictions are reviewed in Compare Models' Review disagreements window"
      data-testid="claude-suggestions-link"
    >
      Claude&apos;s corrections ({n})
    </Button>
  );
}
