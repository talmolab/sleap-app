/**
 * Review prototypes (dev only): one frame (or a crop of it) with model poses
 * drawn on top in the models' colours, the consensus as small white crosses
 * and red rings on the nodes the models disagree on. Decoded frames are
 * shared through a small cache, so several panes of the same frame decode it
 * once.
 */
import { useEffect, useRef } from "react";
import type { Video } from "@/types";
import type { RGB } from "@/lib/colorPalettes";
import { rgbToCSS } from "@/lib/colorPalettes";
import { frameToCanvas } from "@/lib/frameCanvas";
import { renderModelOverlay, DISAGREEMENT_COLOR, type ModelOverlayLayer } from "@/canvas/modelOverlayRenderer";
import type { Rect } from "@/lib/modelOverlay/reviewPrototype";

const CACHE_SIZE = 48;
const frameCache = new Map<string, Promise<OffscreenCanvas | null>>();
const videoIds = new WeakMap<Video, number>();
let nextVideoId = 1;

function decodeFrame(video: Video, frame: number): Promise<OffscreenCanvas | null> {
  let id = videoIds.get(video);
  if (id === undefined) videoIds.set(video, (id = nextVideoId++));
  const key = `${id}:${frame}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      return await frameToCanvas(await video.getFrame(frame, { prefetch: false }), video.shape);
    } catch {
      return null;
    }
  })();
  if (frameCache.size >= CACHE_SIZE) frameCache.delete(frameCache.keys().next().value as string);
  frameCache.set(key, p);
  return p;
}

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
      const layers: ModelOverlayLayer[] = poses.map((p) => ({
        modelId: p.modelId,
        color: p.color,
        poses: [{ xy: p.xy, score: null, trackName: null }],
      }));
      renderModelOverlay(ctx, layers, edges, {
        markerSize: 4,
        poseOpacity: 1,
        showEdges: true,
        zoom: scale,
        toImage: (x, y) => [x, y],
      });
      if (consensus) {
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
    });
    return () => {
      cancelled = true;
    };
  }, [video, frame, crop, poses, consensus, rings, edges, width, height]);

  return <canvas ref={ref} className={className} style={{ width, height }} />;
}
