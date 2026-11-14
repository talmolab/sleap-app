/**
 * Label QC Review window: the main canvas, framed as a window over the dimmed
 * app, for stepping through QC flags one at a time.
 *
 * Not a second canvas: VideoPlayer always renders its canvas inside this
 * frame, which only adds a header (position, score, ordering tabs) and a
 * footer (issue, Prev / Delete instance / Ignore / Next) while
 * `qcStore.reviewOpen`. So dragging nodes, V, ⌘Z and zoom all work as usual.
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
  qcFrameKey,
  qcIsOk,
  sortQcQueue,
  stepQcQueue,
  useQcStore,
  type QcReviewOrder,
} from "@/stores/qcStore";
import { commandContext, DeleteSelectedInstance, MarkQcFlagOk } from "@/commands";
import { QC_KIND_LABEL, SOFT_QC_KINDS } from "@/lib/analyze/labelQc";
import { qcIssueText } from "@/lib/qcReview";
import { formatShortcut } from "@/lib/formatShortcut";

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
        {children}
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

/** The flagged frame on screen and its position in the queue (-1 when not flagged). */
function useCurrentEntry() {
  const queue = useReviewQueue();
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const videoIdx = labels && video ? labels.videos.indexOf(video) : -1;
  const pos = queue.findIndex((e) => e.videoIdx === videoIdx && e.frameIdx === frameIdx);
  return { queue, pos, entry: pos >= 0 ? queue[pos] : null, videoIdx, frameIdx };
}

function ReviewHeader() {
  const { queue, pos, entry, videoIdx, frameIdx } = useCurrentEntry();
  const multiVideo = useAppStore((s) => (s.labels?.videos.length ?? 0) > 1);
  const threshold = useQcStore((s) => s.threshold);
  const order = useQcStore((s) => s.reviewOrder);
  const setOrder = useQcStore((s) => s.setReviewOrder);
  const edited = useQcStore((s) => s.editedFrames.has(qcFrameKey(videoIdx, frameIdx)));
  const flags = entry
    ? entry.rules.filter((r) => r.instanceIdx === undefined || !entry.ok.includes(r.instanceIdx))
        .length + entry.anomalies.filter(({ a }) => !entry.ok.includes(a.instIdx)).length
    : 0;

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
            entry.definite || entry.worst >= threshold
              ? "bg-red-500/20 text-red-400"
              : "bg-amber-500/15 text-amber-500",
          )}
          title={entry.definite ? "A definite error" : "Worst score on this frame"}
        >
          {entry.definite ? "Error" : entry.worst.toFixed(2)}
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
      {edited && (
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
            onClick={() => setOrder(o.order)}
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
  const issue = flagged
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
          cut != null && score >= cut
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
            flagged || rules.length > 0 ? "text-foreground" : "text-muted-foreground",
          )}
          title={issue}
        >
          {(flagged || rules.length > 0) && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
          )}
          <span className="truncate">{issue}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
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
              className="h-7 border-green-500/50 text-green-400 hover:bg-green-500/10 hover:text-green-400"
              disabled={!ignorable}
              onClick={() => commandContext.execute(MarkQcFlagOk)}
              title="This instance is fine: hide its flags and go to the next one (3)"
            >
              Ignore
            </Button>
          </div>
          <span className="text-[10px] text-muted-foreground">
            drag a point to fix it · scroll to zoom · V hide node ·{" "}
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
