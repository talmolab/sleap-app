/**
 * The QC Review window's "Claude suggests" row: what Claude's proposal on the
 * instance on screen changes (naming the nodes) with Accept / Reject on the
 * first line, and its reason in full below, wrapped over as many lines as it
 * needs (never cut off). The proposed pose
 * itself is drawn on the canvas as a dashed ghost (useProposalGhosts).
 */
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { proposalState, useProposalStore } from "@/stores/proposalStore";
import { acceptProposal, currentProposal, proposalChangeText, rejectProposal } from "@/lib/proposalReview";
import { formatShortcut } from "@/lib/formatShortcut";

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
        : `Accepted (${formatShortcut("$mod+KeyZ")} to undo)`
      : st === "rejected"
        ? "Rejected"
        : st === "outdated"
          ? "Outdated: the instance changed since Claude looked"
          : st === "undone"
            ? "Undone"
            : null;

  return (
    <div className="border-t border-border/60 bg-orange-500/5 px-3 py-1.5" data-testid="claude-suggestion">
      <div className="flex min-h-6 items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-orange-400" aria-hidden />
        <span className="shrink-0 whitespace-nowrap font-medium text-orange-400">Claude suggests</span>
        <span className="min-w-0 truncate text-muted-foreground" data-testid="claude-suggestion-summary">
          {proposalChangeText(p)}
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
      {p.reason && (
        <p className="whitespace-pre-wrap break-words pl-5.5 pt-0.5 text-[12px] leading-snug" data-testid="claude-suggestion-reason">
          {p.reason}
        </p>
      )}
    </div>
  );
}
