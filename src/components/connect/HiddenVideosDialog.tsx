/**
 * Pre-submit dialog for a "this window" remote training run when one or more
 * videos aren't visible on the worker (PR3b
 * docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3b.3). TrainingPanel
 * skips this entirely when every video is visible (visibility case "all").
 *
 * "Train" embeds only the hidden videos' LABELED frames (what
 * buildRemoteLabelsPayload always does for a hidden video with a backend —
 * see remoteLabelsPayload.ts). "Also embed ... to predict" additionally
 * embeds their SUGGESTED frames, so post-training inference (when its target
 * is "Suggested frames") can cover a hidden video too, at the cost of a
 * larger upload.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { describeVisibilityOutcome } from "@/components/connect/RemoteDataSummary";
import type { VideoVisibility } from "@/lib/remoteVisibility";
import type { Labels } from "@/types";

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export interface HiddenVideosDialogProps {
  open: boolean;
  /** Closes the dialog without starting training (Cancel and Locate on worker… both just close it — the per-video Locate buttons live in RemoteDataSummary, always visible underneath). */
  onClose: () => void;
  labels: Labels;
  visibility: VideoVisibility[];
  inferenceTarget: string;
  onTrain: (opts: { embedFramesToPredict: boolean }) => void;
}

export function HiddenVideosDialog({
  open,
  onClose,
  labels,
  visibility,
  inferenceTarget,
  onTrain,
}: HiddenVideosDialogProps) {
  const hidden = visibility.filter((v) => !v.visible);
  const hiddenIndices = new Set(hidden.map((v) => v.index));

  const labeledCount = (videoIndex: number) =>
    labels.labeledFrames.filter((lf) => lf.video === labels.videos[videoIndex]).length;

  const hiddenSuggestionCount = labels.suggestions.filter((s) =>
    hiddenIndices.has(labels.videos.indexOf(s.video)),
  ).length;
  const canEmbedForPredict = inferenceTarget === "suggestions" && hiddenSuggestionCount > 0;

  const train = (embedFramesToPredict: boolean) => {
    onTrain({ embedFramesToPredict });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Some videos aren&apos;t visible on the worker</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Their labeled frames will be embedded in the upload so training still has
          pixels to learn from. The original videos stay local.
        </p>

        <div className="space-y-1 max-h-40 overflow-y-auto">
          {hidden.map((v) => {
            const n = labeledCount(v.index);
            return (
              <div key={v.index} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono">{basename(v.local)}</span>
                <span className="text-muted-foreground shrink-0">
                  {n} frame{n === 1 ? "" : "s"}
                </span>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">{describeVisibilityOutcome(visibility)}</p>

        <div className="flex flex-col gap-2">
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => train(false)}>Train</Button>
          </div>
          <Button
            variant="outline"
            className="w-full"
            disabled={!canEmbedForPredict}
            onClick={() => train(true)}
          >
            Also embed {hiddenSuggestionCount} suggested frame{hiddenSuggestionCount === 1 ? "" : "s"} to predict
          </Button>
          <Button variant="link" className="h-auto p-0 text-xs justify-start" onClick={onClose}>
            Locate on worker…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
