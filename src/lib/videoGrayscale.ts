/**
 * Toggle Grayscale after import — port of PyQt SLEAP's `ToggleGrayscale`
 * command (`sleap/gui/commands.py`, the Videos dock's "Toggle Grayscale"
 * button).
 *
 * PyQt reads the grayscale state of the CURRENT video (or, if that one can't
 * say, the first video that can), then flips EVERY video in the project to the
 * opposite state. It does this silently: no dialog, no message. A video with
 * no open decoder (on desktop, every video not yet viewed is opened lazily)
 * is still switched: like Python sleap-io's `Video.grayscale` setter, only its
 * `backendMetadata.grayscale` is written, and the decoder picks it up when it
 * opens.
 *
 * The undo side lives here too: {@link captureGrayscaleState} records exactly
 * what a toggle changes on one `Video` (its grayscale wrapper, its
 * `backendMetadata`, and its frozen shape override), and
 * {@link applyGrayscaleState} puts it back — re-wrapping the video's CURRENT
 * inner decoder, so an undo never resurrects a decoder that has since been
 * swapped out (e.g. by the background worker-decode upgrade).
 */

import { GrayscaleVideoBackend } from "@talmolab/sleap-io.js";
import type { Video } from "../types";

type Shape = [number, number, number, number];

/** What one toggle changes on a video, captured so it can be put back. */
export interface GrayscaleState {
  video: Video;
  /**
   * The grayscale wrapper's setting, or `undefined` when the backend was not
   * wrapped at all (a video imported without any grayscale choice).
   */
  wrap: boolean | null | undefined;
  /** A copy of `video.backendMetadata` (where the `.slp` reads `grayscale` from). */
  metadata: Record<string, unknown>;
  /** `Video`'s explicit shape override (`_shape`), or `undefined` when unset. */
  shapeOverride: Shape | null | undefined;
}

/** `Video` keeps an explicit shape override in a private `_shape` field. */
function shapeOverrideOf(video: Video): Shape | null | undefined {
  return (video as unknown as { _shape?: Shape | null })._shape;
}

/** Record the parts of `video` a grayscale toggle changes. */
export function captureGrayscaleState(video: Video): GrayscaleState {
  const backend = video.backend;
  const override = shapeOverrideOf(video);
  return {
    video,
    wrap:
      backend instanceof GrayscaleVideoBackend ? backend.grayscale : undefined,
    metadata: { ...(video.backendMetadata as Record<string, unknown>) },
    shapeOverride: override ? ([...override] as Shape) : override,
  };
}

/** Put a video back the way {@link captureGrayscaleState} found it. */
export function applyGrayscaleState(state: GrayscaleState): void {
  const { video } = state;
  const backend = video.backend;
  if (backend) {
    const inner =
      backend instanceof GrayscaleVideoBackend ? backend.inner : backend;
    video.backend =
      state.wrap === undefined
        ? inner
        : GrayscaleVideoBackend.wrap({ inner, grayscale: state.wrap });
  }
  video.backendMetadata = { ...state.metadata };
  video.shape = state.shapeOverride
    ? ([...state.shapeOverride] as Shape)
    : null;
}

/** A video's grayscale state, or null when it can't be read (PyQt's `try`). */
function readGrayscale(video: Video | null | undefined): boolean | null {
  if (!video) return null;
  try {
    return video.grayscale;
  } catch {
    return null;
  }
}

/**
 * The state PyQt bases the toggle on: the current video's grayscale, else the
 * first video in the project that reports one. Null when none can say.
 */
export function grayscaleToToggleFrom(
  videos: readonly Video[],
  current: Video | null
): boolean | null {
  const fromCurrent = readGrayscale(current);
  if (fromCurrent !== null) return fromCurrent;
  for (const video of videos) {
    const g = readGrayscale(video);
    if (g !== null) return g;
  }
  return null;
}

/**
 * Force `video` to `value`, keeping its frozen shape override (when it has one)
 * in step: `Video.shape` returns the override first, and `Video.grayscale`
 * reads the channel count off that shape, so a stale override would make the
 * next toggle read the old state and flip the wrong way.
 */
export function setVideoGrayscale(video: Video, value: boolean): void {
  if (!video.backend) {
    // Not opened (lazy) or missing: Python's setter just records the value.
    // The recorded shape's channel count follows, so the saved .slp agrees.
    const meta = { ...(video.backendMetadata as Record<string, unknown>) };
    meta.grayscale = value;
    const shape = meta.shape as number[] | undefined;
    if (Array.isArray(shape) && shape.length === 4) {
      meta.shape = [shape[0], shape[1], shape[2], value ? 1 : 3];
    }
    video.backendMetadata = meta;
    const override = shapeOverrideOf(video);
    if (override) {
      video.shape = [override[0], override[1], override[2], value ? 1 : 3];
    }
    return;
  }
  video.grayscale = value;
  const override = shapeOverrideOf(video);
  if (override) {
    const channels = video.backend?.shape?.[3] ?? (value ? 1 : 3);
    video.shape = [override[0], override[1], override[2], channels];
  }
}

/** Result of {@link toggleGrayscaleAll}: what changed, for undo/redo. */
export interface GrayscaleToggle {
  /** The value every video was switched to. */
  value: boolean;
  before: GrayscaleState[];
  after: GrayscaleState[];
}

/**
 * Flip every video to the opposite of {@link grayscaleToToggleFrom}'s state —
 * PyQt's `ToggleGrayscale.do_action`. Throws PyQt's own messages when there is
 * nothing to toggle. Every video is switched (see {@link setVideoGrayscale});
 * one that still throws is skipped with PyQt's console note.
 */
export function toggleGrayscaleAll(
  videos: readonly Video[],
  current: Video | null
): GrayscaleToggle {
  if (videos.length === 0) {
    throw new Error("No videos detected in `Labels`.");
  }
  const grayscale = grayscaleToToggleFrom(videos, current);
  if (grayscale === null) throw new Error("No videos support grayscale.");

  const value = !grayscale;
  const before: GrayscaleState[] = [];
  const after: GrayscaleState[] = [];
  videos.forEach((video, idx) => {
    const prior = captureGrayscaleState(video);
    try {
      setVideoGrayscale(video, value);
    } catch {
      const kind = video.backend?.constructor?.name ?? "None";
      console.warn(
        `This video type ${kind} for video at index ${idx} ` +
          `does not support grayscale yet.`
      );
      return;
    }
    before.push(prior);
    after.push(captureGrayscaleState(video));
  });
  return { value, before, after };
}
