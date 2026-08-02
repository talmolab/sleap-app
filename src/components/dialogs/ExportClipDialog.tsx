/**
 * Export Labeled Clip dialog.
 *
 * Renders a range of the currently-open video with the skeleton/instance
 * overlay composited on top and encodes it to an H.264 mp4 (parity with PyQt
 * SLEAP's File → Export labeled clip). MVP scope: current video, a frame range,
 * fps, a scale factor (clamped to [0.1, 1.0] — no upscaling, PyQt parity), and a
 * background choice (original video / black / white / grey). Marker size / edges
 * / colours follow the current View settings. See {@link module:@/lib/videoExport}
 * for the pipeline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { saveBytesFile } from "../../commands/fileCommands";
import { toast } from "@/lib/notify";
import type { LabeledFrame } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  resolveClipFrameRange,
  computeClipOutputDimensions,
  deriveClipFilename,
  evaluateClipEncodeSupport,
  buildExportRenderedInstances,
  runClipExport,
  clampClipScale,
  clipBackgroundColor,
  CLIP_SCALE_MIN,
  CLIP_SCALE_MAX,
  ClipExportCancelled,
  type ClipBackground,
} from "@/lib/videoExport";

type Phase = "form" | "checking" | "unsupported" | "encoding";

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

  const totalFrames = video?.shape?.[0] ?? 0;
  const sourceHeight = video?.shape?.[1] ?? 0;
  const sourceWidth = video?.shape?.[2] ?? 0;
  const sourceFps = video?.fps ?? null;

  const [startInput, setStartInput] = useState("0");
  const [endInput, setEndInput] = useState("0");
  const [fpsInput, setFpsInput] = useState("30");
  const [scaleInput, setScaleInput] = useState("1");
  const [background, setBackground] = useState<ClipBackground>("original");
  const [phase, setPhase] = useState<Phase>("form");
  const [supportMessage, setSupportMessage] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const abortRef = useRef<AbortController | null>(null);

  // Seed defaults + run the capability probe each time the dialog opens.
  useEffect(() => {
    if (!open || !video) return;
    setPhase("checking");
    setSupportMessage("");
    setProgress({ done: 0, total: 0 });
    setStartInput("0");
    setEndInput(String(Math.max(0, totalFrames - 1)));
    setFpsInput(String(sourceFps && sourceFps > 0 ? Math.round(sourceFps) : 30));
    setScaleInput("1");
    setBackground("original");

    let cancelled = false;
    (async () => {
      const dims = computeClipOutputDimensions(sourceWidth, sourceHeight, 1);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, video]);

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

  const handleExport = useCallback(async () => {
    if (!video || !labels) return;

    const rangeResult = resolveClipFrameRange(
      parseInt(startInput, 10),
      parseInt(endInput, 10),
      totalFrames
    );
    if (!rangeResult.ok) {
      toast.error("Invalid frame range", { description: rangeResult.error });
      return;
    }
    const range = rangeResult.range;

    const fps = parseFloat(fpsInput);
    if (!Number.isFinite(fps) || fps <= 0) {
      toast.error("Invalid frame rate", { description: "Enter an fps greater than 0." });
      return;
    }
    const parsedScale = parseFloat(scaleInput);
    if (!Number.isFinite(parsedScale) || parsedScale <= 0) {
      toast.error("Invalid scale", { description: "Enter a scale factor greater than 0." });
      return;
    }
    // No upscaling (PyQt parity): clamp the value actually used to [0.1, 1.0].
    const scale = clampClipScale(parsedScale);

    const output = computeClipOutputDimensions(sourceWidth, sourceHeight, scale);

    // Pre-enumerate this video's labeled frames so overlay lookup is O(1) per
    // frame (labels.find is O(n)). Frames with no labels get an empty overlay.
    const frameToLf = new Map<number, LabeledFrame>();
    for (const lf of labels.find({ video })) frameToLf.set(lf.frameIdx, lf);

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
        video,
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
        fps,
        video,
        decodeFrame: (frameIdx) => decodeExportFrame(video, frameIdx),
        overlayForFrame,
      });

      const bytes = await runClipExport(
        {
          range,
          fps,
          scale,
          sourceWidth,
          sourceHeight,
          output,
          background: clipBackgroundColor(background),
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
      const saved = await saveBytesFile(bytes, suggested, {
        name: "MP4 Video",
        ext: "mp4",
      });
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
    video,
    labels,
    startInput,
    endInput,
    fpsInput,
    scaleInput,
    background,
    totalFrames,
    sourceWidth,
    sourceHeight,
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

  if (!video) return null;

  const pct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const encoding = phase === "encoding";
  const unsupported = phase === "unsupported";
  const checking = phase === "checking";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Export Labeled Clip</DialogTitle>
          <DialogDescription>
            Render a range of the current video with the skeleton overlay to an
            mp4.
          </DialogDescription>
        </DialogHeader>

        {unsupported ? (
          <div className="py-2 text-sm text-muted-foreground">{supportMessage}</div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="clip-start">Start frame</Label>
                <Input
                  id="clip-start"
                  type="number"
                  min={0}
                  max={Math.max(0, totalFrames - 1)}
                  value={startInput}
                  onChange={(e) => setStartInput(e.target.value)}
                  disabled={encoding}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="clip-end">End frame</Label>
                <Input
                  id="clip-end"
                  type="number"
                  min={0}
                  max={Math.max(0, totalFrames - 1)}
                  value={endInput}
                  onChange={(e) => setEndInput(e.target.value)}
                  disabled={encoding}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="clip-fps">Frame rate (fps)</Label>
                <Input
                  id="clip-fps"
                  type="number"
                  min={1}
                  value={fpsInput}
                  onChange={(e) => setFpsInput(e.target.value)}
                  disabled={encoding}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="clip-scale">Scale factor</Label>
                <Input
                  id="clip-scale"
                  type="number"
                  min={CLIP_SCALE_MIN}
                  max={CLIP_SCALE_MAX}
                  step={0.1}
                  value={scaleInput}
                  onChange={(e) => setScaleInput(e.target.value)}
                  disabled={encoding}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="clip-background">Background</Label>
                <Select
                  value={background}
                  onValueChange={(v) => setBackground(v as ClipBackground)}
                  disabled={encoding}
                >
                  <SelectTrigger id="clip-background" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="original">Original video</SelectItem>
                    <SelectItem value="black">Black</SelectItem>
                    <SelectItem value="white">White</SelectItem>
                    <SelectItem value="grey">Grey</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {totalFrames} frames &middot; {sourceWidth}&times;{sourceHeight}px source.
              Overlay marker size, edges, and colours follow the current View
              settings.
            </p>

            {encoding && (
              <div className="space-y-1 pt-1">
                <Progress value={pct} />
                <p className="text-xs text-muted-foreground">
                  Encoding frame {progress.done} of {progress.total} ({pct}%)
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          {!unsupported && (
            <Button onClick={handleExport} disabled={encoding || checking}>
              {encoding ? "Exporting…" : "Export"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
