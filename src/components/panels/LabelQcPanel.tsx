/**
 * Label QC panel: review QC flags frame by frame.
 *
 * Shares its results with the Label Quality Check dialog (qcStore), so a run
 * started in either shows up in both. The flagged frames are listed on top,
 * worst first; the card below shows everything QC found on the current frame.
 * F / Shift+F step through the list from anywhere (navCommands), and 3 (or a
 * card's Mark OK) marks a flagged instance OK so its flags go away.
 */
import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import {
  buildQcQueue,
  goToQcEntry,
  hasOpenFlags,
  hideOkFlags,
  markQcOkAndAdvance,
  qcFrameKey,
  qcIsOk,
  stepQcQueue,
  useQcStore,
  type QcQueueEntry,
} from "@/stores/qcStore";
import { QC_KIND_LABEL, SOFT_QC_KINDS } from "@/lib/analyze/labelQc";

export function LabelQcPanel() {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const skeleton = useAppStore((s) => s.skeleton);
  // Edits change pose fingerprints, so OK marks are re-matched after each.
  const editSeq = useAppStore((s) => s.editSeq);
  const {
    state,
    progress,
    findings,
    anomaly,
    threshold,
    editedFrames,
    dismissed,
    showDismissed,
    run,
    cancel,
    setThreshold,
    setShowDismissed,
    unmarkOk,
  } = useQcStore();

  const full = useMemo(
    () => buildQcQueue(findings, anomaly, threshold, qcIsOk(labels, dismissed)),
    // editSeq isn't read, but each edit can change a fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findings, anomaly, threshold, labels, dismissed, editSeq],
  );
  const queue = useMemo(() => (showDismissed ? full : hideOkFlags(full)), [full, showDismissed]);
  const openCount = useMemo(() => full.filter(hasOpenFlags).length, [full]);
  const okCount = useMemo(() => full.reduce((n, e) => n + e.ok.length, 0), [full]);
  const videoIdx = labels && video ? labels.videos.indexOf(video) : -1;
  const pos = queue.findIndex((e) => e.videoIdx === videoIdx && e.frameIdx === frameIdx);
  const current = pos >= 0 ? queue[pos] : null;
  const multiVideo = (labels?.videos.length ?? 0) > 1;
  const nodeNames = skeleton?.nodeNames ?? [];

  // Keep the current frame's row in view as F/Shift+F move through the list.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [pos]);

  const frameLabel = (e: { videoIdx: number; frameIdx: number }) =>
    `${multiVideo ? `V${e.videoIdx + 1} · ` : ""}${e.frameIdx}`;
  const isEdited = (e: QcQueueEntry) => editedFrames.has(qcFrameKey(e.videoIdx, e.frameIdx));

  /** Mark OK, or (once marked) its "OK" tag and Undo, for one flagged instance. */
  const okControl = (e: QcQueueEntry, instIdx: number) =>
    e.ok.includes(instIdx) ? (
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="rounded bg-green-500/15 px-1 text-[10px] text-green-500">Ignored</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[10px]"
          onClick={() => unmarkOk(e.videoIdx, e.frameIdx, instIdx)}
          title="Flag this instance again"
        >
          Undo
        </Button>
      </span>
    ) : (
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-5 shrink-0 border-green-500/50 px-1.5 text-[10px] text-green-400 hover:bg-green-500/10"
        onClick={() => markQcOkAndAdvance(e.videoIdx, e.frameIdx, instIdx)}
        title="This instance is fine: hide its flags and go to the next one (3)"
      >
        Ignore
      </Button>
    );

  const scoreBar = (label: string, score: number | null, cut: number | null) => (
    <div className="flex items-center gap-1.5">
      <span className="w-12 text-[10px] text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
        {score != null && (
          <div
            className={cn(
              "h-full rounded",
              cut != null && score >= cut ? "bg-red-500" : "bg-muted-foreground/40",
            )}
            style={{ width: `${Math.round(score * 100)}%` }}
          />
        )}
      </div>
      <span className="w-8 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {score != null ? score.toFixed(2) : "—"}
      </span>
    </div>
  );

  /** Everything QC found on the current frame. */
  const card = (e: QcQueueEntry) => (
    <div className={cn("flex flex-col gap-2", isEdited(e) && "opacity-60")}>
      {isEdited(e) && (
        <p className="text-[11px] text-amber-600">Edited since the run. Rerun to re-check.</p>
      )}
      {e.rules.map((r, i) => {
        const soft = SOFT_QC_KINDS.has(r.kind);
        const ok = r.instanceIdx !== undefined && e.ok.includes(r.instanceIdx);
        return (
          <div
            key={`r${i}`}
            className={cn(
              "rounded border px-2 py-1.5",
              ok
                ? "border-border/60"
                : soft
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-red-500/30 bg-red-500/5",
            )}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <span
                className={cn(
                  "rounded px-1 text-[10px]",
                  ok
                    ? "bg-muted text-muted-foreground"
                    : soft
                      ? "bg-amber-500/15 text-amber-600"
                      : "bg-red-500/15 text-red-500",
                )}
              >
                {soft ? "Possible" : "Error"}
              </span>
              {QC_KIND_LABEL[r.kind]}
              {r.instanceIdx !== undefined && (
                <span className="text-muted-foreground">· inst {r.instanceIdx + 1}</span>
              )}
              {r.instanceIdx !== undefined && okControl(e, r.instanceIdx)}
            </div>
            <p className={cn("mt-0.5 text-[11px] text-muted-foreground", ok && "opacity-60")}>
              {r.message}
            </p>
          </div>
        );
      })}
      {e.anomalies.map(({ a, v }) => {
        const node = a.gmmNode != null && a.gmmNode >= 0 ? nodeNames[a.gmmNode] : null;
        const ok = e.ok.includes(a.instIdx);
        return (
          // Not a <button>: it holds the Mark OK / Undo buttons.
          <div
            key={`a${a.instIdx}`}
            role="button"
            tabIndex={0}
            className="cursor-pointer rounded border border-border/60 px-2 py-1.5 text-left hover:bg-muted/40"
            onClick={(ev) => {
              if ((ev.target as HTMLElement).closest("button")) return;
              if (labels) goToQcEntry(labels, { ...e, anomalies: [{ a, v }] });
            }}
            onKeyDown={(ev) => {
              if (ev.target !== ev.currentTarget || (ev.key !== "Enter" && ev.key !== " ")) return;
              ev.preventDefault();
              if (labels) goToQcEntry(labels, { ...e, anomalies: [{ a, v }] });
            }}
            title="Select this instance"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <span
                className={cn(
                  "rounded px-1 text-[10px]",
                  ok ? "bg-muted text-muted-foreground" : "bg-amber-500/15 text-amber-600",
                )}
              >
                {v.by === "gmm" ? "GMM" : v.by === "both" ? "Anomaly + GMM" : "Anomaly"}
              </span>
              inst {a.instIdx + 1}
              {node && <span className="truncate text-muted-foreground">· {node}</span>}
              {okControl(e, a.instIdx)}
            </div>
            <div className={cn(ok && "opacity-60")}>
              <p className="mt-0.5 mb-1 text-[11px] text-muted-foreground">{v.issue}</p>
              {scoreBar("Anomaly", a.score, threshold)}
              {scoreBar("GMM", a.gmmScore, anomaly?.gmmThreshold ?? null)}
            </div>
          </div>
        );
      })}
    </div>
  );

  // OK instances' flags sort last, so [0] is an open flag when there is one.
  const summary = (e: QcQueueEntry) =>
    e.rules.length > 0 && (e.definite || e.anomalies.length === 0)
      ? QC_KIND_LABEL[e.rules[0].kind]
      : (e.anomalies[0]?.v.issue ?? "");
  const allOk = (e: QcQueueEntry) => e.ok.length > 0 && !hasOpenFlags(e);
  /** Every issue on the frame, one per line (the row's hover text). */
  const allIssues = (e: QcQueueEntry) =>
    [
      ...e.rules.map((r) => QC_KIND_LABEL[r.kind]),
      ...e.anomalies.map(({ a, v }) => `${v.issue} (inst ${a.instIdx + 1})`),
    ].join("\n");
  const maxOf = (xs: (number | null)[]) => {
    const n = xs.filter((x): x is number => x != null);
    return n.length ? Math.max(...n) : null;
  };
  const scoreCell = (score: number | null, cut: number | null) => (
    <span
      className={cn(
        "w-9 shrink-0 text-right font-mono tabular-nums",
        score != null && cut != null && score >= cut ? "text-red-500" : "text-muted-foreground",
      )}
    >
      {score != null ? score.toFixed(2) : "—"}
    </span>
  );

  // ── Body by state ──

  let body: React.ReactNode;
  if (!labels) {
    body = <p className="px-2 text-[11px] text-muted-foreground">Open a project to run QC.</p>;
  } else if (state === "idle") {
    body = (
      <p className="px-2 text-[11px] text-muted-foreground">
        Checks your labeled instances for definite errors (duplicates, points outside the
        frame…) and unusual poses, then lists the flagged frames worst first. Press F /
        Shift+F to step through them, and 3 to ignore a false alarm.
      </p>
    );
  } else if (state === "running") {
    body = <p className="px-2 text-[11px] text-muted-foreground">Analyzing labels…</p>;
  } else if (queue.length === 0) {
    body = (
      <p className="px-2 text-[11px] text-muted-foreground">
        {okCount > 0
          ? "Every flag is ignored."
          : "Nothing flagged. Lower the threshold to flag more."}
      </p>
    );
  } else {
    body = (
      <>
        <div className="flex items-center gap-1 px-2">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-1.5"
            onClick={() => stepQcQueue(-1)}
            title="Previous flagged frame (Shift+F)"
            aria-label="Previous flagged frame"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="flex-1 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
            {pos >= 0 ? pos + 1 : "–"} / {queue.length}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-1.5"
            onClick={() => stepQcQueue(1)}
            title="Next flagged frame (F)"
            aria-label="Next flagged frame"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div
          ref={listRef}
          className="max-h-64 min-h-0 shrink-0 overflow-auto border-y border-border/40"
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground">
            <span className="w-12 shrink-0">Frame</span>
            <span className="min-w-0 flex-1">Issue</span>
            <span className="w-9 shrink-0 text-right">Anomaly</span>
            <span className="w-9 shrink-0 text-right">GMM</span>
          </div>
          {queue.map((e, i) => {
            const more = e.rules.length + e.anomalies.length - 1;
            return (
              <button
                key={qcFrameKey(e.videoIdx, e.frameIdx)}
                data-current={i === pos}
                onClick={() => goToQcEntry(labels, e)}
                title={allIssues(e)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-muted/40",
                  i === pos && "bg-primary/10",
                  (isEdited(e) || allOk(e)) && "opacity-50",
                )}
              >
                <span className="w-12 shrink-0 font-mono tabular-nums">{frameLabel(e)}</span>
                <span className="flex min-w-0 flex-1 gap-1">
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      e.definite ? "text-red-500" : "text-muted-foreground",
                    )}
                  >
                    {summary(e)}
                  </span>
                  {more > 0 && (
                    <span className="shrink-0 text-muted-foreground/70">+{more} more</span>
                  )}
                  {allOk(e) && (
                    <span className="shrink-0 rounded bg-green-500/15 px-1 text-[10px] text-green-500">
                      Ignored
                    </span>
                  )}
                </span>
                {scoreCell(maxOf(e.anomalies.map(({ a }) => a.score)), threshold)}
                {scoreCell(
                  maxOf(e.anomalies.map(({ a }) => a.gmmScore)),
                  anomaly?.gmmThreshold ?? null,
                )}
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-2 px-2">
          <div className="text-[11px] font-medium">
            Frame {video ? frameLabel({ videoIdx, frameIdx }) : "—"}
          </div>
          {current ? (
            card(current)
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No QC flags on this frame.{" "}
              <button className="text-primary underline" onClick={() => stepQcQueue(1)}>
                Next flagged frame (F)
              </button>
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto pb-2">
      <div className="flex flex-col gap-2 px-2 pt-2">
        {state === "running" ? (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full rounded bg-primary transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {Math.round(progress * 100)}%
            </span>
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={state === "done" ? "outline" : "default"}
              className="h-6 text-[11px]"
              disabled={!labels}
              onClick={() => labels && void run(labels)}
            >
              {state === "done" ? "Rerun" : "Run QC"}
            </Button>
            {state === "done" && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {openCount} flagged frame{openCount === 1 ? "" : "s"}
                {okCount > 0 && <> · {okCount} ignored</>}
              </span>
            )}
            {state === "done" && okCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 shrink-0 px-1.5"
                onClick={() => setShowDismissed(!showDismissed)}
                aria-label={showDismissed ? "Hide ignored" : "Show ignored"}
                aria-pressed={showDismissed}
                title={
                  showDismissed
                    ? "Hide the ignored instances"
                    : "Show the ignored instances, to undo"
                }
              >
                {showDismissed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        )}
        {state === "done" && (anomaly?.instances.length ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Threshold
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button aria-label="What does the threshold do?">
                      <CircleHelp className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-64 text-[11px]">
                    Threshold for the instance anomaly score (how unusual its most unusual
                    pose measurement is, from 0 to 1). Doesn&apos;t filter GMM (Gaussian
                    Mixture Model) scores, which always flag about{" "}
                    {Math.round((1 - (anomaly?.gmmThreshold ?? 0.95)) * 100)}% of poses, the
                    least typical ones.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[threshold]}
              onValueChange={([v]) => setThreshold(v)}
              className="flex-1"
              aria-label="Anomaly score threshold"
            />
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {threshold.toFixed(2)}
            </span>
          </div>
        )}
      </div>
      {body}
    </div>
  );
}
