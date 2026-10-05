/**
 * Connect window §4b.4 — the Jobs tab: every job on a worker (not just ones
 * this window is tracking), this project's jobs pinned first (★) and live,
 * others dimmed/view-only. Polls `listJobs` every 10 s while mounted (the
 * tab unmounts with the dialog close / tab switch, which stops the poll).
 *
 * PR5b adds "+ New job" (the launcher wizard, design §4.3), "Run again" on a
 * failed train job (re-seeds the wizard from that run's own config), "Run
 * inference" on any completed train run, and widens Fetch & Load to every
 * completed track job (via `MergePredictionsDialog`'s compatibility check,
 * design §6) rather than just this project's own.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/notify";
import { projectTag } from "@/lib/projectTag";
import type { JobSummary, JobStatus } from "@/lib/protocolV1/client";
import type { Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { confirmDialog } from "@/stores/confirmStore";
import { buildPostTrainingInferenceConfig, type ModelType } from "@/stores/trainingStore";
import { loadWorkerLabels } from "@/lib/workerLabels";
import { buildRunInferenceSpecs } from "@/lib/launcherSpec";
import { JobViewerDialog } from "./JobViewerDialog";
import { MergePredictionsDialog } from "./MergePredictionsDialog";
import {
  NewJobWizard,
  seedWizardFromRun,
  WORKER_FILE_INFERENCE_TARGETS,
  type NewJobWizardSeed,
} from "./NewJobWizard";

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
 * resumed watching after a restart). "Run inference" deliberately does NOT
 * use this — it's offered on any completed train run (see `WorkerJobs`'
 * render below), since it operates on that run's own worker-side labels
 * path, not the open project.
 */
export function isManagedJob(job: JobSummary, myProjectId: string, trackedJobIds: Set<string>): boolean {
  return isMineJob(job, myProjectId) || trackedJobIds.has(job.jobId);
}

/**
 * This job's siblings in its training run (`run.id`, in `run.index` order),
 * or just itself if it was never split (`run` absent/`count === 1`) — shared
 * by "Run again" (`seedWizardFromRun`) and "Run inference"
 * (`buildRunInferenceSpecs`'s model dirs), both of which need every model of
 * a split multi-model run, not just the row the user clicked.
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

/** Guesses the pipeline `ModelType` from a train run's own `modelTypes` (head types) — only used to satisfy `buildPostTrainingInferenceConfig`'s signature for the "Run inference" row action, whose `pipeline` field `buildRemoteTrackSpecs` never actually reads; getting this slightly wrong is harmless. */
function guessModelType(headTypes: string[]): ModelType {
  if (headTypes.includes("centroid") || headTypes.includes("centered_instance")) return "top_down";
  switch (headTypes[0]) {
    case "single_instance":
      return "single_animal";
    case "bottomup":
      return "bottom_up";
    case "multi_class_bottomup":
      return "bottom_up_id";
    case "multi_class_topdown":
      return "top_down_id";
    default:
      return "top_down";
  }
}

interface RunInferenceDialogProps {
  workerId: string;
  workerLabel: string;
  triggerJob: JobSummary;
  jobs: JobSummary[];
  onClose: () => void;
}

/** PR5b §5b.3 — the small dialog behind "Run inference" on a completed training run: picks a target (same restricted set the launcher wizard offers) and submits a standalone track job against that run's own models. */
function RunInferenceDialog({ workerId, workerLabel, triggerJob, jobs, onClose }: RunInferenceDialogProps) {
  const jobDetail = useConnectStore((s) => s.jobDetail);
  const clientFor = useConnectStore((s) => s.clientFor);
  const submitJobsOn = useConnectStore((s) => s.submitJobsOn);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelsPath, setLabelsPath] = useState<string | null>(null);
  const [labels, setLabels] = useState<Labels | null>(null);
  const [modelDirs, setModelDirs] = useState<string[]>([]);
  const [target, setTarget] = useState("suggestions");
  const [sampleCount, setSampleCount] = useState(20);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ids = siblingJobIds(jobs, triggerJob);
        const details = await Promise.all(ids.map((id) => jobDetail(workerId, id)));
        const dirs = details
          .map((d) => (d.result as { model_dir?: string } | null)?.model_dir)
          .filter((d): d is string => !!d);
        const path = details[0]?.labelsPath;
        if (!path || dirs.length === 0) {
          if (!cancelled) setError("Couldn't find this run's trained model(s).");
          return;
        }
        const client = await clientFor(workerId);
        const loaded = await loadWorkerLabels(client, path);
        if (cancelled) return;
        setLabelsPath(path);
        setModelDirs(dirs);
        setLabels(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, triggerJob.jobId]);

  const handleSubmit = async () => {
    if (!labels || !labelsPath || modelDirs.length === 0) return;
    setSubmitting(true);
    try {
      const config = buildPostTrainingInferenceConfig({
        modelType: guessModelType(triggerJob.modelTypes),
        modelPaths: modelDirs,
        inferenceTarget: target,
        videoIndex: "all",
        sampleCount,
      });
      const specs = buildRunInferenceSpecs(labelsPath, modelDirs, config, labels);
      for (const spec of specs) {
        await submitJobsOn(workerId, spec, { source: "worker-file" });
      }
      toast.success(`Added to ${workerLabel} queue`, {
        description: `Inference on ${basename(labelsPath) ?? labelsPath}`,
      });
      onClose();
    } catch (err) {
      toast.error("Couldn't submit inference job", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-sm">Run inference</DialogTitle>
        </DialogHeader>
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {!loading && !error && (
          <>
            <p className="text-xs text-muted-foreground font-mono truncate">{labelsPath}</p>
            <div className="flex items-center gap-2">
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="h-8 text-xs flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKER_FILE_INFERENCE_TARGETS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {target === "random" && (
                <Input
                  type="number"
                  min={1}
                  value={sampleCount}
                  onChange={(e) => setSampleCount(Math.max(1, Number(e.target.value)))}
                  className="h-8 text-xs w-20"
                />
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={submitting} onClick={() => void handleSubmit()}>
                {submitting ? "Adding…" : "Add to queue"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
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
  const [runInferenceTarget, setRunInferenceTarget] = useState<JobSummary | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSeed, setWizardSeed] = useState<NewJobWizardSeed | null>(null);

  const label = workerLabel ?? workerId;
  const myProjectId = useMemo(() => projectTag(projectPath).id, [projectPath]);
  const sorted = useMemo(() => sortWorkerJobs(jobs, myProjectId), [jobs, myProjectId]);
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
      <div className="flex justify-end">
        <Button
          size="xs"
          className="h-7 text-xs"
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
      ) : sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">No jobs yet.</p>
      ) : (
        <div className="space-y-2">
          {sorted.map((job) => {
            const mine = isMineJob(job, myProjectId);
            const managed = isManagedJob(job, myProjectId, trackedJobIds);
            const chip = jobStatusChip(job);
            const labelsName = basename(job.labelsPath);
            const runTag = job.run && job.run.count > 1 ? `run ${job.run.index + 1}/${job.run.count}` : null;
            // Other projects' jobs are view-only: watch/view/logs, never cancel.
            const canWatch = job.state === "running";
            const canView = job.state === "completed" || job.state === "failed" || job.state === "canceled";
            const canCancel = managed && (job.state === "queued" || job.state === "running");
            const canFetch = job.kind === "track" && job.state === "completed";
            const canRunAgain = managed && job.kind === "train" && job.state === "failed";
            const canRunInference = job.kind === "train" && job.state === "completed";
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
                    <div className="text-xs font-medium">
                      {jobTitle(job)}
                      {job.postInference && (
                        <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">→ inference</span>
                      )}
                    </div>
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
                  {canRunInference && (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 text-[10px]"
                      onClick={() => setRunInferenceTarget(job)}
                    >
                      Run inference
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
      )}

      {viewer && (
        <JobViewerDialog
          workerId={workerId}
          jobId={viewer.jobId}
          label={viewer.label}
          initialView={viewer.initialView}
          canStop={viewer.canStop}
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

      {runInferenceTarget && (
        <RunInferenceDialog
          workerId={workerId}
          workerLabel={label}
          triggerJob={runInferenceTarget}
          jobs={jobs}
          onClose={() => setRunInferenceTarget(null)}
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
