/**
 * Base-vs-donor pose preview for one merge conflict (A3).
 *
 * Decodes the selected frame from the (already-resolved) base video and paints
 * the BASE pose (blue) over it, then the DONOR pose (orange), so the user can
 * see the clash and decide keep-base / keep-donor / keep-both. Reuses the
 * project's pure painter (`renderInstances`) and the shared instance builder via
 * {@link buildConflictOverlay}; frame decode mirrors VideoPlayer's normalization.
 *
 * This is a read-only preview — no interaction, no store subscriptions.
 */

import { useEffect, useMemo, useRef } from "react";
import type { Instance, Track, Video } from "@/types";
import { useAppStore } from "@/stores/appStore";
import { renderInstances } from "@/canvas/SkeletonRenderer";
import { hasAssignedTracks } from "@/lib/colorPalettes";
import {
  buildConflictOverlay,
  computeFitTransform,
  conflictCropRect,
  type Rect,
} from "@/lib/mergeConflictOverlay";
import { expandFrameBytesToRGBA, inferFrameChannels } from "@/lib/videoExport";

interface ConflictPreviewCanvasProps {
  /** Base video the conflict frame belongs to (resolved in-project). */
  video: Video | null;
  frameIdx: number;
  baseInstances: Instance[];
  /** Frame color-index of each base instance (Conflict.baseColorIndices). */
  baseColorIndices?: number[];
  donorInstances: Instance[];
  tracks: Track[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Normalize a backend `getFrame` result into a drawable canvas, mirroring
 * VideoPlayer (ImageBitmap / ImageData / raw RGBA bytes). Returns null for an
 * unrecognized frame type or a missing shape.
 */
function frameToDrawable(frame: unknown, video: Video): OffscreenCanvas | null {
  if (frame instanceof ImageBitmap) {
    const c = new OffscreenCanvas(frame.width, frame.height);
    c.getContext("2d")?.drawImage(frame, 0, 0);
    return c;
  }
  if (frame instanceof ImageData) {
    const c = new OffscreenCanvas(frame.width, frame.height);
    c.getContext("2d")?.putImageData(frame, 0, 0);
    return c;
  }
  if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
    const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
    const shape = video.shape;
    if (!shape) return null;
    const [, h, w] = shape;
    const channels = inferFrameChannels(bytes.length, w, h, shape[3]);
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d")?.putImageData(
      new ImageData(expandFrameBytesToRGBA(bytes, w, h, channels), w, h),
      0,
      0
    );
    return c;
  }
  if (
    frame &&
    typeof frame === "object" &&
    "data" in frame &&
    "width" in frame &&
    "height" in frame
  ) {
    const raw = frame as {
      data: Uint8Array | Uint8ClampedArray;
      width: number;
      height: number;
      channels?: number;
    };
    const bytes =
      raw.data instanceof Uint8ClampedArray
        ? new Uint8Array(raw.data)
        : raw.data;
    const c = new OffscreenCanvas(raw.width, raw.height);
    c.getContext("2d")?.putImageData(
      new ImageData(
        expandFrameBytesToRGBA(bytes, raw.width, raw.height, raw.channels ?? 1),
        raw.width,
        raw.height
      ),
      0,
      0
    );
    return c;
  }
  return null;
}

/** Clamp a source-space rect to the frame bounds (keeps drawImage source valid). */
function clampRect(r: Rect, srcW: number, srcH: number): Rect {
  const w = Math.min(r.w, srcW);
  const h = Math.min(r.h, srcH);
  return {
    w,
    h,
    x: Math.max(0, Math.min(r.x, srcW - w)),
    y: Math.max(0, Math.min(r.y, srcH - h)),
  };
}

export function ConflictPreviewCanvas({
  video,
  frameIdx,
  baseInstances,
  baseColorIndices,
  donorInstances,
  tracks,
  width = 360,
  height = 320,
  className,
}: ConflictPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Base pose uses the project's real color settings so it matches the canvas.
  const palette = useAppStore((s) => s.palette);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const colorPredicted = useAppStore((s) => s.colorPredicted);
  const labels = useAppStore((s) => s.labels);
  const projectHasTracks = useMemo(() => hasAssignedTracks(labels), [labels]);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const clear = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };

    const paint = async () => {
      clear();
      if (!video) return;

      // Decode the frame if we can; a missing/undecodable frame is non-fatal —
      // we still draw the poses (on black), which are the point of the preview.
      let drawable: OffscreenCanvas | null = null;
      try {
        const frame = await video.getFrame(frameIdx);
        if (cancelled) return;
        if (frame) drawable = frameToDrawable(frame, video);
      } catch {
        /* leave drawable null */
      }
      if (cancelled) return;

      // Source dimensions from the decoded frame, else the video's known shape.
      const shape = video.shape;
      const srcW = drawable?.width ?? shape?.[2] ?? 0;
      const srcH = drawable?.height ?? shape?.[1] ?? 0;
      if (!srcW || !srcH) return; // no way to place the poses

      const { base, donor } = buildConflictOverlay(
        baseInstances,
        donorInstances,
        { video, tracks, palette, distinctlyColor, colorPredicted, projectHasTracks, baseColorIndices }
      );

      // Crop to the conflict region so the two poses (and their small offset)
      // fill the preview instead of being lost in the full frame.
      const crop = clampRect(
        conflictCropRect([...base, ...donor], { padFrac: 0.8, minSize: 60 }) ?? {
          x: 0,
          y: 0,
          w: srcW,
          h: srcH,
        },
        srcW,
        srcH
      );
      const fit = computeFitTransform(crop.w, crop.h, canvas.width, canvas.height);

      // Frame image (cropped), letterboxed; skipped when undecodable → poses on black.
      if (drawable) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(
          drawable,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          fit.offsetX,
          fit.offsetY,
          fit.displayWidth,
          fit.displayHeight
        );
      }

      // Poses in source-pixel space, mapped through the crop → canvas.
      ctx.setTransform(
        fit.scale,
        0,
        0,
        fit.scale,
        fit.offsetX - crop.x * fit.scale,
        fit.offsetY - crop.y * fit.scale
      );
      const renderOpts = {
        zoom: fit.scale, // keep marker/edge sizes visually constant
        showLabels: false, // keep the small preview uncluttered
        showNonVisibleNodes: true,
        markerSize: 4,
      };
      renderInstances(ctx, base, renderOpts);
      renderInstances(ctx, donor, renderOpts);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    void paint();
    return () => {
      cancelled = true;
    };
  }, [
    video,
    frameIdx,
    baseInstances,
    baseColorIndices,
    donorInstances,
    tracks,
    palette,
    distinctlyColor,
    colorPredicted,
    projectHasTracks,
  ]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
      aria-label="Conflict preview: base pose (blue) vs donor pose (orange)"
    />
  );
}
