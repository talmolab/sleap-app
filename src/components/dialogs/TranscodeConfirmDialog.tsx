/**
 * Asks the user to opt in before a legacy-codec video (Xvid/WMV/MPEG-1-2/…) is
 * transcoded on the desktop. Wording is deliberate: the conversion produces a
 * TEMPORARY, cached H.264 copy purely so the app can display/label the video —
 * the original file and the `.slp` project are NOT modified. Driven by
 * {@link useTranscodePromptStore}; visible whenever a prompt is pending.
 *
 * Separate from {@link TranscodeProgressDialog}, which shows conversion PROGRESS
 * after the user accepts here.
 */

import { useTranscodePromptStore } from "@/stores/transcodePromptStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** ffmpeg `codec_name` → a name a user recognizes. */
const CODEC_LABELS: Record<string, string> = {
  mpeg4: "MPEG-4 / Xvid",
  msmpeg4v1: "MS-MPEG-4",
  msmpeg4v2: "MS-MPEG-4",
  msmpeg4v3: "MS-MPEG-4 / DivX",
  wmv1: "WMV",
  wmv2: "WMV",
  wmv3: "WMV",
  vc1: "VC-1",
  mpeg1video: "MPEG-1",
  mpeg2video: "MPEG-2",
};

function friendlyCodec(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

export function TranscodeConfirmDialog() {
  const pending = useTranscodePromptStore((s) => s.pending);
  const respond = useTranscodePromptStore((s) => s.respond);

  return (
    <Dialog open={pending !== null}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Convert legacy video to view it?</DialogTitle>
          <DialogDescription>
            This format can’t be played directly in the app.
          </DialogDescription>
        </DialogHeader>
        {pending && (
          <div className="flex flex-col gap-3">
            <p className="truncate text-sm font-medium" title={pending.name}>
              {pending.name}
            </p>
            <p className="text-muted-foreground text-sm">
              <span className="font-medium">{friendlyCodec(pending.codec)}</span>{" "}
              isn’t supported by the app’s video player. SLEAP can make a{" "}
              <span className="font-medium">temporary H.264 copy</span> so you can
              view and label it here. Your original file and project (<code>.slp</code>)
              are not changed, and the copy is cached — reopening is instant, and you
              can clear it anytime from <em>File → Clear Video Transcode Cache</em>.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => respond(false)}>
                Skip
              </Button>
              <Button size="sm" onClick={() => respond(true)}>
                Convert (temporary)
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
