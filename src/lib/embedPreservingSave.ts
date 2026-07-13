/**
 * Embed-preserving save support for pkg.slp projects.
 *
 * sleap-io.js `saveSlpToBytes` defaults `embed` to `false`, which writes the
 * `videos_json` metadata WITHOUT the embedded image datasets — so re-saving a
 * pkg.slp would silently drop every embedded frame, and a plain in-place Save
 * destroys the only copy of the images (#213).
 *
 * Until sleap-io.js grows a "preserve existing embedding" mode, the closest
 * option is `embed: "user+suggestions"`. That mode embeds every suggestion
 * frame plus labeled frames that have user *skeleton* instances — but NOT
 * frames whose only user labeling is frame-level (centroids, bounding boxes,
 * masks), and not previously-embedded frames that are neither labeled nor
 * suggested. To make the save lossless, {@link planEmbedPreservingSave}
 * temporarily registers every previously-embedded frame that the mode would
 * miss as a `SuggestionFrame` for the duration of the save; `restore()` puts
 * `labels.suggestions` back afterwards. The saved file consequently lists
 * those frames as suggestions — a deliberate trade-off: a spurious suggestion
 * is visible and recoverable, a dropped image is not.
 */

import { SuggestionFrame } from "@talmolab/sleap-io.js";
import type { Labels, Video } from "@talmolab/sleap-io.js";

export interface EmbedSavePlan {
  /** `embed` option for `saveSlpToBytes` (`false` when nothing is embedded). */
  embed: "user+suggestions" | false;
  /**
   * Embedded videos whose image set cannot be read (backend missing/closed, or
   * the embedded frame numbers are unknown). Saving drops their images, so
   * callers must not overwrite the original file in place while this is
   * non-empty.
   */
  unreadable: Video[];
  /** Remove the temporarily-added suggestions. Idempotent. */
  restore: () => void;
}

/**
 * Prepare `labels` for an embed-preserving save.
 *
 * Must be called (and its `restore` run in a `finally`) around
 * `saveSlpToBytes` whenever the project may contain embedded videos.
 */
export async function planEmbedPreservingSave(
  labels: Labels
): Promise<EmbedSavePlan> {
  const embeddedVideos = labels.videos.filter((v) => v.hasEmbeddedImages);
  if (embeddedVideos.length === 0) {
    return { embed: false, unreadable: [], restore: () => {} };
  }

  const unreadable: Video[] = [];
  const added: SuggestionFrame[] = [];

  for (const video of embeddedVideos) {
    // A deferred (lazyVideoMetadata) backend only reads its frame_numbers
    // dataset once loaded; without this, embeddedFrameIndices is null below
    // and the video would be misreported as unreadable.
    const backend = video.backend as {
      ensureLoaded?: () => Promise<void>;
    } | null;
    if (backend?.ensureLoaded) {
      try {
        await backend.ensureLoaded();
      } catch {
        /* judged by the frameNumbers check below */
      }
    }

    const frameIndices = video.embeddedFrameIndices;
    if (!video.backend || frameIndices == null) {
      unreadable.push(video);
      continue;
    }

    // Frames "user+suggestions" already embeds for this video.
    const covered = new Set<number>();
    for (const s of labels.suggestions) {
      if (s.video === video) covered.add(s.frameIdx);
    }
    for (const lf of labels.labeledFrames) {
      if (lf.video === video && lf.hasUserInstances) covered.add(lf.frameIdx);
    }

    for (const frameIdx of frameIndices) {
      if (!covered.has(frameIdx)) {
        const sf = new SuggestionFrame({ video, frameIdx });
        labels.suggestions.push(sf);
        added.push(sf);
      }
    }
  }

  const restore = () => {
    if (added.length === 0) return;
    const addedSet = new Set<SuggestionFrame>(added);
    for (let i = labels.suggestions.length - 1; i >= 0; i--) {
      if (addedSet.has(labels.suggestions[i])) labels.suggestions.splice(i, 1);
    }
    added.length = 0;
  };

  return { embed: "user+suggestions", unreadable, restore };
}
