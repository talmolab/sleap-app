/**
 * Export Clips dialog — batch export manager.
 *
 * Lists the project's videos with a per-video include checkbox and per-video
 * range/fps/scale/background, a scrubbable WYSIWYG preview of the focused video,
 * and encodes to H.264 mp4 (skeleton overlay burned in; PyQt parity). Every
 * setting is per-video; overlay appearance follows the current View settings.
 *
 * Phase 2: video list + per-video config + focus + preview. The Export button
 * exports the FOCUSED video's clip; batch export of the selected videos (with
 * per-video progress + a destination folder) lands in Phase 3.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { saveBytesFile } from "../../commands/fileCommands";
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
import {
  resolveClipFrameRange,
  computeClipOutputDimensions,
  deriveClipFilename,
  evaluateClipEncodeSupport,
  buildExportRenderedInstances,
  runClipExport,
  clampClipScale,
  clipBackgroundColor,
  buildInitialClipConfigs,
  clipExportReducer,
  ClipExportCancelled,
} from "@/lib/videoExport";
import { ClipPreview } from "./ClipPreview";
import { ClipVideoList } from "./ClipVideoList";
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
  const [progress, setProgress] = useState({ done: 0, total: 0 });
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
    setProgress({ done: 0, total: 0 });
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

  // Phase 2: export the FOCUSED video's clip (batch export lands in Phase 3).
  const handleExport = useCallback(async () => {
    if (!labels || !focused || !focusedConfig) return;
    const fvideo = focused;
    const cfg = focusedConfig;
    const len = fvideo.shape?.[0] ?? 0;
    const srcW = fvideo.shape?.[2] ?? 0;
    const srcH = fvideo.shape?.[1] ?? 0;

    const rangeResult = resolveClipFrameRange(cfg.start, cfg.end, len);
    if (!rangeResult.ok) {
      toast.error("Invalid frame range", { description: rangeResult.error });
      return;
    }
    const range = rangeResult.range;
    if (!Number.isFinite(cfg.fps) || cfg.fps <= 0) {
      toast.error("Invalid frame rate", { description: "Enter an fps greater than 0." });
      return;
    }
    const scale = clampClipScale(cfg.scale);
    const output = computeClipOutputDimensions(srcW, srcH, scale);

    // O(1) overlay lookup per frame; frames with no labels get an empty overlay.
    const frameToLf = new Map<number, LabeledFrame>();
    for (const lf of labels.find({ video: fvideo })) frameToLf.set(lf.frameIdx, lf);
    const tracks = labels.tracks;
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
      });
    };

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("encoding");
    setProgress({ done: 0, total: range.count });

    try {
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

      const bytes = await runClipExport(
        {
          range,
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
          },
        },
        deps,
        {
          signal: controller.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        }
      );

      const suggested = deriveClipFilename(filename, range);
      const saved = await saveBytesFile(bytes, suggested, { name: "MP4 Video", ext: "mp4" });
      if (saved) {
        toast.success("Clip exported", { description: saved });
        setOpen(false);
      }
    } catch (err) {
      if (err instanceof ClipExportCancelled) {
        toast.info("Clip export cancelled");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error("Failed to export clip", { description: msg });
        console.error("[ExportClip] Failed to export:", err);
      }
    } finally {
      abortRef.current = null;
      setPhase((p) => (p === "encoding" ? "form" : p));
    }
  }, [
    labels,
    focused,
    focusedConfig,
    filename,
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
    setOpen,
  ]);

  if (!video || !labels) return null;

  const pct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const encoding = phase === "encoding";
  const unsupported = phase === "unsupported";
  const checking = phase === "checking";
  const nIncluded = state.configs.filter((c) => c.include).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Export Clips</DialogTitle>
          <DialogDescription>
            Export labeled clips (skeleton overlay burned in) to mp4. Pick a
            range per video by scrubbing the preview or editing the fields.
          </DialogDescription>
        </DialogHeader>

        {unsupported ? (
          <div className="py-2 text-sm text-muted-foreground">{supportMessage}</div>
        ) : (
          <div className="flex gap-3 py-2" style={{ minHeight: 360 }}>
            {/* Left: video list */}
            <div className="w-56 shrink-0">
              <ClipVideoList
                configs={state.configs}
                focused={focused}
                onFocus={(v) => dispatch({ type: "focus", video: v })}
                onToggleInclude={(v) => dispatch({ type: "toggleInclude", video: v })}
                onSetAll={(include) => dispatch({ type: "setAllIncluded", include })}
              />
            </div>

            {/* Right: preview + per-video settings */}
            <div className="flex-1 min-w-0 space-y-3">
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
                  <Progress value={pct} />
                  <p className="text-xs text-muted-foreground">
                    Encoding frame {progress.done} of {progress.total} ({pct}%)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="items-center">
          {!unsupported && !encoding && (
            <span className="text-xs text-muted-foreground mr-auto">
              {nIncluded} selected · batch export of selected videos coming next
            </span>
          )}
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          {!unsupported && (
            <Button onClick={handleExport} disabled={encoding || checking || !focusedConfig}>
              {encoding ? "Exporting…" : "Export focused"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
