/**
 * Label QC Review window: the main canvas, framed as a window over the dimmed
 * app, for stepping through QC flags one at a time.
 *
 * Not a second canvas: VideoPlayer always renders its canvas inside this
 * frame, which only adds a header (position, score, ordering tabs) and a
 * footer (issue, Prev / Delete instance / Ignore / Next) while
 * `qcStore.reviewOpen`. So dragging nodes, V, ⌘Z and zoom all work as usual.
 * Scores shown are live: an instance edited here shows its re-score
 * (`qcStore.rescored`) in place of the run's, marked "re-scored".
 * The element tree stays the same open or closed, so the canvas never remounts.
 */
import { useMemo, type ReactNode } from "react";
import { Flag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import {
  buildQcQueue,
  hideOkFlags,
  liveQcEntry,
  qcFrameKey,
  qcIsOk,
  qcUnplacedProblemNode,
  refocusQcReview,
  sortQcQueue,
  stepQcQueue,
  useQcStore,
  type QcReviewOrder,
} from "@/stores/qcStore";
import { commandContext, DeleteSelectedInstance, MarkQcFlagOk } from "@/commands";
import { QC_KIND_LABEL, SOFT_QC_KINDS } from "@/lib/analyze/labelQc";
import { qcIssueText } from "@/lib/qcReview";
import { formatShortcut } from "@/lib/formatShortcut";

const RESCORED_TITLE = "Scored against the last run; Rerun to re-check against all labels.";

/** Marks scores re-computed after an edit, against the last run. */
const RescoredTag = () => (
  <span className="rounded bg-sky-500/15 px-1 text-[10px] text-sky-400" title={RESCORED_TITLE}>
    re-scored
  </span>
);

const ORDERS: { order: QcReviewOrder; label: string; title: string }[] = [
  { order: "severity", label: "Severity", title: "Definite errors first, then the worst score" },
  {
    order: "detectors",
    label: "Detectors",
    title: "Frames where the most checks agree first (anomaly, GMM, rule checks)",
  },
  { order: "frame", label: "Frame", title: "In frame order" },
];

export function QcReviewFrame({ children }: { children: ReactNode }) {
  const open = useQcStore((s) => s.reviewOpen);
  return (
    <>
      {open && (
        // The scrim dims the rest of the app; clicking it closes Review.
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
          onPointerDown={() => useQcStore.getState().setReviewOpen(false)}
          data-testid="qc-review-scrim"
        />
      )}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // Centered on the screen, not the video area: the canvas moves with the
          // frame (VideoPlayer re-measures on resize) and its old slot sits under the scrim.
          open &&
            "fixed inset-6 z-50 m-auto max-h-[920px] max-w-[1280px] overflow-hidden rounded-lg border border-border bg-background shadow-2xl",
        )}
        role={open ? "dialog" : undefined}
        aria-label={open ? "Label QC Review" : undefined}
      >
        {open && <ReviewHeader />}
        {/* Always rendered, so the canvas's parent never changes. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {children}
          {open && <UnplacedHint />}
        </div>
        {open && <ReviewFooter />}
      </div>
    </>
  );
}

/** The review queue as the panel shows it, in the review order. */
function useReviewQueue() {
  const labels = useAppStore((s) => s.labels);
  // Edits change pose fingerprints, so OK marks are re-matched after each.
  const editSeq = useAppStore((s) => s.editSeq);
  const findings = useQcStore((s) => s.findings);
  const anomaly = useQcStore((s) => s.anomaly);
  const threshold = useQcStore((s) => s.threshold);
  const dismissed = useQcStore((s) => s.dismissed);
  const showDismissed = useQcStore((s) => s.showDismissed);
  const order = useQcStore((s) => s.reviewOrder);
  return useMemo(() => {
    const full = buildQcQueue(findings, anomaly, threshold, qcIsOk(labels, dismissed));
    return sortQcQueue(showDismissed ? full : hideOkFlags(full), order);
    // editSeq isn't read, but each edit can change a fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findings, anomaly, threshold, labels, dismissed, showDismissed, order, editSeq]);
}

/**
 * The flagged frame on screen and its position in the queue (-1 when not
 * flagged), with re-scored instances' current scores swapped in.
 */
function useCurrentEntry() {
  const queue = useReviewQueue();
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const rescored = useQcStore((s) => s.rescored);
  const threshold = useQcStore((s) => s.threshold);
  const gmmThreshold = useQcStore((s) => s.anomaly?.gmmThreshold ?? null);
  const videoIdx = labels && video ? labels.videos.indexOf(video) : -1;
  const pos = queue.findIndex((e) => e.videoIdx === videoIdx && e.frameIdx === frameIdx);
  const entry = pos >= 0 ? liveQcEntry(queue[pos], rescored, threshold, gmmThreshold) : null;
  return { queue, pos, entry, videoIdx, frameIdx };
}

function ReviewHeader() {
  const { queue, pos, entry, videoIdx, frameIdx } = useCurrentEntry();
  const multiVideo = useAppStore((s) => (s.labels?.videos.length ?? 0) > 1);
  const threshold = useQcStore((s) => s.threshold);
  const order = useQcStore((s) => s.reviewOrder);
  const setOrder = useQcStore((s) => s.setReviewOrder);
  const edited = useQcStore((s) => s.editedFrames.has(qcFrameKey(videoIdx, frameIdx)));
  // Live: a re-scored instance counts with its new scores (or not, once fixed).
  const open = entry?.anomalies.filter(({ a, v }) => !entry.ok.includes(a.instIdx) && v.flagged) ?? [];
  const openRules = entry?.rules.filter(
    (r) => r.instanceIdx === undefined || !entry.ok.includes(r.instanceIdx),
  ) ?? [];
  const flags = openRules.length + open.length;
  const worst = Math.max(0, ...open.map(({ v }) => v.score));
  const rescored = !!entry?.anomalies.some(({ a }) => a.rescored);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <span className="font-semibold">Review</span>
      <span className="font-mono tabular-nums text-muted-foreground">
        {pos >= 0 ? pos + 1 : "–"} / {queue.length}
      </span>
      {entry && (
        <span
          className={cn(
            "rounded px-1.5 font-mono text-[11px] tabular-nums",
            flags === 0
              ? "bg-muted text-muted-foreground"
              : entry.definite || worst >= threshold
                ? "bg-red-500/20 text-red-400"
                : "bg-amber-500/15 text-amber-500",
          )}
          title={
            flags === 0
              ? "Nothing on this frame flags any more"
              : entry.definite
                ? "A definite error"
                : "Worst score on this frame"
          }
        >
          {flags === 0 ? "OK" : entry.definite ? "Error" : worst.toFixed(2)}
        </span>
      )}
      {entry && (
        <span
          className="flex items-center gap-0.5 text-muted-foreground"
          title={`${flags} flag${flags === 1 ? "" : "s"} on this frame`}
        >
          {flags}
          <Flag className="h-3 w-3" />
        </span>
      )}
      <span className="font-mono tabular-nums text-muted-foreground">
        {multiVideo && `video ${videoIdx + 1} · `}frame {frameIdx}
      </span>
      {rescored ? (
        <RescoredTag />
      ) : edited && (
        <span
          className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600"
          title="Edited since the QC run. Rerun to re-check."
        >
          edited
        </span>
      )}
      <div
        className="ml-auto flex items-center rounded-md border border-border p-0.5"
        role="tablist"
        aria-label="Order flagged frames by"
      >
        {ORDERS.map((o) => (
          <button
            key={o.order}
            role="tab"
            aria-selected={order === o.order}
            title={o.title}
            onClick={() => {
              setOrder(o.order);
              refocusQcReview();
            }}
            className={cn(
              "rounded px-2 py-0.5 text-[11px]",
              order === o.order
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
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
    </div>
  );
}

/**
 * Over the canvas (not a row of its own, so the canvas keeps its size and
 * view): the flag's node has no position yet, and a click places it.
 */
function UnplacedHint() {
  const { entry } = useCurrentEntry();
  const lf = useAppStore((s) => s.labeledFrame);
  const selected = useAppStore((s) => s.instance);
  const skeleton = useAppStore((s) => s.skeleton);
  // Placing a node edits the pose in place: re-read it after each edit.
  useAppStore((s) => s.editSeq);
  const node = qcUnplacedProblemNode(entry, lf, selected);
  if (node === null) return null;
  return (
    <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-xs text-amber-400">
      <b>{skeleton?.nodeNames[node] ?? `node ${node + 1}`}</b> isn&apos;t placed (click to place it)
    </div>
  );
}

function ReviewFooter() {
  const { entry } = useCurrentEntry();
  const lf = useAppStore((s) => s.labeledFrame);
  const selected = useAppStore((s) => s.instance);
  const skeleton = useAppStore((s) => s.skeleton);
  const threshold = useQcStore((s) => s.threshold);
  const gmmThreshold = useQcStore((s) => s.anomaly?.gmmThreshold ?? null);

  // The selected instance's flags (QC indexes userInstances).
  const instIdx = selected && lf ? lf.userInstances.indexOf(selected) : -1;
  const flagged = entry?.anomalies.find(({ a }) => a.instIdx === instIdx);
  const rules = entry?.rules.filter((r) => r.instanceIdx === instIdx) ?? [];
  const ignorable = !!entry && instIdx >= 0 && !entry.ok.includes(instIdx) && (!!flagged || rules.length > 0);
  // Re-scored after an edit and no longer flagged (rules aren't re-checked).
  const looksOk = !!flagged?.a.rescored && !flagged.v.flagged && rules.length === 0;
  const issue = looksOk
    ? "Looks OK now"
    : flagged
      ? qcIssueText(flagged.a, flagged.v, skeleton?.nodeNames ?? [])
      : rules[0]
        ? rules[0].message
        : entry
          ? "Select a flagged instance (outlined in red)."
          : "No flags on this frame.";

  const chip = (label: string, score: number | null, cut: number | null) =>
    score != null && (
      <span
        className={cn(
          "rounded border px-1.5 py-px text-[11px]",
          !looksOk && cut != null && score >= cut
            ? "border-red-500/40 text-red-400"
            : "border-border text-muted-foreground",
        )}
      >
        {label} <span className="font-mono tabular-nums">{score.toFixed(2)}</span>
      </span>
    );

  return (
    <div className="shrink-0 border-t border-border text-xs">
      <div className="flex min-h-8 items-center gap-2 px-3 py-1.5">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 truncate",
            looksOk
              ? "text-green-500"
              : flagged || rules.length > 0
                ? "text-foreground"
                : "text-muted-foreground",
          )}
          title={looksOk ? `${issue}. ${RESCORED_TITLE}` : issue}
        >
          {(flagged || rules.length > 0) && (
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", looksOk ? "bg-green-500" : "bg-red-500")}
              aria-hidden
            />
          )}
          <span className="truncate">{issue}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {flagged?.a.rescored && <RescoredTag />}
          {rules.map((r, i) => (
            <span
              key={i}
              className={cn(
                "rounded border px-1.5 py-px text-[11px]",
                SOFT_QC_KINDS.has(r.kind)
                  ? "border-amber-500/40 text-amber-500"
                  : "border-red-500/40 text-red-400",
              )}
            >
              {QC_KIND_LABEL[r.kind]}
            </span>
          ))}
          {flagged && chip("Anomaly", flagged.a.score, threshold)}
          {flagged && chip("GMM", flagged.a.gmmScore, gmmThreshold)}
        </span>
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => stepQcQueue(-1)}
          title="Previous flagged frame (←)"
        >
          ‹ Prev
        </Button>
        <div className="flex flex-1 flex-col items-center gap-1">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400"
              disabled={!selected}
              onClick={() => commandContext.execute(DeleteSelectedInstance)}
              title={`Delete the selected instance, e.g. a duplicate (${formatShortcut("$mod+Backspace")})`}
            >
              Delete instance
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-blue-500/50 text-blue-400 hover:bg-blue-500/10 hover:text-blue-400"
              disabled={!ignorable}
              onClick={() => commandContext.execute(MarkQcFlagOk)}
              title="This instance is fine: hide its flags and go to the next one (3)"
            >
              Ignore
            </Button>
          </div>
          <span className="text-[10px] text-muted-foreground">
            drag a point to fix it · scroll to zoom · 0 refit · V hide node ·{" "}
            {formatShortcut("$mod+KeyZ")} undo · Esc close
          </span>
        </div>
        <Button
          size="sm"
          className="h-7"
          onClick={() => stepQcQueue(1)}
          title="Next flagged frame (→)"
        >
          Next ›
        </Button>
      </div>
    </div>
  );
}
