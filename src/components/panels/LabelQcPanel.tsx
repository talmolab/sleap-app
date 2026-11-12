/**
 * Label QC panel: review QC flags frame by frame.
 *
 * Shares its results with the Label Quality Check dialog (qcStore), so a run
 * started in either shows up in both. The flagged frames are listed on top,
 * worst first; the card below shows everything QC found on the current frame.
 * F / Shift+F step through the list from anywhere (navCommands).
 */
import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import {
  buildQcQueue,
  goToQcEntry,
  qcFrameKey,
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
  const {
    state,
    progress,
    findings,
    anomaly,
    threshold,
    editedFrames,
    run,
    cancel,
    setThreshold,
  } = useQcStore();

  const queue = useMemo(
    () => buildQcQueue(findings, anomaly, threshold),
    [findings, anomaly, threshold],
  );
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
        return (
          <div
            key={`r${i}`}
            className={cn(
              "rounded border px-2 py-1.5",
              soft ? "border-amber-500/30 bg-amber-500/5" : "border-red-500/30 bg-red-500/5",
            )}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <span
                className={cn(
                  "rounded px-1 text-[10px]",
                  soft ? "bg-amber-500/15 text-amber-600" : "bg-red-500/15 text-red-500",
                )}
              >
                {soft ? "Possible" : "Error"}
              </span>
              {QC_KIND_LABEL[r.kind]}
              {r.instanceIdx !== undefined && (
                <span className="text-muted-foreground">· inst {r.instanceIdx + 1}</span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{r.message}</p>
          </div>
        );
      })}
      {e.anomalies.map(({ a, v }) => {
        const node = a.gmmNode != null && a.gmmNode >= 0 ? nodeNames[a.gmmNode] : null;
        return (
          <button
            key={`a${a.instIdx}`}
            className="rounded border border-border/60 px-2 py-1.5 text-left hover:bg-muted/40"
            onClick={() => labels && goToQcEntry(labels, { ...e, anomalies: [{ a, v }] })}
            title="Select this instance"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600">
                {v.by === "gmm" ? "GMM" : v.by === "both" ? "Anomaly + GMM" : "Anomaly"}
              </span>
              inst {a.instIdx + 1}
              {node && <span className="text-muted-foreground">· {node}</span>}
            </div>
            <p className="mt-0.5 mb-1 text-[11px] text-muted-foreground">{v.issue}</p>
            {scoreBar("Anomaly", a.score, threshold)}
            {scoreBar("GMM", a.gmmScore, anomaly?.gmmThreshold ?? null)}
          </button>
        );
      })}
    </div>
  );

  const summary = (e: QcQueueEntry) =>
    e.rules.length > 0 && (e.definite || e.anomalies.length === 0)
      ? QC_KIND_LABEL[e.rules[0].kind]
      : (e.anomalies[0]?.v.issue ?? "");

  // ── Body by state ──

  let body: React.ReactNode;
  if (!labels) {
    body = <p className="px-2 text-[11px] text-muted-foreground">Open a project to run QC.</p>;
  } else if (state === "idle") {
    body = (
      <p className="px-2 text-[11px] text-muted-foreground">
        Checks your labeled instances for definite errors (duplicates, points outside the
        frame…) and unusual poses, then lists the flagged frames worst first. Press F /
        Shift+F to step through them.
      </p>
    );
  } else if (state === "running") {
    body = <p className="px-2 text-[11px] text-muted-foreground">Analyzing labels…</p>;
  } else if (queue.length === 0) {
    body = (
      <p className="px-2 text-[11px] text-muted-foreground">
        Nothing flagged. Lower the threshold to flag more.
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
          {queue.map((e, i) => {
            const count = e.rules.length + e.anomalies.length;
            return (
              <button
                key={qcFrameKey(e.videoIdx, e.frameIdx)}
                data-current={i === pos}
                onClick={() => goToQcEntry(labels, e)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-muted/40",
                  i === pos && "bg-primary/10",
                  isEdited(e) && "opacity-50",
                )}
              >
                <span className="w-12 shrink-0 font-mono tabular-nums">{frameLabel(e)}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    e.definite ? "text-red-500" : "text-muted-foreground",
                  )}
                >
                  {summary(e)}
                  {count > 1 && <span className="text-muted-foreground"> +{count - 1}</span>}
                </span>
                <span className="w-8 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
                  {e.worst > 0 ? e.worst.toFixed(2) : ""}
                </span>
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
              <span className="text-[11px] text-muted-foreground">
                {queue.length} flagged frame{queue.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
        {state === "done" && (anomaly?.instances.length ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Threshold</span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[threshold]}
              onValueChange={([v]) => setThreshold(v)}
              className="flex-1"
              aria-label="Anomaly flag threshold"
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
