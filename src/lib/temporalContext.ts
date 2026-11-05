/**
 * Neighboring frames in the magnifier (temporal loupe): while the magnifier is
 * up, it loops through the ±N frames around the current one, drawing each
 * frame's own poses over its pixels, so you see the motion without leaving
 * the frame being labeled.
 *
 * Pure functions only; VideoPlayer does the frame reads and drawing.
 */

import type { RenderedInstance } from "@/canvas/SkeletonRenderer";

/** Tint for frames before the current one. */
export const PAST_TINT: readonly [number, number, number] = [239, 68, 68];
/** Tint for frames after the current one. */
export const FUTURE_TINT: readonly [number, number, number] = [59, 130, 246];

/** Which side(s) of the current frame to show. */
export interface NeighborDirections {
  earlier: boolean;
  later: boolean;
}

const BOTH_DIRECTIONS: NeighborDirections = { earlier: true, later: true };

/**
 * Indices of the neighbor frames in the ±window around `frameIdx`, nearest
 * first (−1, +1, −2, +2, …), on the side(s) `directions` allows. Frames past
 * either end of the video are left out. `numFrames` null means the length is
 * unknown, so only the start is clamped.
 */
export function neighborFrameIndices(
  frameIdx: number,
  window: number,
  numFrames: number | null,
  directions: NeighborDirections = BOTH_DIRECTIONS
): number[] {
  const out: number[] = [];
  for (let d = 1; d <= window; d++) {
    for (const idx of [frameIdx - d, frameIdx + d]) {
      if (idx < frameIdx ? !directions.earlier : !directions.later) continue;
      if (idx < 0) continue;
      if (numFrames !== null && idx >= numFrames) continue;
      out.push(idx);
    }
  }
  return out;
}

/**
 * Offsets the loupe steps through, as one loop: from the current frame out to
 * +N and back, then out to −N and back; the loop then restarts at 0. A side
 * with no frames (not chosen, or past an end of the video) is skipped, so the
 * current frame never shows twice in a row. Just [0] with no neighbors.
 */
export function loupeOffsets(available: readonly number[]): number[] {
  const set = new Set(available);
  const ahead = [...set].filter((o) => o > 0).sort((a, b) => a - b);
  const behind = [...set].filter((o) => o < 0).sort((a, b) => b - a);
  const out = [0];
  if (ahead.length > 0) out.push(...ahead, ...ahead.slice(0, -1).reverse());
  if (behind.length > 0) {
    if (ahead.length > 0) out.push(0);
    out.push(...behind, ...behind.slice(0, -1).reverse());
  }
  return out;
}

/**
 * Why the loupe has nothing to show on a chosen side — the current frame is
 * at the start or end of the video — so the magnifier can say so instead of
 * silently showing only the current frame. Null when every chosen side has
 * frames (or no side is chosen).
 */
export function missingSideNote(
  directions: NeighborDirections,
  hasEarlier: boolean,
  hasLater: boolean
): string | null {
  const noEarlier = directions.earlier && !hasEarlier;
  const noLater = directions.later && !hasLater;
  if (noEarlier && noLater) return "no other frames";
  if (noEarlier) return "no earlier frames";
  if (noLater) return "no later frames";
  return null;
}

/** Slider label for the window size, worded for the chosen side(s). */
export function windowLabel(directions: NeighborDirections): string {
  if (directions.earlier && !directions.later) return "Frames before";
  if (directions.later && !directions.earlier) return "Frames after";
  return "Frames each side";
}

/** Label for an offset: "current", "+1", "−2" (true minus sign). */
export function offsetLabel(offset: number): string {
  if (offset === 0) return "current";
  return offset > 0 ? `+${offset}` : `−${-offset}`;
}

/** A pose from a neighbor frame, for the loupe to draw over that frame. */
export interface NeighborPose {
  /** Frame offset from the current frame (nonzero). */
  offset: number;
  instance: RenderedInstance;
}

/**
 * How long the loupe shows each frame, the same for every window size (a
 * bigger window just makes the loop longer). Matches lightning-pose's labeler.
 */
export const LOUPE_STEP_MS = 300;
