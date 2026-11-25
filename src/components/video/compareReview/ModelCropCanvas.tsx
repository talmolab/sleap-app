/**
 * Compare Models review window: one frame (or a crop of it) with model poses
 * drawn on top in the models' colours, the consensus as small white crosses
 * and red rings on the nodes the models disagree on. The project's own
 * instances can be drawn underneath in silver (solid: yours, dashed:
 * predictions already in the project). Decoded frames are shared (see
 * frameDecodeCache.ts); a frame that can't be read says so instead of
 * leaving the pane black.
 */
import { useEffect, useRef, useState } from "react";
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
import type { NodeMark, ProjectPose, Rect } from "@/lib/modelOverlay/review";
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
  marks,
  projectPoses,
  edges,
  width,
  height,
  className,
  interactive = false,
  onClick,
}: {
  video: Video;
  frame: number;
  /** Source-pixel region to show; null = whole frame. */
  crop: Rect | null;
  poses: readonly CropPose[];
  consensus?: Float64Array | null;
  /** Red rings: source-pixel centre and radius. */
  rings?: readonly { x: number; y: number; r: number }[];
  /** Disputed nodes to point out: a small red marker and the node's name. */
  marks?: readonly NodeMark[];
  /** The project's own instances on this frame, drawn under the models (omit to hide them). */
  projectPoses?: readonly ProjectPose[];
  edges: readonly (readonly [number, number])[];
  width: number;
  height: number;
  className?: string;
  /** Enlarged card: scroll to zoom (about the pointer), drag to pan, double-click to reset. */
  interactive?: boolean;
  /** Click on the picture (a grid card: enlarge it). */
  onClick?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Zoom (k ≥ 1) and pan (px, py, CSS px) on top of fitting the crop; reset when the picture changes.
  const viewKey = `${frame}|${crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : "all"}|${width}x${height}|${interactive}`;
  const [view, setView] = useState({ key: viewKey, k: 1, px: 0, py: 0 });
  const v = view.key === viewKey ? view : { key: viewKey, k: 1, px: 0, py: 0 };
  // The fit of the last draw (for zooming about the pointer).
  const fitRef = useRef({ ox0: 0, oy0: 0 });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((prev) => {
        const cur = prev.key === viewKey ? prev : { key: viewKey, k: 1, px: 0, py: 0 };
        const k = Math.min(20, Math.max(1, cur.k * Math.exp(-e.deltaY * 0.0015)));
        const f = k / cur.k;
        const { ox0, oy0 } = fitRef.current;
        // Keep the point under the pointer where it is: O' = m - (m - O)·f, O = ox0·k + px.
        const ox = mx - (mx - (ox0 * cur.k + cur.px)) * f;
        const oy = my - (my - (oy0 * cur.k + cur.py)) * f;
        return k === 1 ? { key: viewKey, k: 1, px: 0, py: 0 } : { key: viewKey, k, px: ox - ox0 * k, py: oy - oy0 * k };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [interactive, viewKey]);

  const drag = useRef<{ x: number; y: number } | null>(null);
  const pointerHandlers = interactive
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          drag.current = { x: e.clientX, y: e.clientY };
          setView((prev) => {
            const cur = prev.key === viewKey ? prev : { key: viewKey, k: 1, px: 0, py: 0 };
            return { ...cur, px: cur.px + dx, py: cur.py + dy };
          });
        },
        onPointerUp: () => {
          drag.current = null;
        },
        onDoubleClick: () => setView({ key: viewKey, k: 1, px: 0, py: 0 }),
      }
    : {};

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
      const base = Math.min(width / r.w, height / r.h);
      const ox0 = (width - r.w * base) / 2;
      const oy0 = (height - r.h * base) / 2;
      fitRef.current = { ox0, oy0 };
      // Zoomed and panned (interactive); scale is screen px per source px.
      const scale = base * v.k;
      const ox = ox0 * v.k + v.px;
      const oy = oy0 * v.k + v.py;
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
      if (marks && marks.length > 0) {
        // Which node is which: a small red ring on each disputed node and its
        // name beside it (white text on a dark halo, readable on any video).
        ctx.save();
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = rgbToCSS(DISAGREEMENT_COLOR, 1);
        for (const m of marks) {
          ctx.beginPath();
          ctx.arc(m.x, m.y, 6 / scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.font = `600 ${11 / scale}px sans-serif`;
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        for (const m of marks) {
          const tx = m.x + 9 / scale;
          ctx.lineWidth = 3 / scale;
          ctx.strokeStyle = "rgba(0,0,0,0.85)";
          ctx.strokeText(m.label, tx, m.y);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(m.label, tx, m.y);
        }
        ctx.restore();
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
  }, [video, frame, crop, poses, consensus, rings, marks, projectPoses, edges, width, height, v.k, v.px, v.py]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width, height, cursor: interactive ? "grab" : onClick ? "zoom-in" : undefined, touchAction: interactive ? "none" : undefined }}
      onClick={onClick}
      title={onClick ? "Click to enlarge" : interactive ? "Scroll to zoom, drag to pan, double-click to reset" : undefined}
      {...pointerHandlers}
    />
  );
}
