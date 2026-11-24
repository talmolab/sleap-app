/**
 * Compare Models review window: one frame (or a crop of it) with model poses
 * drawn on top in the models' colours, the consensus as small white crosses
 * and red rings on the nodes the models disagree on. The project's own
 * instances can be drawn underneath in silver (solid: yours, dashed:
 * predictions already in the project). Decoded frames are shared (see
 * frameDecodeCache.ts); a frame that can't be read says so instead of
 * leaving the pane black.
 */
import { useEffect, useRef } from "react";
import type { Video } from "@/types";
import type { RGB } from "@/lib/colorPalettes";
import { rgbToCSS } from "@/lib/colorPalettes";
import {
  renderModelOverlay,
  modelPoseToRendered,
  modelRenderOptions,
  DISAGREEMENT_COLOR,
  type ModelOverlayLayer,
} from "@/canvas/modelOverlayRenderer";
import { renderInstances } from "@/canvas/SkeletonRenderer";
import type { ProjectPose, Rect } from "@/lib/modelOverlay/review";
import { decodeFrame } from "./frameDecodeCache";

/** Colour of the project's own instances in the review crops (not a model colour). */
export const PROJECT_POSE_COLOR: RGB = [192, 192, 192];

export interface CropPose {
  modelId: string;
  color: RGB;
  xy: Float64Array;
}

export function ModelCropCanvas({
  video,
  frame,
  crop,
  poses,
  consensus,
  rings,
  projectPoses,
  edges,
  width,
  height,
  className,
}: {
  video: Video;
  frame: number;
  /** Source-pixel region to show; null = whole frame. */
  crop: Rect | null;
  poses: readonly CropPose[];
  consensus?: Float64Array | null;
  /** Red rings: source-pixel centre and radius. */
  rings?: readonly { x: number; y: number; r: number }[];
  /** The project's own instances on this frame, drawn under the models (omit to hide them). */
  projectPoses?: readonly ProjectPose[];
  edges: readonly (readonly [number, number])[];
  width: number;
  height: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    void decodeFrame(video, frame).then((img) => {
      if (cancelled) return;
      const shape = video.shape;
      const srcW = img?.width ?? shape?.[2] ?? 1024;
      const srcH = img?.height ?? shape?.[1] ?? 768;
      const r = crop ?? { x: 0, y: 0, w: srcW, h: srcH };
      const scale = Math.min(width / r.w, height / r.h);
      const ox = (width - r.w * scale) / 2;
      const oy = (height - r.h * scale) / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox - r.x * scale), dpr * (oy - r.y * scale));
      if (img) ctx.drawImage(img, 0, 0);
      const ident = (x: number, y: number): [number, number] => [x, y];
      const drawOpts = { markerSize: 4, poseOpacity: 1, showEdges: true, zoom: scale, toImage: ident };
      if (projectPoses && projectPoses.length > 0) {
        const rendered = projectPoses.map((p) => ({
          ...modelPoseToRendered({ xy: p.xy, score: null, trackName: null }, PROJECT_POSE_COLOR, edges, ident),
          isPredicted: p.predicted,
        }));
        // A dark halo so silver stays visible on bright (and dark) video.
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 3 * dpr;
        renderInstances(ctx, rendered, modelRenderOptions(drawOpts));
        ctx.restore();
      }
      const layers: ModelOverlayLayer[] = poses.map((p) => ({
        modelId: p.modelId,
        color: p.color,
        poses: [{ xy: p.xy, score: null, trackName: null }],
      }));
      renderModelOverlay(ctx, layers, edges, drawOpts);
      if (consensus) {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 3 * dpr;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.5 / scale;
        const s = 4 / scale;
        ctx.beginPath();
        for (let i = 0; i + 1 < consensus.length; i += 2) {
          const x = consensus[i];
          const y = consensus[i + 1];
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          ctx.moveTo(x - s, y);
          ctx.lineTo(x + s, y);
          ctx.moveTo(x, y - s);
          ctx.lineTo(x, y + s);
        }
        ctx.stroke();
        ctx.restore();
      }
      if (rings && rings.length > 0) {
        ctx.strokeStyle = rgbToCSS(DISAGREEMENT_COLOR, 0.95);
        ctx.lineWidth = 2 / scale;
        for (const ring of rings) {
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, Math.max(ring.r, 7 / scale), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (!img) {
        // Say so rather than leave a black pane that looks like a dark frame.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.font = "11px sans-serif";
        ctx.fillText(`Frame ${frame} not available`, 6, 14);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [video, frame, crop, poses, consensus, rings, projectPoses, edges, width, height]);

  return <canvas ref={ref} className={className} style={{ width, height }} />;
}
