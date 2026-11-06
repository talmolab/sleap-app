/**
 * The Connect window's queue (sidebar, under Paired workers): one card per
 * run, the run in progress first, then queued runs in the order they'll
 * start, with a row per model (+ inference) carrying the same status badges
 * as the Jobs tab. A failed run of yours stays at the top, red, until you
 * click it. Cards have no buttons: a click opens the run's entry in the Jobs
 * tab, a right-click offers Stop Early / Cancel run.
 */
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { JobSummary } from "@/lib/protocolV1/client";
import type { ConfirmRequest } from "@/stores/confirmStore";
import { jobStatusChip, jobTitle, type JobGroup, type JobStatusChip } from "./WorkerJobs";

/** A run still on the worker's queue: one of its jobs is running or queued. */
export function isActiveGroup(group: JobGroup): boolean {
  return group.jobs.some((j) => j.state === "running" || j.state === "queued");
}

/** A run's jobs that are still running or queued — what "Cancel run" ends. */
export function unfinishedJobs(group: JobGroup): JobSummary[] {
  return group.jobs.filter((j) => j.state === "running" || j.state === "queued");
}

/** The confirm dialog for "Cancel run". */
export function cancelRunConfirm(group: JobGroup): ConfirmRequest {
  return {
    title: "Cancel this run?",
    message:
      `${unfinishedJobs(group).map(jobTitle).join("\n")}\n\n` +
      "Every unfinished job of this run ends now; queued ones won't run. Jobs behind it in the queue start next.",
    confirmLabel: "Cancel run",
    cancelLabel: "Keep running",
    destructive: true,
  };
}

/** The earliest queue position among a run's queued jobs, or null if none is queued. */
function groupQueuePosition(group: JobGroup): number | null {
  const positions = group.jobs
    .filter((j) => j.state === "queued" && j.queuePosition != null)
    .map((j) => j.queuePosition as number);
  return positions.length > 0 ? Math.min(...positions) : null;
}

/** One model/inference line inside a run's queue card. */
export interface QueueRow {
  key: string;
  title: string;
  /** null for inference the run will chain after training (not a worker job yet). */
  job: JobSummary | null;
  chip: JobStatusChip;
  /** The row the worker is on right now. */
  active: boolean;
}

/** A run in the queue: running, waiting, or failed (kept until you click it). */
export interface QueueRunEntry {
  group: JobGroup;
  status: "running" | "queued" | "failed";
  /** 1-based place among the queued runs. */
  place: number | null;
  rows: QueueRow[];
}

const AFTER_TRAINING_CHIP: JobStatusChip = {
  text: "After training",
  className: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

/**
 * A row per job of the run (training models in order, then inference), plus
 * an "After training" inference row when the worker will chain inference
 * (`postInference` on the last model) but hasn't created that job yet.
 */
export function queueRows(group: JobGroup): QueueRow[] {
  const rows: QueueRow[] = group.jobs.map((job) => ({
    key: job.jobId,
    title: job.kind === "track" ? "Inference" : (job.modelTypes[0] ?? "model"),
    job,
    chip: jobStatusChip(job),
    active: job.state === "running",
  }));
  const trainJobs = group.jobs.filter((j) => j.kind !== "track");
  const lastTrain = trainJobs[trainJobs.length - 1];
  const ended = group.jobs.some((j) => j.state === "failed" || j.state === "canceled");
  if (lastTrain?.postInference && !group.jobs.some((j) => j.kind === "track") && !ended) {
    rows.push({ key: `${group.key}:inference`, title: "Inference", job: null, chip: AFTER_TRAINING_CHIP, active: false });
  }
  return rows;
}

/**
 * The queue's runs: failed runs `showFailed` keeps and you haven't dismissed
 * (first, so a failure isn't missed), then the running run(s), then queued
 * runs by their earliest queue position (the worker runs jobs first come,
 * first served).
 */
export function queueRunEntries(
  groups: JobGroup[],
  opts: { showFailed: (group: JobGroup) => boolean; dismissed: Set<string> },
): QueueRunEntry[] {
  const failed = groups.filter(
    (g) =>
      !isActiveGroup(g) &&
      g.jobs.some((j) => j.state === "failed") &&
      !opts.dismissed.has(g.key) &&
      opts.showFailed(g),
  );
  const active = groups.filter(isActiveGroup);
  const running = active.filter((g) => g.jobs.some((j) => j.state === "running"));
  const waiting = active
    .filter((g) => !g.jobs.some((j) => j.state === "running"))
    .sort((a, b) => (groupQueuePosition(a) ?? Infinity) - (groupQueuePosition(b) ?? Infinity));
  return [
    ...failed.map((group) => ({ group, status: "failed" as const, place: null, rows: queueRows(group) })),
    ...running.map((group) => ({ group, status: "running" as const, place: null, rows: queueRows(group) })),
    ...waiting.map((group, i) => ({ group, status: "queued" as const, place: i + 1, rows: queueRows(group) })),
  ];
}

export interface QueueRunListProps {
  entries: QueueRunEntry[];
  /** Whether this window may stop/cancel the run (this project's, or tracked here). */
  canManage: (group: JobGroup) => boolean;
  /** Click: open the run in the Jobs tab (and clear it from the queue if it failed). */
  onOpen: (entry: QueueRunEntry) => void;
  onStopEarly: (job: JobSummary) => void;
  onCancelRun: (group: JobGroup) => void;
}

// Outline tones match the Jobs tab's Running/Failed badges' palette; a
// queued card looks like a worker card.
const CARD_STYLE: Record<QueueRunEntry["status"], string> = {
  running: "border-green-800 bg-green-950/40 hover:bg-green-950/60",
  failed: "border-red-800 bg-red-950/40 hover:bg-red-950/60",
  queued: "border-border bg-zinc-800/50 hover:bg-zinc-800",
};

const MARKER_STYLE: Record<QueueRunEntry["status"], string> = {
  running: "text-green-400",
  failed: "text-red-400",
  queued: "text-muted-foreground",
};

export function QueueRunList({ entries, canManage, onOpen, onStopEarly, onCancelRun }: QueueRunListProps) {
  if (entries.length === 0) {
    return <p className="px-1 text-[11px] text-muted-foreground">Nothing running or queued.</p>;
  }
  return (
    <ol className="space-y-1.5">
      {entries.map((entry) => {
        const { group, status, place, rows } = entry;
        const manage = canManage(group);
        const runningTrain = group.jobs.find((j) => j.state === "running" && j.kind !== "track");
        const failure = group.jobs.find((j) => j.state === "failed")?.error?.split("\n")[0];
        return (
          <ContextMenu key={group.key}>
            <ContextMenuTrigger asChild>
              <li
                role="button"
                tabIndex={0}
                aria-label={`${group.title}: open in Jobs`}
                title={status === "failed" ? "Open in Jobs (and clear from the queue)" : "Open in Jobs"}
                onClick={() => onOpen(entry)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(entry);
                  }
                }}
                className={`rounded-md border p-2 space-y-1 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${CARD_STYLE[status]}`}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium min-w-0">
                  <span className={`shrink-0 w-5 text-[10px] font-semibold ${MARKER_STYLE[status]}`}>
                    {status === "running" ? "▶" : status === "failed" ? "✕" : `#${place}`}
                  </span>
                  {group.mine && <span className="text-orange-400 shrink-0">★</span>}
                  <span className="truncate" title={group.title}>
                    {group.title}
                  </span>
                </div>
                <div className="pl-[26px] text-[10px] text-muted-foreground truncate">
                  {group.labelsName ?? "—"}
                  {!group.mine && ` · ${group.project?.name ? `from ${group.project.name}` : "other project"}`}
                </div>
                <ul className="pl-[26px] space-y-0.5">
                  {rows.map((row) => (
                    <li
                      key={row.key}
                      className={`flex items-center gap-2 text-[11px] ${row.active ? "font-medium" : "opacity-50"}`}
                    >
                      <span className="truncate flex-1">{row.title}</span>
                      <span
                        className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${row.chip.className}`}
                      >
                        {row.chip.text}
                      </span>
                    </li>
                  ))}
                </ul>
                {status === "failed" && (
                  <p className="pl-[26px] text-[10px] text-red-300 truncate" title={failure}>
                    {failure ?? "Failed"}
                  </p>
                )}
              </li>
            </ContextMenuTrigger>
            <ContextMenuContent className="text-xs">
              <ContextMenuItem onSelect={() => onOpen(entry)}>
                {status === "failed" ? "Open in Jobs and clear" : "Open in Jobs"}
              </ContextMenuItem>
              {manage && runningTrain && (
                <ContextMenuItem onSelect={() => onStopEarly(runningTrain)}>
                  Stop Early ({runningTrain.modelTypes[0] ?? "model"})
                </ContextMenuItem>
              )}
              {manage && status !== "failed" && (
                <ContextMenuItem variant="destructive" onSelect={() => onCancelRun(group)}>
                  Cancel run
                </ContextMenuItem>
              )}
              {!manage && status !== "failed" && (
                <ContextMenuItem disabled>View only (another project's run)</ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </ol>
  );
}
