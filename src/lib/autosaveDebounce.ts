/**
 * Adaptive debounce for the crash-recovery autosave.
 *
 * The draft write re-serializes the ENTIRE project (there's no incremental
 * save), so on a large project it's a multi-second main-thread block. Firing it
 * a fixed 1.5s after every edit-pause froze active editing — the freeze that
 * "lands on your next click." Instead we scale the debounce to the project's
 * serialize cost: estimated up front from the labeled-frame count (so even the
 * FIRST edit on a huge project is backed off, before any write is measured),
 * then refined by the measured last-write time. Small projects keep the snappy
 * 1.5s net; huge projects only autosave once you're genuinely idle.
 */

/** Snappy floor — small projects autosave 1.5s after edits settle. */
export const AUTOSAVE_MIN_DEBOUNCE_MS = 1500;

/** Ceiling so crash-recovery is never stalled unreasonably long. */
export const AUTOSAVE_MAX_DEBOUNCE_MS = 60_000;

/** Rough serialize cost per labeled frame, for the pre-first-write estimate.
 *  Tuned against a ~42k-frame project whose full draft write measured ~2s
 *  (42250 × 0.045 ≈ 1.9s). Only a lower bound — the measured write refines it. */
const EST_WRITE_MS_PER_FRAME = 0.045;

/** Keep autosave out of the active-editing window: wait this many times the
 *  estimated write cost so a burst of edits (each re-arming) never triggers a
 *  mid-session serialize. */
const DEBOUNCE_WRITE_MULTIPLE = 10;

/**
 * @param labeledFrameCount   `labels.labeledFrames.length` (cheap size proxy).
 * @param measuredLastWriteMs Duration of the most recent draft write (0 if none).
 * @returns debounce in ms, clamped to [MIN, MAX].
 */
export function computeAutosaveDebounceMs(
  labeledFrameCount: number,
  measuredLastWriteMs: number,
): number {
  const estWriteMs = Math.max(
    measuredLastWriteMs,
    labeledFrameCount * EST_WRITE_MS_PER_FRAME,
  );
  const debounce = estWriteMs * DEBOUNCE_WRITE_MULTIPLE;
  return Math.min(
    AUTOSAVE_MAX_DEBOUNCE_MS,
    Math.max(AUTOSAVE_MIN_DEBOUNCE_MS, debounce),
  );
}
