/**
 * Connect window §4b.4 — the Jobs tab: every job on a worker (not just ones
 * this window is tracking), this project's jobs pinned first (★) and live,
 * others dimmed/view-only. Polls `listJobs` every 10 s while mounted (the
 * tab unmounts with the dialog close / tab switch, which stops the poll).
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/notify";
import { projectTag } from "@/lib/projectTag";
import type { JobResultBlobRef } from "@/lib/sleapConnect";
import type { JobSummary } from "@/lib/protocolV1/client";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { confirmDialog } from "@/stores/confirmStore";
import { mergeRemoteResults } from "@/stores/inferenceStore";

/** Last path segment of a worker path (handles both `/` and `\`), or `null` if absent. */
function basename(p: string | undefined): string | null {
  if (!p) return null;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** `jobTitle`+labels-basename sort key doesn't matter here — pinning + recency do. */
export function isMineJob(job: JobSummary, myProjectId: string): boolean {
  return job.project?.id === myProjectId;
}

/**
 * This project's jobs first (★), newest first within each group — pure and
 * directly unit-testable, matching the design's "this project first, then
 * createdAt desc; others dimmed/view-only" (§4.2).
 */
export function sortWorkerJobs(jobs: JobSummary[], myProjectId: string): JobSummary[] {
  return [...jobs].sort((a, b) => {
    const mineA = isMineJob(a, myProjectId);
    const mineB = isMineJob(b, myProjectId);
    if (mineA !== mineB) return mineA ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export function jobTitle(job: JobSummary): string {
  return job.kind === "track" ? "Inference" : `Train ${job.modelTypes[0] ?? "model"}`;
}

export interface JobStatusChip {
  text: string;
  className: string;
}

const CHIP_STYLES: Record<string, string> = {
  queued: "bg-zinc-800 text-zinc-300 border-zinc-600",
  running: "bg-orange-950/60 text-orange-300 border-orange-800",
  completed: "bg-green-950/60 text-green-300 border-green-800",
  failed: "bg-red-950/60 text-red-300 border-red-800",
  canceled: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

/** "Queued · #N" when a queue position is known, else the state capitalized. */
export function jobStatusChip(job: JobSummary): JobStatusChip {
  const className = CHIP_STYLES[job.state] ?? CHIP_STYLES.queued!;
  if (job.state === "queued" && job.queuePosition != null) {
    return { text: `Queued · #${job.queuePosition}`, className };
  }
  return { text: job.state.charAt(0).toUpperCase() + job.state.slice(1), className };
}

/** Compact "N ago" for a job's createdAt — mirrors WelcomeScreen's timeAgo. */
function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

export interface WorkerJobsProps {
  workerId: string;
  /** How often jobs are re-fetched while mounted, in ms. Injectable for tests; defaults to 10 s. */
  pollIntervalMs?: number;
  /** Overridable for tests (no fake timers in this repo); defaults to the real `setInterval`. */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  /** Overridable for tests; defaults to the real `clearInterval`. */
  clearIntervalImpl?: (handle: unknown) => void;
}

const DEFAULT_POLL_MS = 10000;
const defaultSetInterval = (cb: () => void, ms: number): unknown => setInterval(cb, ms);
const defaultClearInterval = (handle: unknown): void =>
  clearInterval(handle as ReturnType<typeof setInterval>);

interface ViewerTarget {
  jobId: string;
  label: string;
  initialView: "monitor" | "logs";
}

export function WorkerJobs({
  workerId,
  pollIntervalMs = DEFAULT_POLL_MS,
  setIntervalImpl = defaultSetInterval,
  clearIntervalImpl = defaultClearInterval,
}: WorkerJobsProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const listJobs = useConnectStore((s) => s.listJobs);
  const jobDetail = useConnectStore((s) => s.jobDetail);
  const cancelJobOn = useConnectStore((s) => s.cancelJobOn);
  const connectToWorker = useConnectStore((s) => s.connectToWorker);

  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  const myProjectId = useMemo(() => projectTag(projectPath).id, [projectPath]);
  const sorted = useMemo(() => sortWorkerJobs(jobs, myProjectId), [jobs, myProjectId]);

  const refresh = useMemo(
    () => async () => {
      try {
        const result = await listJobs(workerId);
        setJobs(result);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [listJobs, workerId],
  );

  useEffect(() => {
    setLoading(true);
    setJobs([]);
    setViewer(null);
    void refresh();
    const handle = setIntervalImpl(() => void refresh(), pollIntervalMs);
    return () => clearIntervalImpl(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, pollIntervalMs]);

  const openViewer = (job: JobSummary, initialView: "monitor" | "logs") =>
    setViewer({ jobId: job.jobId, label: jobTitle(job), initialView });

  const handleCancelOrStop = async (job: JobSummary) => {
    const mode: "cancel" | "stop" = job.state === "running" ? "stop" : "cancel";
    const label = mode === "stop" ? "Stop" : "Cancel";
    const ok = await confirmDialog({
      title: `${label} job?`,
      message: `${label} "${jobTitle(job)}" on this worker?`,
      confirmLabel: label,
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancelJobOn(workerId, job.jobId, mode);
      await refresh();
    } catch (err) {
      toast.error(`Failed to ${label.toLowerCase()} job`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleFetchLoad = async (job: JobSummary) => {
    setBusyJobId(job.jobId);
    try {
      const detail = await jobDetail(workerId, job.jobId);
      const resultData = detail.result as { blobs?: Record<string, JobResultBlobRef> } | null;
      const predictions = resultData?.blobs?.predictions;
      if (!predictions) {
        toast.error("No predictions were found for this job.");
        return;
      }
      if (useConnectStore.getState().selectedWorkerId !== workerId) {
        await connectToWorker(workerId);
      }
      // mode: "replace" is the app's existing default merge mode (see
      // InferencePanel's initial config / src/stores/inferenceStore.ts:280's
      // other callers) — there's no open-project InferenceConfig to read a
      // user choice from when fetching a job straight from this list.
      await mergeRemoteResults({
        results: [{ jobId: job.jobId, success: true, resultBlobs: { predictions } }],
        mode: "replace",
        trackOnly: false,
      });
      toast.success("Loaded. Predictions merged into the project.");
    } catch (err) {
      toast.error("Fetch & Load failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className="space-y-2">
      {error && (
        <div className="p-2 text-[11px] text-red-400 bg-red-500/8 border border-red-500/20 rounded-md">
          {error}
        </div>
      )}

      {loading && jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading jobs…</p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">No jobs yet.</p>
      ) : (
        <div className="space-y-2">
          {sorted.map((job) => {
            const mine = isMineJob(job, myProjectId);
            const chip = jobStatusChip(job);
            const labelsName = basename(job.labelsPath);
            const runTag = job.run && job.run.count > 1 ? `run ${job.run.index + 1}/${job.run.count}` : null;
            const canWatch = mine && job.state === "running";
            const canView = mine && (job.state === "completed" || job.state === "failed" || job.state === "canceled");
            const canCancel = mine && (job.state === "queued" || job.state === "running");
            const canFetch = mine && job.kind === "track" && job.state === "completed";
            return (
              <div
                key={job.jobId}
                className={`rounded-md border border-border p-2.5 space-y-1.5 ${
                  mine ? "bg-zinc-800/50" : "bg-transparent opacity-60"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {mine && <span className="text-orange-400 text-xs shrink-0">★</span>}
                  <div className="min-w-[160px] flex-1">
                    <div className="text-xs font-medium">{jobTitle(job)}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {labelsName ?? "—"}
                      {runTag ? ` · ${runTag}` : ""}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${chip.className}`}
                  >
                    {chip.text}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(job.createdAt)}</span>
                </div>

                {job.state === "failed" && job.error && (
                  <pre className="text-[10px] text-red-300 bg-red-950/40 border border-red-900 rounded p-1.5 whitespace-pre-wrap">
                    {job.error.split("\n")[0]}
                  </pre>
                )}

                {mine && (
                  <div className="flex gap-1.5 flex-wrap">
                    {canWatch && (
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-6 text-[10px]"
                        onClick={() => openViewer(job, "monitor")}
                      >
                        Watch live
                      </Button>
                    )}
                    {canView && (
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-6 text-[10px]"
                        onClick={() => openViewer(job, "monitor")}
                      >
                        View
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 text-[10px]"
                      onClick={() => openViewer(job, "logs")}
                    >
                      Logs
                    </Button>
                    {canCancel && (
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-6 text-[10px]"
                        onClick={() => handleCancelOrStop(job)}
                      >
                        {job.state === "running" ? "Stop" : "Cancel"}
                      </Button>
                    )}
                    {canFetch && (
                      <Button
                        size="xs"
                        className="h-6 text-[10px]"
                        disabled={busyJobId === job.jobId}
                        onClick={() => handleFetchLoad(job)}
                      >
                        {busyJobId === job.jobId ? "Fetching…" : "Fetch & Load"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* JobViewerDialog (§4b.6) replaces this inline placeholder. */}
      {viewer && (
        <div className="p-2.5 border border-border rounded-md bg-zinc-800/50 text-[11px] text-muted-foreground flex items-center justify-between gap-2">
          <span>
            Job viewer ({viewer.initialView}) for {viewer.label} — coming in §4b.6.
          </span>
          <Button size="xs" variant="ghost" className="h-6 text-[10px]" onClick={() => setViewer(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
