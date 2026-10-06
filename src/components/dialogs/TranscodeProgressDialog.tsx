/**
 * Modal shown while a legacy-codec video is being transcoded to H.264 on the
 * desktop (Xvid/WMV/MPEG → MP4). Driven entirely by {@link useTranscodeStore}:
 * visible whenever a job is active, with a live progress bar (or an
 * indeterminate pulse when the source duration is unknown) and a Cancel button.
 * Non-dismissable except via Cancel — closing it would orphan the running
 * ffmpeg child.
 */

import { useTranscodeStore } from "@/stores/transcodeStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";

export function TranscodeProgressDialog() {
  const job = useTranscodeStore((s) => s.job);
  const requestCancel = useTranscodeStore((s) => s.requestCancel);

  return (
    <Dialog open={job !== null}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Converting video…</DialogTitle>
        </DialogHeader>
        {job && (
          <div className="flex flex-col gap-3">
            <p className="truncate text-sm font-medium" title={job.name}>
              {job.name}
            </p>
            <Progress
              value={job.percent ?? 0}
              className={job.percent === null ? "animate-pulse" : ""}
            />
            <p className="text-muted-foreground text-xs">
              {job.percent !== null
                ? `${Math.round(job.percent)}%`
                : job.frame !== null
                  ? `frame ${job.frame}`
                  : "Preparing…"}
              {" · this legacy format is converted once, then cached."}
            </p>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={requestCancel}
                disabled={job.canceling}
              >
                {job.canceling ? "Canceling…" : "Cancel"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
