/**
 * PR5b §5b.4 — Fetch & Load's compatibility dialog (design §6) for a
 * completed track job's predictions: loads them (`loadRemotePredictions`),
 * runs the compatibility check (`checkMergeCompat`), and offers Merge
 * matching / Open predictions / Download .slp. A job that's unambiguously
 * "ours" (this project, every video matches, skeleton compatible) skips
 * this UI entirely and merges right away — see {@link shouldAutoMerge} —
 * matching the pre-PR5b "mine" fast path, now generalized to every
 * completed track job rather than just this project's own.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { saveSlpToBytes, type Labels } from "@talmolab/sleap-io.js";
import type { JobResult, JobResultBlobRef } from "@/lib/sleapConnect";
import { toast } from "@/lib/notify";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore, pathRulesFor } from "@/stores/connectStore";
import { loadRemotePredictions } from "@/stores/inferenceStore";
import {
  checkMergeCompat,
  filterPredictionsToMatchedVideos,
  translatePathToLocal,
  type MergeCompat,
} from "@/lib/mergeCompat";
import { saveBytesFile } from "@/commands/fileCommands";
import { commandContext } from "@/commands";
import { MergePredictions } from "@/commands/editCommands";
import { confirmDiscardUnsavedWork } from "@/lib/unsavedGuard";
import { resolveExternalVideos } from "@/lib/resolveVideos";

/** Last path segment of a worker path (handles both `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** A "mine" job whose predictions fully match the open project needs no dialog at all (design §6) — the pre-PR5b behavior for a project's own job. */
function shouldAutoMerge(mine: boolean, compat: MergeCompat): boolean {
  return mine && compat.skeletonOk && compat.total > 0 && compat.matchedCount === compat.total;
}

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; predictions: Labels; compat: MergeCompat; jobLabelsPath: string | null }
  | { kind: "merging" };

export interface MergePredictionsDialogProps {
  workerId: string;
  jobId: string;
  /** This row's own "mine" check (open project id match) — see `WorkerJobs`' `isMineJob`. */
  mine: boolean;
  onClose: () => void;
}

export function MergePredictionsDialog({ workerId, jobId, mine, onClose }: MergePredictionsDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const jobDetail = useConnectStore((s) => s.jobDetail);
  const projectPath = useAppStore((s) => s.projectPath);
  const projectLabels = useAppStore((s) => s.labels);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await jobDetail(workerId, jobId);
        const resultData = detail.result as { blobs?: Record<string, JobResultBlobRef> } | null;
        const predictionsRef = resultData?.blobs?.predictions;
        if (!predictionsRef) {
          if (!cancelled) setStage({ kind: "error", message: "No predictions were found for this job." });
          return;
        }
        const jobResult: JobResult = { jobId, success: true, resultBlobs: { predictions: predictionsRef } };
        const predictions = await loadRemotePredictions(jobResult);
        if (!predictions) {
          if (!cancelled) setStage({ kind: "error", message: "No predictions were found for this job." });
          return;
        }
        const jobLabelsPath = detail.labelsPath ?? null;
        const compat = await checkMergeCompat(projectLabels, predictions, {
          projectPath,
          jobLabelsPath,
          rules: pathRulesFor(workerId),
        });
        if (cancelled) return;

        if (shouldAutoMerge(mine, compat) && projectLabels) {
          setStage({ kind: "merging" });
          await commandContext.execute(MergePredictions, { predictions, mode: "replace" });
          toast.success("Loaded. Predictions merged into the project.");
          onClose();
          return;
        }
        setStage({ kind: "ready", predictions, compat, jobLabelsPath });
      } catch (err) {
        if (!cancelled) {
          setStage({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, jobId]);

  const handleMergeMatching = async () => {
    if (stage.kind !== "ready" || !projectLabels) return;
    const { predictions, compat } = stage;
    setStage({ kind: "merging" });
    try {
      const filtered = filterPredictionsToMatchedVideos(predictions, projectLabels);
      await commandContext.execute(MergePredictions, { predictions: filtered, mode: "replace" });
      toast.success(`Loaded. Merged ${compat.matchedCount}/${compat.total} video(s).`);
      onClose();
    } catch (err) {
      toast.error("Merge failed", { description: err instanceof Error ? err.message : String(err) });
      setStage({ kind: "ready", predictions, compat, jobLabelsPath: stage.jobLabelsPath });
    }
  };

  const handleOpenPredictions = async () => {
    if (stage.kind !== "ready") return;
    if (!(await confirmDiscardUnsavedWork("Opening predictions"))) return;
    const rules = pathRulesFor(workerId);
    for (const video of stage.predictions.videos) {
      if (typeof video.filename !== "string") continue;
      const local = translatePathToLocal(video.filename, rules);
      if (local) video.filename = local;
    }
    await resolveExternalVideos(stage.predictions);
    useAppStore.getState().setLabels(stage.predictions, `${jobId}.predictions.slp`);
    toast.success("Opened predictions as a new, unsaved project.");
    onClose();
  };

  const handleDownload = async () => {
    if (stage.kind !== "ready") return;
    const bytes = await saveSlpToBytes(stage.predictions);
    await saveBytesFile(bytes, `${jobId}.predictions.slp`, { name: "SLEAP Labels", ext: "slp" });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-sm">Load predictions</DialogTitle>
          {stage.kind === "ready" && (
            <DialogDescription className="text-xs">
              From inference on{" "}
              <span className="font-mono text-foreground">{stage.jobLabelsPath ?? "this job"}</span>
            </DialogDescription>
          )}
        </DialogHeader>

        {stage.kind === "loading" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading predictions…
          </div>
        )}
        {stage.kind === "merging" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Merging…
          </div>
        )}
        {stage.kind === "error" && <p className="text-xs text-red-400">{stage.message}</p>}

        {stage.kind === "ready" && (
          <>
            <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
              <span>
                {projectLabels
                  ? `Open project: ${projectPath ? basename(projectPath) : "untitled.slp"}`
                  : "No project open"}
              </span>
              <span className="flex items-center gap-1.5">
                <span className={stage.compat.skeletonOk ? "text-green-400" : "text-yellow-400"}>
                  {stage.compat.skeletonOk ? "✓" : "!"}
                </span>
                {stage.compat.skeletonDetail}
              </span>
              {stage.compat.videos.map((v) => (
                <span key={v.name} className="flex items-center gap-1.5">
                  <span className={v.matched ? "text-green-400" : "text-yellow-400"}>{v.matched ? "✓" : "!"}</span>
                  {v.name}
                  {v.matched ? " matches" : " isn't in this project"}
                </span>
              ))}
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={!projectLabels || stage.compat.matchedCount === 0 || !stage.compat.skeletonOk}
                title={
                  !projectLabels
                    ? "No project open"
                    : !stage.compat.skeletonOk
                      ? stage.compat.skeletonDetail
                      : undefined
                }
                onClick={() => void handleMergeMatching()}
              >
                Merge matching ({stage.compat.matchedCount}/{stage.compat.total} video
                {stage.compat.total === 1 ? "" : "s"})
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleOpenPredictions()}>
                Open predictions
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleDownload()}>
                Download .slp
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
