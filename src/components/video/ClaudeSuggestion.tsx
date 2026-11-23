/**
 * The Review window's "Claude suggests" row: the reason for Claude's proposal
 * on the instance on screen, and Accept / Reject. The proposed pose itself is
 * drawn on the canvas as a dashed ghost (useProposalGhosts).
 *
 * Also the window's header and footer in "Claude's suggestions" mode
 * (lib/proposalReview.ts), which steps through Claude's proposals instead of
 * Label QC flags.
 */
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { proposalState, useProposalStore, type Proposal } from "@/stores/proposalStore";
import {
  acceptProposal,
  claudeQueue,
  currentProposal,
  goToProposal,
  rejectProposal,
  stepClaudeReview,
  undecidedCount,
} from "@/lib/proposalReview";
import { formatShortcut } from "@/lib/formatShortcut";
import { useQcStore } from "@/stores/qcStore";
import { videoBasename } from "@/lib/videoFilter";

/** What the proposal would do, in a few words. */
function summary(p: Proposal): string {
  if (p.kind === "ignore") return "ignore this flag";
  const vals = Object.values(p.after);
  const moved = vals.filter((v) => v !== null).length;
  const hidden = vals.length - moved;
  const parts = [];
  if (moved) parts.push(`move ${moved} node${moved === 1 ? "" : "s"}`);
  if (hidden) parts.push(`hide ${hidden} node${hidden === 1 ? "" : "s"}`);
  if (p.kind === "correct") {
    return parts.length === 0 ? "accept this prediction as is" : `correct this prediction (${parts.join(", ")})`;
  }
  return parts.join(", ");
}

/** The status line for a decided (or stale) proposal; null while pending. */
function statusText(p: Proposal, st: ReturnType<typeof proposalState>): string | null {
  const undo = formatShortcut("$mod+KeyZ");
  if (st === "accepted") {
    if (p.kind === "ignore") return "Ignored";
    return p.kind === "correct" ? `Accepted as a label (${undo} to undo)` : `Accepted (${undo} to undo)`;
  }
  if (st === "rejected") return "Rejected";
  if (st === "outdated") {
    return p.kind === "correct"
      ? "Outdated: the prediction changed, or that animal was labeled, since Claude looked"
      : "Outdated: the instance changed since Claude looked";
  }
  if (st === "undone") return "Undone";
  return null;
}

function acceptTitle(p: Proposal, outdated: boolean): string {
  if (outdated) {
    return p.kind === "correct"
      ? "The prediction changed, or that animal was labeled, after Claude's suggestion; ask Claude to look again"
      : "The instance changed after Claude's suggestion; ask Claude to look again";
  }
  if (p.kind === "ignore") return "Mark this instance OK, as 3 does (A)";
  if (p.kind === "correct") return "Make this prediction a user instance with Claude's changes; one undo step (A)";
  return "Apply Claude's fix; one undo step (A)";
}

export function ClaudeSuggestionRow() {
  // Re-pick on selection, frame, proposal or edit changes.
  useAppStore((s) => s.instance);
  useAppStore((s) => s.frameIdx);
  useAppStore((s) => s.labeledFrame);
  useAppStore((s) => s.editSeq);
  useProposalStore((s) => s.proposals);
  useProposalStore((s) => s.claudeShown);
  const p = currentProposal();
  if (!p) return null;
  const st = proposalState(p);
  const outdated = st === "outdated";
  const actionable = st === "pending" || st === "outdated" || st === "undone";

  const status = statusText(p, st);

  return (
    <div
      className="flex min-h-8 items-center gap-2 border-t border-border/60 bg-orange-500/5 px-3 py-1.5"
      data-testid="claude-suggestion"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-orange-400" aria-hidden />
      <span className="shrink-0 font-medium text-orange-400">Claude suggests</span>
      <span className="shrink-0 text-muted-foreground">{summary(p)}:</span>
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
        {actionable && (
          <>
            <Button
              size="sm"
              className="h-6 bg-orange-500/90 px-2 text-[11px] text-white hover:bg-orange-500"
              disabled={outdated}
              onClick={() => void acceptProposal(p.id)}
              title={acceptTitle(p, outdated)}
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

/** The Review window's header in Claude's-suggestions mode. */
export function ClaudeReviewHeader() {
  const proposals = useProposalStore((s) => s.proposals);
  useProposalStore((s) => s.claudeShown);
  useAppStore((s) => s.instance);
  useAppStore((s) => s.editSeq);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const video = useAppStore((s) => s.video);
  const multiVideo = useAppStore((s) => (s.labels?.videos.length ?? 0) > 1);
  const qcRun = useQcStore((s) => s.state === "done" && s.labels !== null && s.labels === useAppStore.getState().labels);
  const queue = claudeQueue(proposals);
  const cur = currentProposal();
  const pos = cur ? queue.indexOf(cur) : -1;
  const left = undecidedCount(proposals);
  const videoName = video ? videoBasename(video.filename) : null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs" data-testid="claude-review-header">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-orange-400" aria-hidden />
      <span className="font-semibold">Claude&apos;s suggestions</span>
      <span className="font-mono tabular-nums text-muted-foreground">
        {pos >= 0 ? pos + 1 : "–"} / {queue.length}
      </span>
      <span className="rounded bg-orange-500/10 px-1.5 text-[11px] text-orange-400" title="Pending or undone suggestions">
        {left} to decide
      </span>
      <span className="font-mono tabular-nums text-muted-foreground">
        {multiVideo && videoName && <span title={videoName}>{videoName} · </span>}frame {frameIdx}
      </span>
      <span className="ml-auto flex items-center gap-1">
        {qcRun && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => useProposalStore.getState().setClaudeReview(false)}
            title="Step through Label QC flags instead"
          >
            Label QC flags
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => useQcStore.getState().setReviewOpen(false)}
          title="Close (Esc)"
          aria-label="Close Review"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </span>
    </div>
  );
}

/** The Review window's footer in Claude's-suggestions mode. */
export function ClaudeReviewFooter() {
  const proposals = useProposalStore((s) => s.proposals);
  useProposalStore((s) => s.claudeShown);
  useAppStore((s) => s.instance);
  useAppStore((s) => s.frameIdx);
  useAppStore((s) => s.labeledFrame);
  const none = proposals.length > 0 && currentProposal() === null;
  return (
    <div className="shrink-0 border-t border-border text-xs" data-testid="claude-review-footer">
      {none && (
        <div className="flex min-h-8 items-center px-3 py-1.5 text-muted-foreground">
          No suggestion from Claude for this instance. Select another one, or step to the next suggestion.
        </div>
      )}
      <ClaudeSuggestionRow />
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
        <Button size="sm" variant="outline" className="h-7" onClick={() => stepClaudeReview(-1)} title="Previous suggestion (←)">
          ‹ Prev
        </Button>
        <span className="flex-1 text-center text-[10px] text-muted-foreground">
          A accept · X reject · drag a point to adjust it after accepting · {formatShortcut("$mod+KeyZ")} undo · Esc close
        </span>
        <Button size="sm" className="h-7" onClick={() => stepClaudeReview(1)} title="Next suggestion (→)">
          Next ›
        </Button>
      </div>
    </div>
  );
}

/** In the Label QC Review, a way into Claude's-suggestions mode while Claude has any. */
export function ClaudeSuggestionsLink() {
  const n = useProposalStore((s) => s.proposals.length);
  if (n === 0) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px] text-orange-400 hover:text-orange-300"
      onClick={() => {
        useProposalStore.getState().setClaudeReview(true);
        const p = currentProposal() ?? claudeQueue()[0];
        if (p && currentProposal() !== p) goToProposal(p);
      }}
      title="Step through all of Claude's suggestions, including corrected predictions"
    >
      Claude&apos;s suggestions
    </Button>
  );
}

