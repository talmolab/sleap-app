/**
 * Compare model predictions: an index of how much the models disagree on each
 * frame, for ◀ ▶ (next/previous disagreement) and the review windows.
 *
 * For every frame where two or more shown models have poses, the index keeps
 * the frame's largest node spread (see {@link nodeSpreads}). That number does
 * not depend on the threshold, so a frame "has a disagreement" exactly when
 * its largest spread is above the threshold — changing the threshold never
 * recomputes anything.
 *
 * Spreads are worked out lazily, frame by frame, and kept: ▶ does no more work
 * than looking at the frames up to the next disagreement did before, and a
 * second press (or ◀ back over the same frames) is a lookup. A background
 * warm-up ({@link fillIndex}, in small time slices) fills in the rest while
 * the user looks around, so on a long video the first jump is usually a
 * lookup too. One index per set of shown models (cached; see
 * {@link disagreementIndexFor}).
 */
import type { OverlayModel } from "@/stores/modelOverlayStore";
import type { Video } from "@/types";
import { groupAcrossModels, modelsShareTracks, nodeSpreads, type MatchLayer } from "./matching";

export interface DisagreementIndex {
  /** The shown models (for this video) the index is for. */
  readonly models: readonly OverlayModel[];
  readonly byTrack: boolean;
  /** Frames where at least two shown models have poses, ascending. */
  readonly frames: Int32Array;
  /**
   * Largest node spread on `frames[i]`, px; -Infinity when no node is placed
   * by two models; NaN = not worked out yet.
   */
  readonly maxSpread: Float64Array;
  /** How many entries of maxSpread are worked out. */
  computed: number;
}

/** Largest spread over every node of every animal placed by two or more models (-Infinity if none). */
export function frameMaxSpread(layers: readonly MatchLayer[], byTrack: boolean): number {
  let max = -Infinity;
  if (layers.length < 2) return max;
  for (const g of groupAcrossModels(layers, byTrack)) {
    let multi = false;
    for (let i = 1; i < g.length; i++) if (g[i].layer !== g[0].layer) multi = true;
    if (!multi) continue;
    const { spread } = nodeSpreads(layers, g);
    for (let k = 0; k < spread.length; k++) if (spread[k] > max) max = spread[k];
  }
  return max;
}

/** Frames where two or more of these models have poses, ascending. */
function sharedFrames(models: readonly OverlayModel[]): Int32Array {
  let total = 0;
  for (const m of models) total += m.frames.size;
  const all = new Int32Array(total);
  let i = 0;
  for (const m of models) for (const f of m.frames.keys()) all[i++] = f;
  all.sort();
  const out: number[] = [];
  for (let a = 0; a < all.length; ) {
    let b = a + 1;
    while (b < all.length && all[b] === all[a]) b++;
    if (b - a >= 2) out.push(all[a]);
    a = b;
  }
  return Int32Array.from(out);
}

function newIndex(models: readonly OverlayModel[]): DisagreementIndex {
  const frames = sharedFrames(models);
  return {
    models,
    byTrack: modelsShareTracks(models.map((m) => m.trackNames)),
    frames,
    maxSpread: new Float64Array(frames.length).fill(NaN),
    computed: 0,
  };
}

let cached: DisagreementIndex | null = null;

function sameModels(a: readonly OverlayModel[], b: readonly OverlayModel[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i].id && m.frames === b[i].frames);
}

/** The models shown on `video` (visible, matched to it). */
export function shownOn(models: readonly OverlayModel[], video: Video | null): OverlayModel[] {
  return models.filter((m) => m.visible && m.video === video);
}

/** The (cached) index for the models shown on `video`. */
export function disagreementIndexFor(models: readonly OverlayModel[], video: Video | null): DisagreementIndex {
  const shown = shownOn(models, video);
  if (cached && sameModels(cached.models, shown)) return cached;
  cached = newIndex(shown);
  return cached;
}

/** For tests: forget the cached index. */
export function clearDisagreementIndexCache(): void {
  cached = null;
}

/** Largest spread on `index.frames[row]`, working it out if needed. */
export function spreadAt(index: DisagreementIndex, row: number): number {
  const v = index.maxSpread[row];
  if (!Number.isNaN(v)) return v;
  const f = index.frames[row];
  const layers: MatchLayer[] = index.models.map((m) => ({ poses: m.frames.get(f) ?? [] }));
  const s = frameMaxSpread(
    layers.filter((l) => l.poses.length > 0),
    index.byTrack
  );
  index.maxSpread[row] = s;
  index.computed++;
  return s;
}

/** First row whose frame is > `frame` (dir 1) or the last row < `frame` (dir -1). */
function startRow(frames: Int32Array, frame: number, dir: 1 | -1): number {
  let lo = 0;
  let hi = frames.length;
  // First row with frames[row] > frame.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] > frame) hi = mid;
    else lo = mid + 1;
  }
  if (dir === 1) return lo;
  // Last row with frames[row] < frame.
  let r = lo - 1;
  while (r >= 0 && frames[r] >= frame) r--;
  return r;
}

/** The next (dir 1) or previous (dir -1) frame after `from` with a spread above `threshold`, or null. */
export function nextDisagreement(index: DisagreementIndex, threshold: number, from: number, dir: 1 | -1): number | null {
  if (index.models.length < 2) return null;
  for (let r = startRow(index.frames, from, dir); r >= 0 && r < index.frames.length; r += dir) {
    if (spreadAt(index, r) > threshold) return index.frames[r];
  }
  return null;
}

/** Work out spreads for up to `budgetMs`; true when the whole index is done. */
export function fillIndex(index: DisagreementIndex, budgetMs: number): boolean {
  const t0 = performance.now();
  const n = index.frames.length;
  let r = 0;
  while (index.computed < n) {
    // Skip rows already done (the lazy path fills them out of order).
    while (r < n && !Number.isNaN(index.maxSpread[r])) r++;
    if (r >= n) break;
    for (let k = 0; k < 64 && r < n; k++, r++) spreadAt(index, r);
    if (performance.now() - t0 > budgetMs) break;
  }
  return index.computed >= n;
}

/**
 * Fill the whole index in time slices, yielding to the UI between them.
 * Resolves true when done, false when `signal` aborted it first.
 */
export async function fillIndexAsync(
  index: DisagreementIndex,
  opts: { sliceMs?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<boolean> {
  const slice = opts.sliceMs ?? 12;
  for (;;) {
    if (opts.signal?.aborted) return false;
    const done = fillIndex(index, slice);
    opts.onProgress?.(index.computed, index.frames.length);
    if (done) return true;
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Frames with a spread above `threshold`, ascending (call after the index is filled). */
export function disagreementFrames(index: DisagreementIndex, threshold: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < index.frames.length; r++) if (spreadAt(index, r) > threshold) out.push(index.frames[r]);
  return out;
}
