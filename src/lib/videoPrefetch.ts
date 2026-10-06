/**
 * Policy for the video backend's read-ahead prefetch on a frame request.
 *
 * `Video.getFrame(idx, { prefetch })` lets a backend warm a read-ahead window
 * around the requested frame. Only `ImageVideoBackend` (image-sequence videos)
 * honors it today — it reads AHEAD=8 / BEHIND=2 neighbors — MP4/HDF5 backends
 * ignore the flag.
 *
 * Read-ahead only pays off for *sequential* viewing (arrow-key stepping,
 * playback), where those neighbors are about to be viewed. On a large discrete
 * jump (Next/Prev Suggestion, Next/Prev Labeled Frame, Go-to-frame) or a
 * seekbar scrub, the read-ahead frames are never viewed: on a slow (network)
 * mount their reads saturate the pipe and slow the one frame the user actually
 * asked for (~3.6x on the VAST mount). PyQt's worker likewise does no read-ahead
 * while scrubbing.
 *
 * This is a pure decision function so it can be unit-tested in isolation from
 * VideoPlayer's frame-load effect, which tracks the previous frame index and
 * calls this with the jump distance.
 */

/**
 * Max frame-index delta still treated as "sequential" (prefetch stays ON).
 *
 * Normal stepping and playback advance by ±1; a small tolerance absorbs a rare
 * double-step. Any genuine navigation jump (dozens to thousands of frames apart
 * — suggestions, labeled frames, go-to-frame) is far beyond this, so it turns
 * prefetch OFF and the wasted read-ahead never fires.
 */
export const PREFETCH_JUMP_THRESHOLD = 2;

/**
 * Whether the read-ahead prefetch should run for a move from `prev` → `next`.
 *
 * - Scrubbing → `false` (dragged-past frames are wasted reads).
 * - First load (`prev === null`) → `true` (default ON so normal sequential
 *   viewing from the start warms the window).
 * - Otherwise ON only when the jump is within `threshold` frames.
 */
export function shouldPrefetch({
  prev,
  next,
  isScrubbing,
  threshold = PREFETCH_JUMP_THRESHOLD,
}: {
  prev: number | null;
  next: number;
  isScrubbing: boolean;
  threshold?: number;
}): boolean {
  if (isScrubbing) return false;
  if (prev === null) return true;
  return Math.abs(next - prev) <= threshold;
}

/**
 * Whether VideoPlayer should trigger the backend's proactive decode-ahead after
 * painting a frame (scrub-proxy v2, Thread A).
 *
 * Decode-ahead is a PLAYBACK-only helper: it keeps the decode queue running
 * ahead of the playhead so the awaited `getFrame` is a cache hit instead of
 * blocking on a keyframe→+lookahead decode (the periodic play-freeze). It must
 * be OFF when paused (nothing to run ahead of) and OFF while scrubbing (a drag
 * wants the newest frame now, not speculative forward work — and rule #3 already
 * pauses playback on any seek, so the two shouldn't co-occur; this is a guard).
 *
 * Pure so VideoPlayer's frame-load effect can be reasoned about and this gate
 * unit-tested in isolation (mirrors {@link shouldPrefetch}).
 */
export function shouldDecodeAhead({
  isPlaying,
  isScrubbing,
}: {
  isPlaying: boolean;
  isScrubbing: boolean;
}): boolean {
  return isPlaying && !isScrubbing;
}

/**
 * Per-tick cursor velocity (frames moved between consecutive scrub rAF ticks)
 * above which the scrub is "fast" and should snap to keyframe previews instead
 * of decoding exact frames (scrub-proxy v2 keyframe-preview). Tunable: lower =
 * switch to keyframes sooner (coarser but keeps up); higher = hold exact frames
 * longer (finer but can lag on fast flings). A drag this quick outruns exact
 * decode, and precision isn't needed mid-fling — it settles to exact on release.
 */
export const FAST_SCRUB_FRAMES_PER_TICK = 8;

/**
 * Whether the current scrub tick is moving fast enough to snap to a keyframe
 * preview rather than decode the exact cursor frame. Pure so the scrub loop's
 * fast/slow decision is unit-testable. The first tick (no previous position)
 * is never "fast" — we can't measure velocity yet, so start with an exact read.
 */
export function isFastScrub({
  cursorFrame,
  prevCursorFrame,
  threshold = FAST_SCRUB_FRAMES_PER_TICK,
}: {
  cursorFrame: number;
  prevCursorFrame: number | null;
  threshold?: number;
}): boolean {
  if (prevCursorFrame === null) return false;
  return Math.abs(cursorFrame - prevCursorFrame) > threshold;
}
