/**
 * Helpers for "navigate labeled frames only" mode (issue #137).
 *
 * In this mode, frame stepping / playback / seekbar are confined to the frames
 * that actually have data, instead of walking the dense frame axis (which is
 * mostly dead air for sparse `pkg.slp` files). These are pure functions so the
 * stepping logic can be unit-tested in isolation: the store wires `stepLabeled`
 * into `incrementFrameIdx`, and the Seekbar uses `nearestFrameInDomain` for
 * click/drag snapping.
 */

import type { Labels, Video } from "@/types";

/**
 * Sorted, ascending list of frame indices that have a LabeledFrame for the
 * given video (any instance — user or predicted). This is the canonical
 * "included frames" source, matching GoNextLabeledFrame / GoPrevLabeledFrame.
 *
 * Structured to accept an optional per-frame predicate later (e.g. an
 * "image is actually available" gate for the deferred imaged-only sub-setting
 * in #137); today it returns every labeled frame for the video.
 */
export function labeledFrameIndices(
  labels: Labels | null,
  video: Video | null
): number[] {
  if (!labels || !video) return [];
  return labels
    .find({ video })
    .map((lf) => lf.frameIdx)
    .sort((a, b) => a - b);
}

/**
 * Step within a sorted domain of frame indices, generalizing the ±1
 * GoNext/PrevLabeledFrame wraparound to any step size.
 *
 * - Forward (`step > 0`): land on the first entry strictly greater than
 *   `current`, then advance `step - 1` more positions.
 * - Backward (`step < 0`): land on the last entry strictly less than `current`,
 *   then retreat `|step| - 1` more positions.
 * - Wraps end→start and start→end, matching the existing labeled-frame commands.
 *
 * Works whether or not `current` is itself in the domain (e.g. parked on an
 * unlabeled frame after a non-snapped scrub). Returns `null` only when the
 * domain is empty, signaling the caller to fall back to dense navigation.
 */
export function stepLabeled(
  domain: number[],
  current: number,
  step: number
): number | null {
  const n = domain.length;
  if (n === 0) return null;
  if (step === 0) return current;

  if (step > 0) {
    // Index of the first entry strictly greater than `current`; wrap to 0.
    let p = domain.findIndex((idx) => idx > current);
    if (p === -1) p = 0;
    p = (p + (step - 1)) % n;
    return domain[p];
  }

  // step < 0: index of the last entry strictly less than `current`; wrap to last.
  let p = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (domain[i] < current) {
      p = i;
      break;
    }
  }
  if (p === -1) p = n - 1;
  // (step + 1) <= 0 here; positive-modulo keeps the index in range.
  p = (((p + (step + 1)) % n) + n) % n;
  return domain[p];
}

/**
 * The entry in a sorted domain closest to `target` (by absolute frame
 * distance; ties resolve to the lower index). Used to snap seekbar clicks/drag
 * to a labeled frame in labeled-only mode — on a linear axis, nearest in frame
 * space equals nearest in pixel space. Returns `null` for an empty domain.
 */
export function nearestFrameInDomain(
  domain: number[],
  target: number
): number | null {
  const n = domain.length;
  if (n === 0) return null;
  let best = domain[0];
  let bestDist = Math.abs(domain[0] - target);
  for (let i = 1; i < n; i++) {
    const dist = Math.abs(domain[i] - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = domain[i];
    }
  }
  return best;
}
