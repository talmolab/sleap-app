/**
 * Connect window §4b.4 — the Jobs tab: every job on a worker (not just ones
 * this window is tracking), this project's jobs pinned first (★) and live,
 * others dimmed/view-only. Polls `listJobs` every 10 s while mounted (the
 * tab unmounts with the dialog close / tab switch, which stops the poll).
 *
 * PR5b adds "+ New job" (the launcher wizard, design §4.3), "Run again" on a
 * failed train job (re-seeds the wizard from that run's own config), and
 * widens Fetch & Load to every completed track job (via
 * `MergePredictionsDialog`'s compatibility check, design §6) rather than
 * just this project's own. Remote inference now starts ONLY from "+ New
 * job" -> Inference (`NewJobWizard`), not from a per-row action here — a
 * per-row "Run inference" on every completed train job broke for a split
 * multi-model run (centroid + centered_instance = two rows, two buttons,
 * neither runnable alone; the wizard groups a run's siblings itself).
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/notify";
import { projectTag } from "@/lib/projectTag";
import { timeAgo } from "@/lib/timestamp";
import type { JobSummary, JobStatus } from "@/lib/protocolV1/client";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { confirmDialog } from "@/stores/confirmStore";
import { JobViewerDialog } from "./JobViewerDialog";
import { MergePredictionsDialog } from "./MergePredictionsDialog";
import { NewJobWizard, seedWizardFromRun, type NewJobWizardSeed } from "./NewJobWizard";

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

/**
 * Whether Cancel/Run again are offered for `job` (PR5b §5b.3) — this
 * project's own job BY ID (`isMineJob`), OR one this window is actively
 * tracking (`trackedJobIds`, e.g. a launcher-wizard submission from earlier
 * this session whose project tag happens to differ, or a job this window
 * resumed watching after a restart).
 */
export function isManagedJob(job: JobSummary, myProjectId: string, trackedJobIds: Set<string>): boolean {
  return isMineJob(job, myProjectId) || trackedJobIds.has(job.jobId);
}

/**
 * This job's siblings in its training run (`run.id`, in `run.index` order),
 * or just itself if it was never split (`run` absent/`count === 1`) — "Run
 * again" (`seedWizardFromRun`) needs every model of a split multi-model run,
 * not just the row the user clicked. (The Inference flow's own "Models" step,
 * `NewJobWizard`'s `groupCompletedRuns`, does its own equivalent grouping —
 * it also needs to exclude a run with a still-running sibling, which this
 * helper doesn't care about for "Run again".)
 */
export function siblingJobIds(jobs: JobSummary[], job: JobSummary): string[] {
  if (!job.run) return [job.jobId];
  return jobs
    .filter((j) => j.run?.id === job.run!.id)
    .sort((a, b) => (a.run?.index ?? 0) - (b.run?.index ?? 0))
    .map((j) => j.jobId);
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

/** "Queued · #N" when a queue position is known, else the state capitalized. Shared by `jobStatusChip` (a job) and a group's rolled-up status. */
export function statusChipFor(state: string, queuePosition: number | null = null): JobStatusChip {
  const className = CHIP_STYLES[state] ?? CHIP_STYLES.queued!;
  if (state === "queued" && queuePosition != null) {
    return { text: `Queued · #${queuePosition}`, className };
  }
  return { text: state.charAt(0).toUpperCase() + state.slice(1), className };
}

export function jobStatusChip(job: JobSummary): JobStatusChip {
  return statusChipFor(job.state, job.queuePosition);
}

/**
 * One submission's jobs, grouped: a top-down/split train's sibling model
 * jobs (`run.id`, ordered by `run.index`), plus any job chained onto that
 * run as inference — the worker's own `post_inference` chaining (sleap-connect
 * PR5w) and `trainingStore`'s own post-training flow (`connectStore.submitJob`'s
 * `options.run` override) both tag their inference job with the SAME `run.id`
 * as the training jobs it followed, and `run.stage === "inference"` marks it
 * as such. A job with no `run` at all (an older worker, or a legacy job from
 * before run ids existed) groups alone, keyed by its own `jobId` — "+ New
 * job"/"Run again" submissions each mint a fresh run id, so they never
 * collide with an unrelated run.
 */
export interface JobGroup {
  /** `run?.id ?? jobId` of the group's jobs. */
  key: string;
  /** Training jobs first (by `run.index`), then inference jobs (earliest first). */
  jobs: JobSummary[];
  title: string;
  labelsName: string | null;
  /** This project owns (any job in) the run — same rule as `isMineJob`, since a chained inference job always shares its train siblings' project. */
  mine: boolean;
  /** Earliest job's `createdAt`. */
  createdAt: string;
  /** Rolled up across every job in the group — see `rollupGroupStatus`. */
  status: string;
  project: JobSummary["project"];
}

/** running > failed > queued > completed (all of them); otherwise a mix with no running/failed/queued member (e.g. one canceled job alongside a completed sibling) reads as "canceled" — the closest existing chip to "didn't fully succeed". */
function rollupGroupStatus(jobs: JobSummary[]): string {
  if (jobs.some((j) => j.state === "running")) return "running";
  if (jobs.some((j) => j.state === "failed")) return "failed";
  if (jobs.some((j) => j.state === "queued")) return "queued";
  if (jobs.every((j) => j.state === "completed")) return "completed";
  return "canceled";
}

/** "Top-down training run" for a split multi-model train (the only case `count > 1` jobs ever come from); otherwise named for its one train job's model, or "Inference" for a group with no train job at all. */
function groupTitle(jobs: JobSummary[]): string {
  const trainJobs = jobs.filter((j) => j.kind !== "track");
  if (trainJobs.length === 0) return "Inference";
  if (trainJobs.length > 1) return "Top-down training run";
  return `Training run (${trainJobs[0]!.modelTypes[0] ?? "model"})`;
}

/**
 * Groups `jobs` by submission (see `JobGroup`'s doc), sorted the same way
 * `sortWorkerJobs` sorts individual jobs: this project's runs first, then
 * newest (earliest job in the run) first.
 */
export function groupJobs(jobs: JobSummary[], myProjectId: string): JobGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, JobSummary[]>();
  for (const job of jobs) {
    const key = job.run?.id ?? job.jobId;
    const existing = byKey.get(key);
    if (existing) existing.push(job);
    else {
      byKey.set(key, [job]);
      order.push(key);
    }
  }

  const groups = order.map((key): JobGroup => {
    // Training jobs by run.index, then inference/track jobs oldest first.
    const groupedJobs = [...byKey.get(key)!].sort((a, b) => {
      const aTrain = a.kind !== "track";
      const bTrain = b.kind !== "track";
      if (aTrain !== bTrain) return aTrain ? -1 : 1;
      if (aTrain) return (a.run?.index ?? 0) - (b.run?.index ?? 0);
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const earliest = groupedJobs.reduce((min, j) =>
      new Date(j.createdAt).getTime() < new Date(min.createdAt).getTime() ? j : min,
    );
    return {
      key,
      jobs: groupedJobs,
      title: groupTitle(groupedJobs),
      labelsName: basename(groupedJobs.find((j) => j.labelsPath)?.labelsPath),
      mine: groupedJobs.some((j) => isMineJob(j, myProjectId)),
      createdAt: earliest.createdAt,
      status: rollupGroupStatus(groupedJobs),
      project: groupedJobs.find((j) => j.project)?.project,
    };
  });

  return groups.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Case-insensitive substring match against everything a job is findable by
 * in the Jobs tab's search bar: its labels file (full worker path and just
 * the basename, so a bare filename hits even when the full path doesn't),
 * job id, run id, every model type, and the submitting project's name.
 */
export function jobMatches(job: JobSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks: Array<string | undefined> = [
    job.labelsPath,
    basename(job.labelsPath) ?? undefined,
    job.jobId,
    job.run?.id,
    job.project?.name,
    ...job.modelTypes,
  ];
  return haystacks.some((h) => h?.toLowerCase().includes(q));
}

export interface WorkerJobsProps {
  workerId: string;
  /** Display name for this worker — the launcher wizard's title and toasts. Defaults to `workerId` (tests don't need a real label). */
  workerLabel?: string;
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
  kind?: "train" | "track";
  initialView: "monitor" | "logs";
  canStop: boolean;
}

export function WorkerJobs({
  workerId,
  workerLabel,
  pollIntervalMs = DEFAULT_POLL_MS,
  setIntervalImpl = defaultSetInterval,
  clearIntervalImpl = defaultClearInterval,
}: WorkerJobsProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const listJobs = useConnectStore((s) => s.listJobs);
  const jobDetail = useConnectStore((s) => s.jobDetail);
  const cancelJobOn = useConnectStore((s) => s.cancelJobOn);
  const connectToWorker = useConnectStore((s) => s.connectToWorker);
  const trackedJobs = useConnectStore((s) => s.trackedJobs);

  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [mergeTarget, setMergeTarget] = useState<JobSummary | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSeed, setWizardSeed] = useState<NewJobWizardSeed | null>(null);
  const [query, setQuery] = useState("");

  const label = workerLabel ?? workerId;
  const myProjectId = useMemo(() => projectTag(projectPath).id, [projectPath]);
  const groups = useMemo(() => groupJobs(jobs, myProjectId), [jobs, myProjectId]);
  // Grouped BEFORE filtering, then a whole group is kept if any of its jobs
  // match — a query that only hits the chained inference job still surfaces
  // the training run it belongs to, not just that one row.
  const visibleGroups = useMemo(
    () => (query.trim() ? groups.filter((g) => g.jobs.some((j) => jobMatches(j, query))) : groups),
    [groups, query],
  );
  const trackedJobIds = useMemo(
    () => new Set(trackedJobs.filter((j) => j.workerId === workerId).map((j) => j.jobId)),
    [trackedJobs, workerId],
  );

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

  // An inference job has no loss curve to monitor — its viewer opens on logs.
  const openViewer = (job: JobSummary, initialView: "monitor" | "logs") =>
    setViewer({
      jobId: job.jobId,
      label: jobTitle(job),
      kind: job.kind,
      initialView: job.kind === "track" ? "logs" : initialView,
      canStop: isManagedJob(job, myProjectId, trackedJobIds),
    });

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
      if (useConnectStore.getState().selectedWorkerId !== workerId) {
        await connectToWorker(workerId);
      }
      setMergeTarget(job);
    } catch (err) {
      toast.error("Fetch & Load failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRunAgain = async (job: JobSummary) => {
    setBusyJobId(job.jobId);
    try {
      const ids = siblingJobIds(jobs, job);
      const seeded = await seedWizardFromRun(
        jobDetail as (workerId: string, jobId: string) => Promise<JobStatus>,
        workerId,
        ids,
      );
      if (!seeded) {
        toast.error("Couldn't read that job's configuration.");
        return;
      }
      setWizardSeed(seeded);
      setWizardOpen(true);
    } catch (err) {
      toast.error("Couldn't read that job's configuration.", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search labels file, job id, run id, or model"
          className="h-7 text-xs flex-1"
        />
        <Button
          size="xs"
          className="h-7 text-xs shrink-0"
          onClick={() => {
            setWizardSeed(null);
            setWizardOpen(true);
          }}
        >
          + New job
        </Button>
      </div>

      {error && (
        <div className="p-2 text-[11px] text-red-400 bg-red-500/8 border border-red-500/20 rounded-md">
          {error}
        </div>
      )}

      {loading && jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading jobs…</p>
      ) : groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No jobs yet.</p>
      ) : visibleGroups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No jobs match.</p>
      ) : (
        <div className="space-y-2">
          {visibleGroups.map((group) => {
            const groupChip = statusChipFor(group.status);
            return (
              <div
                key={group.key}
                className={`rounded-md border border-border p-2.5 space-y-1.5 ${
                  // Not dimmed with opacity: that greyed out the whole card,
                  // buttons included, so it read as disabled.
                  group.mine ? "bg-zinc-800/50" : "bg-transparent"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {group.mine && <span className="text-orange-400 text-xs shrink-0">★</span>}
                  <div className="min-w-[160px] flex-1">
                    <div className="text-xs font-medium">{group.title}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {group.labelsName ?? "—"}
                      {!group.mine
                        ? ` · ${group.project?.name ? `from ${group.project.name}` : "other project"}`
                        : ""}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${groupChip.className}`}
                  >
                    {groupChip.text}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(group.createdAt)}</span>
                  <span
                    className="text-[9px] font-mono text-muted-foreground shrink-0"
                    title={`Run ${group.key}`}
                  >
                    {group.key.slice(0, 8)}
                  </span>
                </div>

                <div className="space-y-1.5 pl-1 border-l border-border/60">
                  {group.jobs.map((job) => {
                    const managed = isManagedJob(job, myProjectId, trackedJobIds);
                    const chip = jobStatusChip(job);
                    const runTag =
                      job.run && job.run.count > 1 ? `run ${job.run.index + 1}/${job.run.count}` : null;
                    // Other projects' jobs are view-only: watch/view/logs, never cancel.
                    const canWatch = job.state === "running";
                    const canView =
                      job.state === "completed" || job.state === "failed" || job.state === "canceled";
                    const canCancel = managed && (job.state === "queued" || job.state === "running");
                    const canFetch = job.kind === "track" && job.state === "completed";
                    const canRunAgain = managed && job.kind === "train" && job.state === "failed";
                    return (
                      <div key={job.jobId} className="pl-1.5 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] font-medium">
                            {jobTitle(job)}
                            {job.postInference && (
                              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                                → inference
                              </span>
                            )}
                          </span>
                          {runTag && <span className="text-[10px] text-muted-foreground">{runTag}</span>}
                          <span className="text-[9px] font-mono text-muted-foreground" title={job.jobId}>
                            {job.jobId.slice(0, 8)}
                          </span>
                          <span
                            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${chip.className}`}
                          >
                            {chip.text}
                          </span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {timeAgo(job.createdAt)}
                          </span>
                        </div>

                        {job.state === "failed" && job.error && (
                          <pre className="text-[10px] text-red-300 bg-red-950/40 border border-red-900 rounded p-1.5 whitespace-pre-wrap">
                            {job.error.split("\n")[0]}
                          </pre>
                        )}

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
                          {canRunAgain && (
                            <Button
                              size="xs"
                              variant="outline"
                              className="h-6 text-[10px]"
                              disabled={busyJobId === job.jobId}
                              onClick={() => void handleRunAgain(job)}
                            >
                              Run again
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
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewer && (
        <JobViewerDialog
          workerId={workerId}
          jobId={viewer.jobId}
          label={viewer.label}
          initialView={viewer.initialView}
          canStop={viewer.canStop}
          kind={viewer.kind}
          onClose={() => setViewer(null)}
        />
      )}

      {mergeTarget && (
        <MergePredictionsDialog
          workerId={workerId}
          jobId={mergeTarget.jobId}
          mine={isMineJob(mergeTarget, myProjectId)}
          onClose={() => setMergeTarget(null)}
        />
      )}

      {wizardOpen && (
        <NewJobWizard
          workerId={workerId}
          workerLabel={label}
          seed={wizardSeed}
          onClose={() => setWizardOpen(false)}
          onSubmitted={refresh}
        />
      )}
    </div>
  );
}
