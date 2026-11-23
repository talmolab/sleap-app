/**
 * Where each embedded video's images are: the dataset that holds them in the
 * project file, as the app last read or wrote that file.
 *
 * A full save writes each embedded video's images under a name of its new
 * index (`video{i}/video`), so removing a video renumbers the ones after it.
 * A video's own backend may still name the dataset it was read from (an eager
 * load keeps the images in memory, and a failed rebind keeps the old
 * backends), so the writers that copy images out of the file on disk take the
 * name from here instead:
 *
 * - It is recorded for each embedded video when a project is opened (the
 *   datasets it was read from) and after every full write of the project
 *   file (the datasets the written file's `videos_json` names).
 * - Each record belongs to one write of one file. A later write to that path
 *   makes every record of the earlier one stale: a video that was not in the
 *   later write (removed, then restored by undo) has no images under that name
 *   any more, and may have another video's.
 *
 * A video with no record (a project recovered from a draft, say) has never
 * been renumbered by this app's saves, so its backend's name is the file's.
 */
import type { Video } from "@talmolab/sleap-io.js";

interface SourceRecord {
  path: string;
  /** Null when the write's dataset for this video is unknown. */
  dataset: string | null;
  generation: number;
}

/** The latest write (or open) of each path. */
const generations = new Map<string, number>();
const records = new WeakMap<Video, SourceRecord>();

/**
 * Record that the file at `path` was just opened or written with `videos`,
 * whose embedded images are under `datasets` (by index; null for an external
 * video or an unknown name). Every earlier record for `path` goes stale. With
 * `datasets` null (the written file could not be read back), every embedded
 * video's name is unknown, so all of them are stale.
 */
export function recordEmbeddedSources(
  path: string,
  videos: readonly Video[],
  datasets: ReadonlyArray<string | null> | null
): void {
  const generation = (generations.get(path) ?? 0) + 1;
  generations.set(path, generation);
  videos.forEach((video, index) => {
    if (!video.hasEmbeddedImages) {
      records.delete(video);
      return;
    }
    records.set(video, { path, dataset: datasets?.[index] ?? null, generation });
  });
}

/** What the record says about one video's images in one file. */
export type EmbeddedSource =
  /** The file at that path holds them under `dataset`. */
  | { kind: "recorded"; dataset: string }
  /** They are not known to be in that file under any name. */
  | { kind: "stale" }
  /** No record: the app never opened or wrote a file with this video. */
  | { kind: "unknown" };

/** Where `video`'s images are in the file at `path`, as recorded. */
export function embeddedSource(video: Video, path: string): EmbeddedSource {
  const record = records.get(video);
  if (!record) return { kind: "unknown" };
  if (record.path === path && record.generation === generations.get(path) && record.dataset) {
    return { kind: "recorded", dataset: record.dataset };
  }
  return { kind: "stale" };
}
