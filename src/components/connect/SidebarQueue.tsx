/**
 * The Connect window's sidebar queue: the picked worker's runs in progress
 * and waiting (`QueueRunList`), under Paired workers. Polls `listJobs` like
 * the Jobs tab and calls `onChanged` after a Stop Early / Cancel run, so the
 * Jobs tab catches up right away.
 *
 * A failed run of yours stays in the queue, red, until you click it (which
 * also opens it in the Jobs tab). Only yours, so a collaborator's failure
 * doesn't sit in your queue, and only from the last day, so the worker's
 * whole history of failures doesn't pile up here. Cleared runs are kept per
 * browser in localStorage.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/lib/notify";
import { projectTag } from "@/lib/projectTag";
import type { JobSummary } from "@/lib/protocolV1/client";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { confirmDialog } from "@/stores/confirmStore";
import { endJobConfirm } from "./endJobConfirm";
import { groupJobs, isManagedJob, jobTitle, type JobGroup } from "./WorkerJobs";
import {
  QueueRunList,
  cancelRunConfirm,
  queueRunEntries,
  unfinishedJobs,
  type QueueRunEntry,
} from "./WorkerQueue";

export const DISMISSED_FAILED_RUNS_KEY = "sleap-app:connect-dismissed-failed-runs";
/** How long a failed run of yours stays in the queue if you don't click it. */
export const FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 10000;

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_FAILED_RUNS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveDismissed(keys: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_FAILED_RUNS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved (e.g. private mode): it's still cleared until the window closes.
  }
}

export interface SidebarQueueProps {
  workerId: string;
  workerLabel: string;
  /** Bumped by the Connect window's Refresh (and by this queue's own actions). */
  refreshToken: number;
  /** After a Stop Early / Cancel run, so other views refresh too. */
  onChanged: () => void;
  /** Open this run's entry in the Jobs tab. */
  onOpenRun: (runKey: string) => void;
  pollIntervalMs?: number;
  /** Overridable for tests (no fake timers in this repo). */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}

const defaultSetInterval = (cb: () => void, ms: number): unknown => setInterval(cb, ms);
const defaultClearInterval = (handle: unknown): void =>
  clearInterval(handle as ReturnType<typeof setInterval>);

export function SidebarQueue({
  workerId,
  workerLabel,
  refreshToken,
  onChanged,
  onOpenRun,
  pollIntervalMs = DEFAULT_POLL_MS,
  setIntervalImpl = defaultSetInterval,
  clearIntervalImpl = defaultClearInterval,
}: SidebarQueueProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const listJobs = useConnectStore((s) => s.listJobs);
  const cancelJobOn = useConnectStore((s) => s.cancelJobOn);
  const trackedJobs = useConnectStore((s) => s.trackedJobs);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  const myProjectId = useMemo(() => projectTag(projectPath).id, [projectPath]);
  const trackedJobIds = useMemo(
    () => new Set(trackedJobs.filter((j) => j.workerId === workerId).map((j) => j.jobId)),
    [trackedJobs, workerId],
  );
  const canManage = (group: JobGroup) => group.jobs.some((j) => isManagedJob(j, myProjectId, trackedJobIds));

  const entries = useMemo(() => {
    const manages = (group: JobGroup) => group.jobs.some((j) => isManagedJob(j, myProjectId, trackedJobIds));
    const showFailed = (group: JobGroup) =>
      manages(group) &&
      group.jobs.some(
        (j) => j.state === "failed" && Date.now() - new Date(j.updatedAt ?? j.createdAt).getTime() < FAILED_SHOWN_MS,
      );
    return queueRunEntries(groupJobs(jobs, myProjectId), { showFailed, dismissed });
  }, [jobs, myProjectId, trackedJobIds, dismissed]);

  const refresh = useMemo(
    () => async () => {
      try {
        setJobs(await listJobs(workerId));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [listJobs, workerId],
  );

  useEffect(() => {
    setJobs([]);
  }, [workerId]);

  useEffect(() => {
    void refresh();
    const handle = setIntervalImpl(() => void refresh(), pollIntervalMs);
    return () => clearIntervalImpl(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, pollIntervalMs, refreshToken]);

  const handleOpen = (entry: QueueRunEntry) => {
    if (entry.status === "failed") {
      const next = new Set(dismissed).add(entry.group.key);
      setDismissed(next);
      saveDismissed(next);
    }
    onOpenRun(entry.group.key);
  };

  const handleStopEarly = async (job: JobSummary) => {
    if (!(await confirmDialog(endJobConfirm(jobTitle(job), "stop", false)))) return;
    try {
      await cancelJobOn(workerId, job.jobId, "stop");
    } catch (err) {
      toast.error("Failed to stop training early", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
    onChanged();
  };

  const handleCancelRun = async (group: JobGroup) => {
    if (!(await confirmDialog(cancelRunConfirm(group)))) return;
    try {
      for (const job of unfinishedJobs(group)) await cancelJobOn(workerId, job.jobId, "cancel");
    } catch (err) {
      toast.error("Failed to cancel run", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
    onChanged();
  };

  return (
    <section className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1.5 shrink-0">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate">
          Queue on {workerLabel}
        </span>
        {entries.length > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {entries.length} run{entries.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {error ? (
          <p className="px-1 text-[11px] text-red-400">{error}</p>
        ) : (
          <QueueRunList
            entries={entries}
            canManage={canManage}
            onOpen={handleOpen}
            onStopEarly={(job) => void handleStopEarly(job)}
            onCancelRun={(group) => void handleCancelRun(group)}
          />
        )}
      </div>
    </section>
  );
}
