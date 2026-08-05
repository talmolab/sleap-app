/**
 * Export-clip preview: a scrubbable, WYSIWYG canvas for one (focused) video.
 *
 * Decodes the frame at the seek position and composites the skeleton overlay
 * with the SAME functions the encoder uses (buildExportRenderedInstances +
 * renderInstances), so it shows exactly what will be burned into the clip. A
 * scrubbar with a seek head + two in/out handles sets the video's start/end.
 * Decode is coalesced to a single in-flight read so scrubbing stays responsive
 * on slow / image-sequence (ImageVideo) backends. No real-time playback
 * (scrub/seek only, per the design).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import type { LabeledFrame, Video } from "../../types";
import {
  buildExportRenderedInstances,
  pixelToFrame,
  clampHandleDrag,
} from "@/lib/videoExport";
import { renderInstances } from "@/canvas/SkeletonRenderer";

interface ClipPreviewProps {
  video: Video;
  /** 0-based inclusive range for THIS video. */
  start: number;
  end: number;
  /** Fired when the user drags an in/out handle. */
  onRangeChange: (start: number, end: number) => void;
}

const MAX_W = 440;
const MAX_H = 260;

export function ClipPreview({ video, start, end, onRangeChange }: ClipPreviewProps) {
  const labels = useAppStore((s) => s.labels);
  // View settings that shape the overlay (captured for WYSIWYG parity).
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

  const len = video.shape?.[0] ?? 0;
  const srcH = video.shape?.[1] ?? 0;
  const srcW = video.shape?.[2] ?? 0;

  const fit = srcW > 0 && srcH > 0 ? Math.min(MAX_W / srcW, MAX_H / srcH, 1) : 1;
  const dispW = Math.max(1, Math.round(srcW * fit));
  const dispH = Math.max(1, Math.round(srcH * fit));

  const [seekFrame, setSeekFrame] = useState(start);
  const [showOverlay, setShowOverlay] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const decodingRef = useRef(false);
  const pendingRef = useRef<number | null>(null);
  const dragRef = useRef<"start" | "end" | "seek" | null>(null);

  // Labeled frames for this video, indexed by frame for O(1) overlay lookup.
  const frameToLf = useMemo(() => {
    const m = new Map<number, LabeledFrame>();
    if (labels) for (const lf of labels.find({ video })) m.set(lf.frameIdx, lf);
    return m;
  }, [labels, video]);

  const drawFrame = useCallback(
    async (frameIdx: number) => {
      const canvas = canvasRef.current;
      if (!canvas || srcW === 0 || srcH === 0) return;
      // Coalesce: never issue a second decode while one is in flight — remember
      // the latest requested frame and draw it once the current read resolves.
      if (decodingRef.current) {
        pendingRef.current = frameIdx;
        return;
      }
      decodingRef.current = true;
      try {
        const { decodeExportFrame } = await import("@/lib/videoExportPipeline");
        const frame = await decodeExportFrame(video, frameIdx);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const s = Math.min(MAX_W / srcW, MAX_H / srcH, 1);
        const w = Math.max(1, Math.round(srcW * s));
        const h = Math.max(1, Math.round(srcH * s));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        if (frame) ctx.drawImage(frame, 0, 0, srcW, srcH, 0, 0, w, h);
        if (showOverlay && labels) {
          const lf = frameToLf.get(frameIdx);
          const instances = buildExportRenderedInstances(lf?.instances ?? [], {
            palette,
            distinctlyColor,
            colorPredicted,
            showNonVisibleNodes,
            tracks: labels.tracks ?? [],
            video,
          });
          // Overlay in source space scaled to the display; zoom:s keeps marker
          // sizes visually constant (matches the encoder + the main canvas).
          ctx.setTransform(s, 0, 0, s, 0, 0);
          renderInstances(ctx, instances, {
            markerSize,
            nodeLabelSize,
            edgeStyle,
            showInstances,
            showLabels,
            showEdges,
            showNonVisibleNodes,
            colorPredicted,
            zoom: s,
          });
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
      } finally {
        decodingRef.current = false;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next !== null && next !== frameIdx) void drawFrame(next);
      }
    },
    [
      video, srcW, srcH, showOverlay, labels, frameToLf, palette, distinctlyColor,
      colorPredicted, showNonVisibleNodes, showInstances, showLabels, showEdges,
      markerSize, nodeLabelSize, edgeStyle,
    ]
  );

  useEffect(() => {
    void drawFrame(seekFrame);
  }, [seekFrame, drawFrame]);

  // Keep the seek head in range if the video changes under us.
  useEffect(() => {
    if (len > 0 && seekFrame > len - 1) setSeekFrame(len - 1);
  }, [len, seekFrame]);

  const applyPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const frame = pixelToFrame(clientX - rect.left, rect.width, len);
      const mode = dragRef.current;
      if (mode === "start") {
        const ns = clampHandleDrag("start", frame, { start, end, len });
        onRangeChange(ns, end);
        setSeekFrame(ns);
      } else if (mode === "end") {
        const ne = clampHandleDrag("end", frame, { start, end, len });
        onRangeChange(start, ne);
        setSeekFrame(ne);
      } else {
        setSeekFrame(frame);
      }
    },
    [len, start, end, onRangeChange]
  );

  const capture = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // setPointerCapture throws if the pointer is no longer active; the drag
      // still works via event bubbling, so ignore.
    }
  };

  const pct = (f: number) =>
    len > 1 ? (Math.max(0, Math.min(len - 1, f)) / (len - 1)) * 100 : 0;

  if (srcW === 0 || srcH === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        Preview unavailable — video dimensions not loaded yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="flex items-center justify-center bg-black/40 rounded"
        style={{ minHeight: dispH }}
      >
        <canvas ref={canvasRef} width={dispW} height={dispH} className="rounded" />
      </div>
      <div
        ref={trackRef}
        className="relative h-6 bg-muted rounded cursor-pointer select-none touch-none"
        onPointerDown={(e) => {
          capture(e);
          dragRef.current = "seek";
          applyPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragRef.current) applyPointer(e.clientX);
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
      >
        {/* selected region */}
        <div
          className="absolute top-0 bottom-0 bg-primary/30 pointer-events-none"
          style={{ left: `${pct(start)}%`, width: `${Math.max(0, pct(end) - pct(start))}%` }}
        />
        {/* in / out handles */}
        <div
          role="slider"
          aria-label="Clip start"
          className="absolute top-0 bottom-0 w-2 bg-primary rounded cursor-ew-resize"
          style={{ left: `${pct(start)}%`, transform: "translateX(-50%)" }}
          onPointerDown={(e) => {
            e.stopPropagation();
            capture(e);
            dragRef.current = "start";
            applyPointer(e.clientX);
          }}
        />
        <div
          role="slider"
          aria-label="Clip end"
          className="absolute top-0 bottom-0 w-2 bg-primary rounded cursor-ew-resize"
          style={{ left: `${pct(end)}%`, transform: "translateX(-50%)" }}
          onPointerDown={(e) => {
            e.stopPropagation();
            capture(e);
            dragRef.current = "end";
            applyPointer(e.clientX);
          }}
        />
        {/* seek head */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-foreground pointer-events-none"
          style={{ left: `${pct(seekFrame)}%`, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">
          Frame {seekFrame.toLocaleString()} / {(len - 1).toLocaleString()}
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showOverlay}
            onChange={(e) => setShowOverlay(e.target.checked)}
          />
          Show overlay
        </label>
      </div>
    </div>
  );
}
