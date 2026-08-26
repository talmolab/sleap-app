/**
 * Export Clips dialog — batch export manager.
 *
 * Lists the project's videos with a per-video include checkbox and per-video
 * range/fps/scale/background, a scrubbable WYSIWYG preview of the focused video,
 * and encodes each to an H.264 mp4 (skeleton overlay burned in; PyQt parity).
 * Every setting is per-video; overlay appearance follows the current View
 * settings. Export runs SEQUENTIALLY (one encoder at a time) with per-video
 * progress, failure-isolation, and a single Cancel. Desktop writes every clip
 * into one chosen destination folder; the browser downloads them per file.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import {
  saveBytesFile,
  saveBytesToDir,
  pickClipDestination,
} from "../../commands/fileCommands";
import { toast } from "@/lib/notify";
import type { LabeledFrame, Video } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { hasAssignedTracks } from "@/lib/colorPalettes";
import {
  resolveClipFrameRange,
  computeClipOutputDimensions,
  deriveClipFilename,
  evaluateClipEncodeSupport,
  buildExportRenderedInstances,
  runClipExport,
  runClipExportBatch,
  clampClipScale,
  clipBackgroundColor,
  buildInitialClipConfigs,
  clipExportReducer,
  type ClipConfig,
} from "@/lib/videoExport";
import { ClipPreview } from "./ClipPreview";
import { ClipVideoList, type ClipJobInfo } from "./ClipVideoList";
import { ClipSettings } from "./ClipSettings";

type Phase = "form" | "checking" | "unsupported" | "encoding";

/** Ensure a video's dimensions are known (probe getFrame(0) once). */
async function ensureProbed(video: Video): Promise<void> {
  const shape = video.shape;
  if ((!shape || !shape[1] || !shape[2]) && video.backend) {
    try {
      await video.backend.getFrame(0);
      if (video.backend.shape) video.shape = video.backend.shape;
    } catch {
      // Dimensions stay unavailable; the preview shows its fallback.
    }
  }
}

/** Basename for a video's filename (ImageVideo filenames are string[]). */
function videoLabel(video: Video): string {
  const f = Array.isArray(video.filename) ? (video.filename[0] ?? "") : video.filename;
  const parts = String(f).split(/[\\/]/);
  return parts[parts.length - 1] || "video";
}

export function ExportClipDialog() {
  const open = useAppStore((s) => s.exportClipDialogOpen);
  const setOpen = useAppStore((s) => s.setExportClipDialogOpen);
  const video = useAppStore((s) => s.video);
  const labels = useAppStore((s) => s.labels);
  const filename = useAppStore((s) => s.filename);

  // View settings that shape the overlay (captured at export time).
  const palette = useAppStore((s) => s.palette);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const colorPredicted = useAppStore((s) => s.colorPredicted);
  const showNonVisibleNodes = useAppStore((s) => s.showNonVisibleNodes);
  const showInstances = useAppStore((s) => s.showInstances);
  const showLabels = useAppStore((s) => s.showLabels);
  const showEdges = useAppStore((s) => s.showEdges);
  const markerSize = useAppStore((s) => s.markerSize);
  const nodeLabelSize = useAppStore((s) => s.nodeLabelSize);
  const edgeStyle = useAppStore((s) => s.edgeStyle);

  const [state, dispatch] = useReducer(clipExportReducer, { configs: [], focused: null });
  const [phase, setPhase] = useState<Phase>("checking");
  const [supportMessage, setSupportMessage] = useState("");
  const [jobs, setJobs] = useState<Map<Video, ClipJobInfo>>(new Map());
  // Bumped after a focused video is probed, to re-render the preview with dims.
  const [, bumpProbe] = useReducer((n: number) => n + 1, 0);
  const abortRef = useRef<AbortController | null>(null);

  const focused = state.focused;
  const focusedConfig = state.configs.find((c) => c.video === focused) ?? null;
  const focusedIndex = state.configs.findIndex((c) => c.video === focused);

  // Seed configs + run the capability probe each time the dialog opens.
  useEffect(() => {
    if (!open || !labels || !video) return;
    setPhase("checking");
    setSupportMessage("");
    setJobs(new Map());
    dispatch({
      type: "reset",
      state: buildInitialClipConfigs(
        labels.videos ?? [],
        video,
        useAppStore.getState().frameRange
      ),
    });

    let cancelled = false;
    (async () => {
      await ensureProbed(video);
      if (cancelled) return;
      const srcW = video.shape?.[2] ?? 0;
      const srcH = video.shape?.[1] ?? 0;
      if (!srcW || !srcH) {
        setPhase("unsupported");
        setSupportMessage(
          "Video dimensions aren't available yet. Reopen the video (or wait for it to finish loading), then try exporting again."
        );
        return;
      }
      const dims = computeClipOutputDimensions(srcW, srcH, 1);
      // Lazy-load the mediabunny-backed pipeline so its WebCodecs wrapper isn't
      // in the app-startup bundle — only when the export dialog is opened.
      const { clipEncodeProbe } = await import("@/lib/videoExportPipeline");
      const support = await evaluateClipEncodeSupport(clipEncodeProbe, dims);
      if (cancelled) return;
      if (support.supported) {
        setPhase("form");
      } else {
        setPhase("unsupported");
        setSupportMessage(support.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, labels, video]);

  // Probe the focused video's dimensions so the preview can render it.
  useEffect(() => {
    if (!open || !focused) return;
    let cancelled = false;
    (async () => {
      await ensureProbed(focused);
      if (!cancelled) bumpProbe();
    })();
    return () => {
      cancelled = true;
    };
  }, [open, focused]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Don't allow closing mid-encode via overlay click; use Cancel instead.
      if (!next && phase === "encoding") return;
      setOpen(next);
    },
    [phase, setOpen]
  );

  const handleCancel = useCallback(() => {
    if (phase === "encoding") {
      abortRef.current?.abort();
      return;
    }
    setOpen(false);
  }, [phase, setOpen]);

  // Encode ONE video's clip → mp4 bytes (throws on invalid range / cancel).
  const encodeOne = useCallback(
    async (
      cfg: ClipConfig,
      cb: { signal: AbortSignal; onProgress: (done: number, total: number) => void }
    ): Promise<Uint8Array> => {
      if (!labels) throw new Error("No project loaded.");
      const fvideo = cfg.video;
      await ensureProbed(fvideo);
      const len = fvideo.shape?.[0] ?? 0;
      const srcW = fvideo.shape?.[2] ?? 0;
      const srcH = fvideo.shape?.[1] ?? 0;
      const rr = resolveClipFrameRange(cfg.start, cfg.end, len);
      if (!rr.ok) throw new Error(rr.error);
      if (!Number.isFinite(cfg.fps) || cfg.fps <= 0) throw new Error("Invalid frame rate.");
      const scale = clampClipScale(cfg.scale);
      const output = computeClipOutputDimensions(srcW, srcH, scale);

      const frameToLf = new Map<number, LabeledFrame>();
      for (const lf of labels.find({ video: fvideo })) frameToLf.set(lf.frameIdx, lf);
      const tracks = labels.tracks;
      const projectHasTracks = hasAssignedTracks(labels);
      const overlayForFrame = (frameIdx: number) => {
        const lf = frameToLf.get(frameIdx);
        if (!lf) return [];
        return buildExportRenderedInstances(lf.instances, {
          palette,
          distinctlyColor,
          colorPredicted,
          showNonVisibleNodes,
          tracks,
          video: fvideo,
          projectHasTracks,
        });
      };

      const { buildClipExportPipeline, decodeExportFrame } = await import(
        "@/lib/videoExportPipeline"
      );
      const deps = buildClipExportPipeline({
        output,
        fps: cfg.fps,
        video: fvideo,
        decodeFrame: (frameIdx) => decodeExportFrame(fvideo, frameIdx),
        overlayForFrame,
      });
      return runClipExport(
        {
          range: rr.range,
          fps: cfg.fps,
          scale,
          sourceWidth: srcW,
          sourceHeight: srcH,
          output,
          background: clipBackgroundColor(cfg.background),
          renderOptions: {
            markerSize,
            nodeLabelSize,
            edgeStyle,
            showInstances,
            showLabels,
            showEdges,
            showNonVisibleNodes,
            colorPredicted,
            showTrackScore: false,
          },
        },
        deps,
        { signal: cb.signal, onProgress: cb.onProgress }
      );
    },
    [
      labels,
      palette,
      distinctlyColor,
      colorPredicted,
      showNonVisibleNodes,
      showInstances,
      showLabels,
      showEdges,
      markerSize,
      nodeLabelSize,
      edgeStyle,
    ]
  );

  const handleExportBatch = useCallback(
    async (all: boolean) => {
      if (!labels) return;
      const toExport = (
        all ? state.configs.map((c) => ({ ...c, include: true })) : state.configs
      ).filter((c) => c.include);
      if (toExport.length === 0) {
        toast.error("No videos selected", {
          description: "Select at least one video to export.",
        });
        return;
      }

      // Choose the destination once (desktop folder) or per-file (browser).
      const dest = await pickClipDestination();
      if (dest.mode === "cancelled") return;
      const dir = dest.mode === "dir" ? dest.dir : null;

      const queued = new Map<Video, ClipJobInfo>();
      for (const c of toExport) queued.set(c.video, { status: "queued" });
      setJobs(queued);

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase("encoding");
      try {
        const summary = await runClipExportBatch(toExport, {
          exportOne: (cfg, cbk) => encodeOne(cfg, cbk),
          saveOne: async (cfg, bytes) => {
            const len = cfg.video.shape?.[0] ?? 0;
            const rr = resolveClipFrameRange(cfg.start, cfg.end, len);
            const range = rr.ok ? rr.range : { start: cfg.start, end: cfg.end };
            const name = deriveClipFilename(filename, range, videoLabel(cfg.video));
            return dir
              ? saveBytesToDir(dir, name, bytes)
              : saveBytesFile(bytes, name, { name: "MP4 Video", ext: "mp4" });
          },
          onStatus: (v, status, extra) =>
            setJobs((prev) => {
              const m = new Map(prev);
              m.set(v, { status, progress: extra?.progress });
              return m;
            }),
          signal: controller.signal,
        });

        const { done, failed, cancelled } = summary;
        if (failed === 0 && cancelled === 0) {
          toast.success(`Exported ${done} clip${done === 1 ? "" : "s"}`, {
            description: dir ?? undefined,
          });
        } else if (cancelled > 0) {
          toast.info(`Export cancelled — ${done} done, ${cancelled} skipped`);
        } else {
          toast.error(`Exported ${done} of ${done + failed} — ${failed} failed`);
        }
      } finally {
        abortRef.current = null;
        setPhase((p) => (p === "encoding" ? "form" : p));
      }
    },
    [labels, state.configs, filename, encodeOne]
  );

  if (!video || !labels) return null;

  const encoding = phase === "encoding";
  const unsupported = phase === "unsupported";
  const checking = phase === "checking";
  const nIncluded = state.configs.filter((c) => c.include).length;

  // Overall + current-video progress derived from job state.
  const jobsArr = [...jobs.values()];
  const finished = jobsArr.filter(
    (j) => j.status === "done" || j.status === "error" || j.status === "cancelled"
  ).length;
  const current = jobsArr.find((j) => j.status === "encoding");
  const curPct =
    current?.progress && current.progress.total
      ? Math.round((current.progress.done / current.progress.total) * 100)
      : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Export Clips</DialogTitle>
          <DialogDescription>
            Export labeled clips (skeleton overlay burned in) to mp4. Pick a
            range per video by scrubbing the preview or editing the fields, then
            export the selected videos.
          </DialogDescription>
        </DialogHeader>

        {unsupported ? (
          <div className="py-2 text-sm text-muted-foreground">{supportMessage}</div>
        ) : (
          <div className="flex gap-3 py-2 flex-1 min-h-0">
            {/* Left: video list */}
            <div className="w-56 shrink-0 min-h-0">
              <ClipVideoList
                configs={state.configs}
                focused={focused}
                jobs={jobs}
                disabled={encoding}
                onFocus={(v) => dispatch({ type: "focus", video: v })}
                onToggleInclude={(v) => dispatch({ type: "toggleInclude", video: v })}
                onSetAll={(include) => dispatch({ type: "setAllIncluded", include })}
              />
            </div>

            {/* Right: preview + per-video settings */}
            <div className="flex-1 min-w-0 min-h-0 space-y-3 overflow-y-auto">
              {focused && focusedConfig && !encoding && (
                <ClipPreview
                  key={focusedIndex}
                  video={focused}
                  start={focusedConfig.start}
                  end={focusedConfig.end}
                  onRangeChange={(s, e) =>
                    dispatch({ type: "setRange", video: focused, start: s, end: e })
                  }
                />
              )}
              {focusedConfig && (
                <ClipSettings
                  config={focusedConfig}
                  disabled={encoding}
                  onRange={(s, e) =>
                    dispatch({ type: "setRange", video: focusedConfig.video, start: s, end: e })
                  }
                  onFps={(fps) => dispatch({ type: "setFps", video: focusedConfig.video, fps })}
                  onScale={(scale) =>
                    dispatch({ type: "setScale", video: focusedConfig.video, scale })
                  }
                  onBackground={(background) =>
                    dispatch({ type: "setBackground", video: focusedConfig.video, background })
                  }
                />
              )}
              {encoding && (
                <div className="space-y-1 pt-1">
                  <Progress value={curPct} />
                  <p className="text-xs text-muted-foreground">
                    Exporting video {Math.min(finished + 1, jobs.size)} of {jobs.size} ({curPct}%)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="items-center shrink-0">
          {!unsupported && !encoding && (
            <span className="text-xs text-muted-foreground mr-auto">
              {nIncluded} of {state.configs.length} selected
            </span>
          )}
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          {!unsupported && (
            <>
              <Button
                variant="secondary"
                onClick={() => handleExportBatch(true)}
                disabled={encoding || checking || state.configs.length === 0}
              >
                Export all
              </Button>
              <Button
                onClick={() => handleExportBatch(false)}
                disabled={encoding || checking || nIncluded === 0}
              >
                {encoding ? "Exporting…" : `Export selected (${nIncluded})`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
