/**
 * Check Frames dialog: run the full frame check on one video, show what the
 * quick and full checks found, and offer to re-encode it into a clean MP4 and
 * switch the project to it. Re-encoding is also offered when the check itself
 * fails, and for a video the app can't open at all (desktop ffmpeg reads codecs
 * the app can't). Opened from the Videos panel, the player's unsupported-codec
 * message, or the toast the quick check raises; driven by
 * {@link useVideoCheckStore}. See `lib/videoCheck.ts` for what each check means.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppStore } from "@/stores/appStore";
import { useVideoCheckStore } from "@/stores/videoCheckStore";
import { toast } from "@/lib/notify";
import { getPlatform, isTauri } from "@/platform/index";
import { videoBasename } from "@/lib/videoFilter";
import { buildStandaloneVideo, getBasename, videoIssue } from "@/lib/resolveVideos";
import { applyVideoReplacement } from "@/lib/replaceVideo";
import {
  decodeAllNative,
  frameCheckUnavailable,
  openFrameReader,
  readerKindOf,
  reencodeUnavailable,
} from "@/lib/videoCheckRuntime";
import {
  DEFAULT_SEEK_SAMPLES,
  clearedResult,
  decideReencodeSwap,
  formatFrameRanges,
  frameCheckPassed,
  labelShiftWarning,
  nativeDecodeClears,
  reencodeCommand,
  reencodedPath,
  runFrameCheck,
  type ReencodeQuality,
  type FrameCheckResult,
  type SwapDecision,
} from "@/lib/videoCheck";
import type { Video } from "@/types";

type Phase =
  | { kind: "idle" }
  | { kind: "checking"; label: string; percent: number }
  | { kind: "reencoding"; percent: number | null }
  | { kind: "swap"; newVideo: Video; decision: SwapDecision; warning: string | null }
  | { kind: "error"; message: string };

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function videoPath(video: Video): string {
  return Array.isArray(video.filename) ? video.filename[0] : video.filename;
}

export function VideoCheckDialog() {
  const video = useVideoCheckStore((s) => s.dialogVideo);
  const closeDialog = useVideoCheckStore((s) => s.closeDialog);
  const entry = useVideoCheckStore((s) => (video ? s.results.get(video) : undefined));
  const setFull = useVideoCheckStore((s) => s.setFull);
  const labels = useAppStore((s) => s.labels);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [canEncode, setCanEncode] = useState<boolean>(isTauri);
  // The full check threw (couldn't open or read the video): offer the fix too.
  const [checkFailed, setCheckFailed] = useState(false);
  const [quality, setQuality] = useState<ReencodeQuality>("medium");
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    setPhase({ kind: "idle" });
    setCheckFailed(false);
    if (!video || isTauri) return;
    let live = true;
    void import("@/lib/videoReencode")
      .then((m) => m.canReencodeInBrowser(video))
      .then((ok) => live && setCanEncode(ok));
    return () => {
      live = false;
    };
  }, [video]);

  if (!video) return null;

  const busy = phase.kind === "checking" || phase.kind === "reencoding";
  const unavailable = frameCheckUnavailable(video);
  const full = entry?.full ?? null;
  const quick = entry?.quick ?? null;
  // "Check frames to confirm" is moot once the full check has run.
  const findings = (quick?.findings ?? []).filter((f) => !(full && f.code === "time-seek"));
  const labeledCount = labels ? labels.find({ video }).length : 0;
  const unopenable = videoIssue(video) === "unsupported-codec";
  const needsFix =
    (full && !frameCheckPassed(full)) || quick?.status === "warn" || unopenable || checkFailed;
  const reencodeBlocked = reencodeUnavailable(video);
  // Desktop re-encodes with ffmpeg; the browser needs WebCodecs and a reader
  // that can open the video, which a failed check says it can't.
  const reencodeHere = !reencodeBlocked && (isTauri || (canEncode && !checkFailed));

  const close = () => {
    controller.current?.abort();
    if (phase.kind === "swap") phase.newVideo.backend?.close();
    closeDialog();
  };

  const runCheck = async () => {
    const ac = new AbortController();
    controller.current = ac;
    setPhase({ kind: "checking", label: "Opening the video…", percent: 0 });
    setCheckFailed(false);
    try {
      // Desktop MP4: decode every frame natively first. A clean pass settles
      // it; anything else goes on to the app's reader for exact frame numbers.
      const kind = readerKindOf(video);
      const appFrames = video.shape?.[0] ?? 0;
      if (isTauri && kind === "mp4box" && appFrames > 0) {
        const native = await decodeAllNative(video, {
          signal: ac.signal,
          onProgress: (decoded) =>
            setPhase({
              kind: "checking",
              label: `Decoding every frame: ${decoded.toLocaleString()} of ${appFrames.toLocaleString()}`,
              percent: Math.min(100, (decoded / appFrames) * 100),
            }),
        });
        if (nativeDecodeClears(kind, appFrames, native)) {
          setFull(video, clearedResult(appFrames));
          setPhase({ kind: "idle" });
          return;
        }
      }
      const result = await runFrameCheck({
        openReader: () => openFrameReader(video),
        signal: ac.signal,
        onProgress: (p) =>
          setPhase({
            kind: "checking",
            label:
              p.phase === "read"
                ? `Reading every frame: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`
                : `Jumping to frames: ${p.done} of ${p.total}`,
            // The in-order pass is nearly all the work.
            percent: p.phase === "read" ? (p.done / p.total) * 95 : 95 + (p.done / p.total) * 5,
          }),
      });
      setFull(video, result);
      setPhase({ kind: "idle" });
    } catch (err) {
      if (!isAbort(err)) setCheckFailed(true);
      setPhase(
        isAbort(err)
          ? { kind: "idle" }
          : { kind: "error", message: err instanceof Error ? err.message : String(err) }
      );
    } finally {
      controller.current = null;
    }
  };

  const runReencode = async () => {
    const grayscale = video.backendMetadata.grayscale as boolean | undefined;
    const ac = new AbortController();
    controller.current = ac;
    try {
      const reencode = await import("@/lib/videoReencode");
      let newVideo: Video | null;
      if (isTauri) {
        const platform = await getPlatform();
        const dest = await platform.showSaveDialog({
          defaultName: reencodedPath(videoPath(video)),
          filters: [{ name: "MP4 video", extensions: ["mp4"] }],
        });
        if (!dest) return;
        if (dest === videoPath(video)) {
          setPhase({ kind: "error", message: "Choose a different file than the original." });
          return;
        }
        setPhase({ kind: "reencoding", percent: null });
        await reencode.reencodeWithFfmpeg(
          videoPath(video),
          dest,
          {
            fps: video.fps,
            width: video.shape?.[2],
            height: video.shape?.[1],
            frameCount: video.shape?.[0],
          },
          {
            quality,
            signal: ac.signal,
            onProgress: (percent) => setPhase({ kind: "reencoding", percent }),
          }
        );
        newVideo = await buildStandaloneVideo(new File([], getBasename(dest)), dest, grayscale);
      } else {
        setPhase({ kind: "reencoding", percent: 0 });
        const out = await reencode.reencodeInBrowser(video, {
          quality,
          signal: ac.signal,
          onProgress: (percent) => setPhase({ kind: "reencoding", percent }),
        });
        if (!out) {
          setPhase({ kind: "idle" });
          return;
        }
        if (out.blankFrames > 0) {
          toast.warning(
            `${out.blankFrames.toLocaleString()} frame${out.blankFrames === 1 ? "" : "s"} couldn't be read and were saved black`
          );
        }
        newVideo = await buildStandaloneVideo(out.file, null, grayscale);
      }
      if (!newVideo) {
        setPhase({ kind: "error", message: "The re-encoded video couldn't be opened." });
        return;
      }
      setPhase({
        kind: "swap",
        newVideo,
        decision: decideReencodeSwap({
          // A video that never opened here may still carry its stored shape.
          oldCount: video.shape?.[0] ?? null,
          newCount: newVideo.shape?.[0] ?? 0,
          labeledCount,
        }),
        warning: labelShiftWarning(labeledCount, !!needsFix),
      });
    } catch (err) {
      setPhase(
        isAbort(err)
          ? { kind: "idle" }
          : { kind: "error", message: err instanceof Error ? err.message : String(err) }
      );
    } finally {
      controller.current = null;
    }
  };

  const switchToReencoded = (newVideo: Video) => {
    if (!labels) return;
    const app = useAppStore.getState();
    const wasCurrent = app.video === video;
    applyVideoReplacement(labels, video, newVideo);
    if (wasCurrent) {
      app.setVideo(newVideo);
      app.setFrameIdx(Math.min(app.frameIdx, (newVideo.shape?.[0] ?? 1) - 1));
    }
    app.markChanged();
    app.bumpOverlayVersion();
    toast.success(`Switched to ${videoBasename(newVideo.filename)}`);
    closeDialog();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="sm:max-w-lg"
        onPointerDownOutside={(e) => busy && e.preventDefault()}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Check frames</DialogTitle>
          <DialogDescription className="break-all">{videoBasename(video.filename)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          {findings.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {findings.map((f) => (
                <li key={f.code} className="flex gap-2 text-xs">
                  {f.severity === "warn" ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500 mt-0.5" />
                  ) : (
                    <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                  )}
                  <span>{f.message}</span>
                </li>
              ))}
            </ul>
          )}

          {phase.kind === "checking" && (
            <div className="flex flex-col gap-2">
              <Progress value={phase.percent} />
              <p className="text-xs text-muted-foreground">{phase.label}</p>
            </div>
          )}

          {phase.kind === "idle" && !full && (
            <p className="text-xs text-muted-foreground">
              {unavailable ??
                `Reads every frame, then jumps straight to ${DEFAULT_SEEK_SAMPLES} frames and checks ` +
                  "each shows the same image. Long videos can take a few minutes."}
            </p>
          )}

          {phase.kind !== "checking" && full && <FullResult result={full} />}

          {phase.kind === "reencoding" && (
            <div className="flex flex-col gap-2">
              <Progress
                value={phase.percent ?? 0}
                className={phase.percent === null ? "animate-pulse" : ""}
              />
              <p className="text-xs text-muted-foreground">
                Re-encoding{phase.percent !== null ? `: ${Math.round(phase.percent)}%` : "…"}
              </p>
            </div>
          )}

          {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}

          {(phase.kind === "idle" || phase.kind === "error") && needsFix && (
            <ReencodeHint
              video={video}
              reencodeHere={reencodeHere}
              quality={quality}
              onQualityChange={setQuality}
            />
          )}

          {phase.kind === "swap" &&
            (phase.decision.ok ? (
              <div className="flex flex-col gap-2 text-xs">
                <p>
                  Saved <span className="font-medium">{videoBasename(phase.newVideo.filename)}</span>. Switch
                  this project to it? The original file is left as it is.
                </p>
                {phase.decision.note && <p className="text-muted-foreground">{phase.decision.note}</p>}
                {phase.warning && (
                  <p className="flex gap-2 text-orange-600 dark:text-orange-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    {phase.warning}
                  </p>
                )}
              </div>
            ) : (
              <p className="flex gap-2 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500 mt-0.5" />
                {phase.decision.reason}
              </p>
            ))}

        </div>

        <DialogFooter>
          {busy ? (
            <Button variant="outline" size="sm" onClick={() => controller.current?.abort()}>
              Cancel
            </Button>
          ) : phase.kind === "swap" ? (
            phase.decision.ok ? (
              <>
                <Button variant="outline" size="sm" onClick={close}>
                  Keep original
                </Button>
                <Button size="sm" onClick={() => switchToReencoded(phase.newVideo)}>
                  Use re-encoded video
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={close}>
                Close
              </Button>
            )
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={close}>
                Close
              </Button>
              {needsFix && reencodeHere && (
                <Button variant={unopenable ? "default" : "outline"} size="sm" onClick={runReencode}>
                  Re-encode…
                </Button>
              )}
              {!unopenable && (
                <Button size="sm" onClick={runCheck} disabled={!!unavailable}>
                  {full || checkFailed ? "Check again" : "Check frames"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FullResult({ result }: { result: FrameCheckResult }) {
  if (frameCheckPassed(result)) {
    return (
      <p className="flex gap-2 text-xs">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 mt-0.5" />
        {result.seekTested > 0
          ? `All ${result.frameCount.toLocaleString()} frames read, and the ${result.seekTested} frames jumped to showed the same image.`
          : `All ${result.frameCount.toLocaleString()} frames read.`}
      </p>
    );
  }
  const readOk = result.frameCount - result.unreadable.length;
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {result.unreadable.length > 0 && (
        <li className="flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500 mt-0.5" />
          <span>
            {readOk.toLocaleString()} of {result.frameCount.toLocaleString()} frames read.{" "}
            Couldn&apos;t read frames {formatFrameRanges(result.unreadable)}.
          </span>
        </li>
      )}
      {result.seekMismatches.length > 0 && (
        <li className="flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500 mt-0.5" />
          <span>
            {result.seekMismatches.length} of {result.seekTested} frames showed a different image when jumped
            to directly ({formatFrameRanges(result.seekMismatches)}). Labels on frames like these can end up
            on the wrong image.
          </span>
        </li>
      )}
      {result.seekUnreadable.length > 0 && (
        <li className="flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500 mt-0.5" />
          <span>
            {result.seekUnreadable.length === 1 ? "Frame" : "Frames"}{" "}
            {formatFrameRanges(result.seekUnreadable)} read in order but not when jumped to.
          </span>
        </li>
      )}
    </ul>
  );
}

const QUALITY_LABELS: Record<ReencodeQuality, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function ReencodeHint({
  video,
  reencodeHere,
  quality,
  onQualityChange,
}: {
  video: Video;
  reencodeHere: boolean;
  quality: ReencodeQuality;
  onQualityChange: (q: ReencodeQuality) => void;
}) {
  const out = reencodedPath(videoBasename(video.filename));
  const picker = (
    <div className="flex items-center gap-1.5">
      <span>Quality:</span>
      {(Object.keys(QUALITY_LABELS) as ReencodeQuality[]).map((q) => (
        <Button
          key={q}
          size="xs"
          variant={q === quality ? "secondary" : "ghost"}
          aria-pressed={q === quality}
          onClick={() => onQualityChange(q)}
        >
          {QUALITY_LABELS[q]}
        </Button>
      ))}
    </div>
  );
  if (reencodeHere) {
    return (
      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <p>
          Re-encoding writes a clean copy ({out}) that reads every frame reliably, then offers to switch the
          project to it.
        </p>
        {picker}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p>
        Re-encoding isn&apos;t available in this browser for this video. Re-encode it with ffmpeg, then use
        Replace Video:
      </p>
      {picker}
      <code className="rounded bg-muted px-1.5 py-1 break-all select-all">
        {reencodeCommand(videoBasename(video.filename), out, video.fps, quality)}
      </code>
    </div>
  );
}
