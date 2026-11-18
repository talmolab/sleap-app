/**
 * Frames for the Label QC Grid's thumbnails: read through the video's own
 * backend (as the receptive-field preview does), a few at a time so a grid of
 * hundreds doesn't flood the decoder, and kept for the session so scrolling
 * back is instant. Several tiles on one frame share one read.
 */
import type { Video } from "@talmolab/sleap-io.js";
import { frameToBitmap } from "@/lib/frameBitmap";
import { toImageCoords } from "@/lib/cropTransform";

const MAX_PARALLEL = 3;
const MAX_CACHED = 300;

const cache = new Map<string, Promise<ImageBitmap | null>>();
const videoIds = new WeakMap<Video, number>();
let nextVideoId = 0;
let running = 0;
const waiting: (() => void)[] = [];

const videoId = (v: Video) => {
  let id = videoIds.get(v);
  if (id === undefined) {
    id = nextVideoId++;
    videoIds.set(v, id);
  }
  return id;
};

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** The frame as an ImageBitmap (null when it can't be read). */
export function qcThumbFrame(video: Video, frameIdx: number): Promise<ImageBitmap | null> {
  const key = `${videoId(video)}:${frameIdx}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last, so the oldest is evicted first.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = slot(async () => {
    const backend = video.backend;
    if (!backend) return null;
    try {
      return await frameToBitmap(await backend.getFrame(frameIdx), video.shape);
    } catch {
      return null;
    }
  });
  cache.set(key, p);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return p;
}

/** The square crop (image coords) around the visible points, with a margin. Null with no visible point. */
export function thumbCrop(points: readonly (readonly number[])[]): { x: number; y: number; size: number } | null {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY) * 1.35 + 24;
  return { x: (minX + maxX) / 2 - size / 2, y: (minY + maxY) / 2 - size / 2, size };
}

export interface ThumbPose {
  /** Source-frame coords, NaN for not placed or not visible. */
  points: number[][];
  edges: [number, number][];
  /** Nodes to ring in red. */
  flagged: number[];
}

/** Draw the crop of `bitmap` (or a dark square) and the pose over it, onto a square canvas. */
export function drawQcThumb(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap | null,
  video: Video | null,
  pose: ThumbPose,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  // Marks are sized for a ~140px tile, scaled with the canvas (drawn at 2x).
  const k = W / 140;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, W);
  const img = pose.points.map((p) => (Number.isFinite(p[0]) ? toImageCoords(video, p[0], p[1]) : [NaN, NaN]));
  const crop = thumbCrop(img);
  if (!crop) return;
  const s = W / crop.size;
  if (bitmap) ctx.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, W, W);
  const at = (i: number) => [(img[i][0] - crop.x) * s, (img[i][1] - crop.y) * s];
  const ok = (i: number) => Number.isFinite(img[i]?.[0]);
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1.5 * k;
  for (const [a, b] of pose.edges) {
    if (!ok(a) || !ok(b)) continue;
    const [ax, ay] = at(a);
    const [bx, by] = at(b);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(56, 189, 248, 0.95)";
  img.forEach((_, i) => {
    if (!ok(i)) return;
    const [x, y] = at(i);
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * k, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.strokeStyle = "rgba(255, 45, 85, 0.95)";
  ctx.lineWidth = 2 * k;
  for (const i of pose.flagged) {
    if (!ok(i)) continue;
    const [x, y] = at(i);
    ctx.beginPath();
    ctx.arc(x, y, 6 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
}
