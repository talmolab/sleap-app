/**
 * Trail renderer for tracking proofreading.
 *
 * Draws polylines connecting instance centroids across frames,
 * with fading opacity to visualize track identity over time.
 * Crossing trails indicate identity swaps that need correction.
 */

import { rgbToCSS, getTrackColor, type RGB } from "../lib/colorPalettes";
import type { Labels, Video, Track } from "../types";

/**
 * Compute the centroid of an instance's visible points.
 * Returns null if no visible points.
 */
function computeCentroid(
  instance: { points: Array<{ xy: [number, number]; visible: boolean }> }
): [number, number] | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const p of instance.points) {
    if (p.visible && !isNaN(p.xy[0]) && !isNaN(p.xy[1])) {
      sumX += p.xy[0];
      sumY += p.xy[1];
      count++;
    }
  }
  if (count === 0) return null;
  return [sumX / count, sumY / count];
}

/**
 * Render motion trails for tracked instances on the current frame.
 *
 * For each instance on the current frame that has a track, looks back
 * `trailLength` frames and draws a polyline connecting centroids with
 * fading opacity (most recent = full, oldest = near transparent).
 *
 * @param ctx - Canvas 2D rendering context (in image-space coordinates)
 * @param labels - The Labels dataset
 * @param currentFrameIdx - Current frame index
 * @param video - Current video
 * @param trailLength - Number of frames to look back
 * @param tracks - All tracks in the project
 * @param palette - Name of the color palette to use
 * @param zoom - Current zoom level for line width scaling
 * @param trackColorOverrides - Active per-track color overrides (name → hex)
 */
export function renderTrails(
  ctx: CanvasRenderingContext2D,
  labels: Labels,
  currentFrameIdx: number,
  video: Video,
  trailLength: number,
  tracks: Track[],
  palette: string,
  zoom: number,
  trackColorOverrides?: Record<string, string> | null
): void {
  if (trailLength <= 0 || tracks.length === 0) return;

  // Get all labeled frames for this video, sorted by frame index
  const videoFrames = labels
    .find({ video })
    .sort((a, b) => a.frameIdx - b.frameIdx);

  if (videoFrames.length === 0) return;

  // Find current frame's instances
  const currentFrame = videoFrames.find((lf) => lf.frameIdx === currentFrameIdx);
  if (!currentFrame) return;

  // Build a map of frameIdx -> LabeledFrame for quick lookback
  const frameMap = new Map<number, (typeof videoFrames)[0]>();
  for (const lf of videoFrames) {
    frameMap.set(lf.frameIdx, lf);
  }

  // For each tracked instance on the current frame, draw its trail
  for (const instance of currentFrame.instances) {
    if (!instance.track) continue;

    const trackIdx = tracks.indexOf(instance.track);
    if (trackIdx === -1) continue;

    const color: RGB = getTrackColor(
      palette,
      trackIdx,
      instance.track.name,
      trackColorOverrides
    );

    // Collect centroids going back trailLength frames
    const trailPoints: Array<{ x: number; y: number; age: number }> = [];

    // Add current frame's centroid
    const currentCentroid = computeCentroid(instance);
    if (!currentCentroid) continue;
    trailPoints.push({ x: currentCentroid[0], y: currentCentroid[1], age: 0 });

    // Look back through previous frames
    for (let offset = 1; offset <= trailLength; offset++) {
      const prevFrameIdx = currentFrameIdx - offset;
      if (prevFrameIdx < 0) break;

      const prevFrame = frameMap.get(prevFrameIdx);
      if (!prevFrame) continue;

      // Find the instance with the same track
      const prevInstance = prevFrame.instances.find(
        (inst) => inst.track === instance.track
      );
      if (!prevInstance) continue;

      const centroid = computeCentroid(prevInstance);
      if (!centroid) continue;

      trailPoints.push({ x: centroid[0], y: centroid[1], age: offset });
    }

    // Draw polyline segments with fading opacity
    if (trailPoints.length < 2) continue;

    // Sort by age descending so we draw oldest first (behind)
    trailPoints.sort((a, b) => b.age - a.age);

    for (let i = 0; i < trailPoints.length - 1; i++) {
      const from = trailPoints[i];
      const to = trailPoints[i + 1];

      // Opacity based on the newer (smaller age) point of the segment
      const newerAge = Math.min(from.age, to.age);
      const opacity = 1 - newerAge / (trailLength + 1);

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = rgbToCSS(color, Math.max(0.1, opacity * 0.8));
      ctx.lineWidth = 2 / zoom;
      ctx.stroke();
    }

    // Draw small dots at each trail point
    for (const pt of trailPoints) {
      if (pt.age === 0) continue; // Skip current frame (already rendered by skeleton)
      const opacity = 1 - pt.age / (trailLength + 1);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2 / zoom, 0, Math.PI * 2);
      ctx.fillStyle = rgbToCSS(color, Math.max(0.1, opacity * 0.6));
      ctx.fill();
    }
  }
}
