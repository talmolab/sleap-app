/**
 * Cache for the per-video "navigation domain" (Cluster B perf).
 *
 * The navigation domains — sorted labeled / user-labeled / track-spawn frame
 * indices for a video — are a pure function of (labels content, video). Without
 * caching, every arrow-key step, every playback tick, and every seekbar repaint
 * re-ran a full `labels.find({ video })` scan + sort over the whole project when
 * only a neighbor was needed (choppy on many-thousand-frame projects).
 *
 * The `labels` object is mutated in place, so its reference alone can't tell us
 * when content changed. The app's `editSeq` counter can: `markChanged()` bumps
 * it on every label/track edit (and it defers to a single bump per drag gesture,
 * #329), so `(labels ref, video ref, editSeq)` uniquely identifies the
 * labeled-frame set. We memoize each domain against that key. A cache hit
 * returns the SAME array object — callers (stepLabeled / nearestFrameInDomain /
 * the seekbar marks) only ever READ it, so sharing the array is safe and is the
 * whole point; do not mutate a returned domain.
 *
 * A single slot is enough: navigation is dominated by stepping/playing within
 * one active video, so switching video (or bumping editSeq) simply resets it —
 * no multi-video LRU needed.
 */

import type { Labels, Video } from "@/types";
import {
  navigableDomain,
  allLabeledFrameIndices,
  userLabeledFrameIndices,
  trackSpawnFrameIndices,
  type NavigationDomain,
} from "./navigableFrames";

interface DomainSlot {
  labels: Labels;
  video: Video;
  editSeq: number;
  /** Cached `navigableDomain` result per mode (value may be `null`). */
  navigable: Map<NavigationDomain, number[] | null>;
  allLabeled?: number[];
  user?: number[];
  trackSpawn?: number[];
}

let slot: DomainSlot | null = null;

/** The live slot for this key, freshly reset if the key changed. */
function slotFor(labels: Labels, video: Video, editSeq: number): DomainSlot {
  if (
    !slot ||
    slot.labels !== labels ||
    slot.video !== video ||
    slot.editSeq !== editSeq
  ) {
    slot = { labels, video, editSeq, navigable: new Map() };
  }
  return slot;
}

/**
 * Cached mirror of {@link navigableDomain} (mode → frame-index domain, or
 * `null` for "no restriction"). Used by `incrementFrameIdx` (arrow keys +
 * playback) and the seekbar's snap domain.
 */
export function cachedNavigableDomain(
  labels: Labels | null,
  video: Video | null,
  mode: NavigationDomain,
  editSeq: number
): number[] | null {
  // Nothing to key on / cheap degenerate case — don't cache.
  if (!labels || !video) return navigableDomain(labels, video, mode);
  const s = slotFor(labels, video, editSeq);
  if (!s.navigable.has(mode)) {
    s.navigable.set(mode, navigableDomain(labels, video, mode));
  }
  return s.navigable.get(mode) ?? null;
}

/** Cached mirror of {@link allLabeledFrameIndices} (GoNext/PrevLabeledFrame). */
export function cachedAllLabeledFrameIndices(
  labels: Labels | null,
  video: Video | null,
  editSeq: number
): number[] {
  if (!labels || !video) return [];
  const s = slotFor(labels, video, editSeq);
  if (s.allLabeled === undefined) {
    s.allLabeled = allLabeledFrameIndices(labels, video);
  }
  return s.allLabeled;
}

/** Cached mirror of {@link userLabeledFrameIndices} (GoNext/PrevUserFrame). */
export function cachedUserFrameIndices(
  labels: Labels | null,
  video: Video | null,
  editSeq: number
): number[] {
  if (!labels || !video) return [];
  const s = slotFor(labels, video, editSeq);
  if (s.user === undefined) {
    s.user = userLabeledFrameIndices(labels, video);
  }
  return s.user;
}

/** Cached mirror of {@link trackSpawnFrameIndices} (GoNextTrackSpawnFrame). */
export function cachedTrackSpawnFrames(
  labels: Labels | null,
  video: Video | null,
  editSeq: number
): number[] {
  if (!labels || !video) return [];
  const s = slotFor(labels, video, editSeq);
  if (s.trackSpawn === undefined) {
    s.trackSpawn = trackSpawnFrameIndices(labels, video);
  }
  return s.trackSpawn;
}

/** Drop the cache (a new project load, or test hygiene). */
export function resetNavigationDomainCache(): void {
  slot = null;
}
