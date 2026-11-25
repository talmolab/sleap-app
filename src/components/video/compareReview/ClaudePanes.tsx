/**
 * Review disagreements window — Claude's panes.
 *
 * "Claude's suggestion": Claude's corrected pose for the animal, drawn in its
 * own pane whatever the Show project instances (H) / model toggles say, with
 * the reason, "Use this one" (accept: the prediction becomes a user instance
 * with Claude's changes, one undo step) and the suggestion's state:
 * accepted (Revert), undone, outdated (can't be used), rejected (Undo reject).
 *
 * "Project prediction": for an item that is Claude's alone (no models
 * disagree on it), the project's own prediction stands in as the one model:
 * "Use this one" turns it into a user instance as is.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, PenLine, SkipForward, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RGB } from "@/lib/colorPalettes";
import { rgbToCSS } from "@/lib/colorPalettes";
import { useAppStore } from "@/stores/appStore";
import { canAccept, canRevert, proposalInstance, proposalState, useProposalStore, type Proposal } from "@/stores/proposalStore";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { acceptProposal, proposalChangeText, rejectProposal, revertProposal, unrejectProposal } from "@/lib/proposalReview";
import { commandContext, ConvertPredictionToInstance } from "@/commands";
import type { NodeMark, ProjectPose, Rect } from "@/lib/modelOverlay/review";
import type { Video } from "@/types";
import { ModelCropCanvas } from "./ModelCropCanvas";
import { changedNodes, correctedPoseXy, proposalPoseXy } from "./claudeEntries";

/** Claude's colour (the ghost pose's warm orange). */
export const CLAUDE_COLOR: RGB = [232, 116, 59];
/** The project's prediction when it stands in as the one model. */
export const PREDICTION_COLOR: RGB = [56, 189, 248];

interface PaneProps {
  proposal: Proposal;
  video: Video;
  frame: number;
  crop: Rect | null;
  nodeNames: readonly string[];
  edges: readonly (readonly [number, number])[];
  width: number;
  height: number;
}

/** Name tags on the nodes Claude changes, at `xy` (a hidden node at the prediction's spot, "(hidden)"). */
function changedMarks(p: Proposal, nodeNames: readonly string[], xy: Float64Array, fallback: Float64Array): NodeMark[] {
  return changedNodes(p, nodeNames)
    .map((k) => {
      const hidden = !Number.isFinite(xy[2 * k]);
      const at = hidden ? fallback : xy;
      return { x: at[2 * k], y: at[2 * k + 1], label: `${nodeNames[k] ?? k}${hidden ? " (hidden)" : ""}` };
    })
    .filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y));
}

/**
 * Claude's reason: two lines, so the card keeps its size and its buttons stay
 * in view; click it to read it all in place (click again to fold it). A
 * "more" / "less" cue shows when there is more to read.
 */
export function ClaudeReason({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [reason, open]);
  const canToggle = overflows || open;
  return (
    <div className="px-1">
      <div
        ref={ref}
        className={cn("whitespace-pre-wrap break-words text-[11px] leading-snug", !open && "line-clamp-2", canToggle && "cursor-pointer")}
        onClick={() => canToggle && setOpen(!open)}
        title={canToggle ? (open ? "Click to show less" : "Click to read it all") : undefined}
        data-testid="review-claude-reason"
        data-expanded={open || undefined}
      >
        {reason}
      </div>
      {canToggle && (
        <button
          type="button"
          className="text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          onClick={() => setOpen(!open)}
          data-testid="review-claude-reason-toggle"
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

/** Revert (accepted) / Undo reject (rejected): neither is something ⌘Z can reach. */
function DecidedActions({ p, className }: { p: Proposal; className?: string }) {
  const st = proposalState(p);
  if (st === "accepted") {
    const ok = canRevert(p);
    return (
      <Button
        size="sm"
        variant="outline"
        className={cn("px-2 text-[11px]", className)}
        disabled={!ok}
        onClick={() => void revertProposal(p.id)}
        title={
          ok
            ? "Turn it back into the prediction, as it was before you accepted (a new edit you can undo)"
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
        className={cn("px-2 text-[11px]", className)}
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

const OUTDATED_TEXT = "Outdated: the prediction changed, or that animal was labeled, since Claude looked";

/** Go to the frame in the main view (the window's crops follow the item, the main view follows this). */
function goToFrame(frame: number) {
  const app = useAppStore.getState();
  if (app.frameIdx !== frame) app.setFrameIdx(frame);
}

export function ClaudePane({
  proposal,
  video,
  frame,
  crop,
  nodeNames,
  edges,
  width,
  height,
  onDecided,
}: PaneProps & { onDecided: () => void }) {
  // Re-render on any proposal change and any edit (outdated / Revert depend on the labels).
  const p = useProposalStore((s) => s.proposals.find((x) => x.id === proposal.id)) ?? proposal;
  useAppStore((s) => s.editSeq);
  const st = proposalState(p);
  const before = useMemo(() => proposalPoseXy(p, nodeNames), [p, nodeNames]);
  const xy = useMemo(() => correctedPoseXy(p, nodeNames), [p, nodeNames]);
  const poses = useMemo(() => [{ modelId: "claude", color: CLAUDE_COLOR, xy }], [xy]);
  const marks = useMemo(() => changedMarks(p, nodeNames, xy, before), [p, nodeNames, xy, before]);
  const status =
    st === "accepted" ? "Accepted" : st === "rejected" ? "Rejected" : st === "undone" ? "Undone" : st === "outdated" ? OUTDATED_TEXT : null;
  return (
    <div
      className={cn("flex flex-col rounded border p-1", st === "accepted" ? "border-green-500 bg-green-500/10" : "border-orange-500/60")}
      data-testid="review-claude-pane"
    >
      {/* No projectPoses: Claude's pose shows whatever H says. */}
      <ModelCropCanvas
        video={video}
        frame={frame}
        crop={crop}
        poses={poses}
        consensus={null}
        marks={marks}
        edges={edges}
        width={width}
        height={height}
      />
      <div className="flex items-center gap-1 px-1 pt-1">
        <Sparkles className="h-3 w-3 shrink-0" style={{ color: rgbToCSS(CLAUDE_COLOR) }} aria-hidden />
        <span className="whitespace-nowrap font-medium">Claude&apos;s suggestion</span>
      </div>
      {/* What it changes, naming the nodes, then the reason in full (wrapped, never cut off). */}
      <div className="px-1 text-[11px] text-muted-foreground" data-testid="review-claude-summary">
        {proposalChangeText(p, nodeNames)}
      </div>
      <ClaudeReason reason={p.reason} />
      {status && (
        <div
          className={cn("px-1 text-[11px]", st === "accepted" ? "text-green-500" : st === "outdated" ? "text-amber-500" : "text-muted-foreground")}
          data-testid="review-claude-status"
        >
          {status}
        </div>
      )}
      <div className="flex items-center gap-1 px-1 pt-1">
        {(canAccept(p) || st === "outdated") && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11px]"
            disabled={st === "outdated"}
            onClick={() => void acceptProposal(p.id).then((ok) => ok && onDecided())}
            title={
              st === "outdated"
                ? OUTDATED_TEXT
                : "Make the prediction a user instance with Claude's changes (one edit; Revert or ⌘Z takes it back), then the next one"
            }
            data-testid="review-claude-use"
          >
            <Check className="mr-1 h-3 w-3" /> Use this one
          </Button>
        )}
        {p.status === "pending" && st !== "outdated" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => rejectProposal(p.id)}
            title="Claude's suggestion is wrong; nothing changes (Undo reject takes it back)"
            data-testid="review-claude-reject"
          >
            <X className="mr-1 h-3 w-3" /> Reject
          </Button>
        )}
        <DecidedActions p={p} className="h-7 flex-1" />
      </div>
    </div>
  );
}

/** For a Claude-only item: the project's own prediction, as the one "model". */
export function PredictionPane({
  proposal,
  entryKey,
  video,
  frame,
  crop,
  nodeNames,
  edges,
  width,
  height,
  projectPoses,
  onDecided,
}: PaneProps & { entryKey: string; projectPoses?: readonly ProjectPose[]; onDecided: () => void }) {
  useProposalStore((s) => s.proposals);
  useAppStore((s) => s.editSeq);
  const decision = useCompareReviewStore((s) => s.decisions[entryKey]);
  const xy = useMemo(() => proposalPoseXy(proposal, nodeNames), [proposal, nodeNames]);
  const poses = useMemo(() => [{ modelId: "prediction", color: PREDICTION_COLOR, xy }], [xy]);
  const marks = useMemo(() => changedMarks(proposal, nodeNames, xy, xy), [proposal, nodeNames, xy]);
  // Still there and not labeled yet (the same check that makes Claude's suggestion outdated).
  const pred = proposalInstance(proposal);
  const score = pred && "score" in pred && Number.isFinite(pred.score) ? (pred.score as number) : null;
  const accepted = decision?.accepted === "prediction";
  const usePrediction = () => {
    const target = proposalInstance(proposal);
    const lf = useAppStore.getState().labels?.find({ video, frameIdx: frame })[0];
    if (!target || !lf) return;
    goToFrame(frame);
    void commandContext.execute(ConvertPredictionToInstance, { instanceIdx: lf.instances.indexOf(target) });
    useCompareReviewStore.getState().accept(entryKey, "prediction");
    onDecided();
  };
  const store = useCompareReviewStore.getState();
  return (
    <div
      className={cn("flex flex-col rounded border p-1", accepted ? "border-green-500 bg-green-500/10" : "border-border")}
      data-testid="review-prediction-pane"
    >
      <ModelCropCanvas
        video={video}
        frame={frame}
        crop={crop}
        poses={poses}
        consensus={null}
        marks={marks}
        projectPoses={projectPoses}
        edges={edges}
        width={width}
        height={height}
      />
      <div className="flex items-center gap-1 px-1 pt-1">
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: rgbToCSS(PREDICTION_COLOR) }} />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap">Project prediction</span>
        {score !== null && (
          <span className="tabular-nums text-muted-foreground" title="The model's instance score">
            {score.toFixed(2)}
          </span>
        )}
      </div>
      <div className="px-1 pt-1">
        <Button
          size="sm"
          variant={accepted ? "default" : "outline"}
          className="h-7 w-full text-[11px]"
          disabled={!pred}
          onClick={usePrediction}
          title={pred ? "Make the prediction a user instance as it is (⌘Z undoes), then the next one" : "This prediction was already labeled or is gone"}
          data-testid="review-prediction-use"
        >
          <Check className="mr-1 h-3 w-3" /> Use this one
        </Button>
      </div>
      <div className="flex items-center gap-1 px-1 pt-1">
        <Button
          size="sm"
          variant={decision?.byHand ? "default" : "outline"}
          className="h-7 flex-1 text-[11px]"
          onClick={() => {
            goToFrame(frame);
            store.markByHand(entryKey);
            store.setOpen(false);
          }}
          title="Neither is right: go to this frame in the main view (this window closes) to label it by hand"
          data-testid="review-claude-none-right"
        >
          <PenLine className="mr-1 h-3 w-3" /> None are right
        </Button>
        <Button
          size="sm"
          variant={decision?.skipped ? "default" : "outline"}
          className="h-7 flex-1 text-[11px]"
          onClick={() => {
            store.skip(entryKey);
            onDecided();
          }}
          title="Leave it as it is and go to the next one"
          data-testid="review-claude-skip"
        >
          <SkipForward className="mr-1 h-3 w-3" /> Skip
        </Button>
      </div>
    </div>
  );
}

/** Whether an item is decided: a decision in the window, or Claude's suggestion accepted. */
export function entryDone(decisionReviewed: ReturnType<typeof isReviewed>, claude: Proposal | null): boolean {
  return decisionReviewed || (!!claude && proposalState(claude) === "accepted");
}
