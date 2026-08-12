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

import { useEffect, useRef } from "react";
import type { Instance, Track, Video } from "@/types";
import { renderInstances } from "@/canvas/SkeletonRenderer";
import {
  buildConflictOverlay,
  computeFitTransform,
} from "@/lib/mergeConflictOverlay";

interface ConflictPreviewCanvasProps {
  /** Base video the conflict frame belongs to (resolved in-project). */
  video: Video | null;
  frameIdx: number;
  baseInstances: Instance[];
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
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d")?.putImageData(
      new ImageData(new Uint8ClampedArray(bytes), w, h),
      0,
      0
    );
    return c;
  }
  return null;
}

export function ConflictPreviewCanvas({
  video,
  frameIdx,
  baseInstances,
  donorInstances,
  tracks,
  width = 360,
  height = 320,
  className,
}: ConflictPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

      let drawable: OffscreenCanvas | null = null;
      try {
        const frame = await video.getFrame(frameIdx);
        if (cancelled || !frame) return;
        drawable = frameToDrawable(frame, video);
      } catch {
        return; // frame unreadable — leave the cleared canvas
      }
      if (cancelled || !drawable) return;

      const srcW = drawable.width;
      const srcH = drawable.height;
      const fit = computeFitTransform(srcW, srcH, canvas.width, canvas.height);

      // Frame image, letterboxed to fit.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(
        drawable,
        0,
        0,
        srcW,
        srcH,
        fit.offsetX,
        fit.offsetY,
        fit.displayWidth,
        fit.displayHeight
      );

      // Poses in source-pixel space, scaled+offset onto the fitted frame.
      const { base, donor } = buildConflictOverlay(
        baseInstances,
        donorInstances,
        { video, tracks }
      );
      ctx.setTransform(fit.scale, 0, 0, fit.scale, fit.offsetX, fit.offsetY);
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
  }, [video, frameIdx, baseInstances, donorInstances, tracks]);

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
