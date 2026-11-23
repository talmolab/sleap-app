/**
 * What the fast in-place save (`saveLabelsInPlace.ts`) knows about the file it
 * would patch: which file the loaded labels were last read from or written
 * to, as it was then, and which loaded video is which entry of that file.
 *
 * The in-place save patches only the label tables and keeps the file's
 * `videos_json` and embedded images, so the frames table's video indices must
 * still mean the same videos. Comparing the file's video entries with the
 * loaded videos by name or shape can't prove that: after the app's own full
 * rewrite renumbers the embedded datasets, an undo can bring back a removed
 * video whose old dataset name now belongs to another video, and another
 * program can replace the file with one of the same layout. So:
 *
 * - The file must be the one the app last read or wrote: its size,
 *   modification time and (where the platform gives them) inode and device
 *   are recorded when the project is opened, after every full rewrite, and
 *   after each verified in-place save, and must still match.
 * - The loaded video list must map one to one, in order, onto that file's
 *   entries, by object identity: each Video is recorded with the index and,
 *   when embedded, the dataset it has in that file. A video the map doesn't
 *   know (restored by undo after a rewrite, or a replaced video), another
 *   order or another count refuses.
 *
 * No binding (a project opened some other way, a stat that failed, a full
 * rewrite whose video list changed while it ran) refuses the in-place save:
 * the full re-save is always correct, and records a binding.
 */
import type { Labels, Video } from "@talmolab/sleap-io.js";
import { diskBackendOf, hasDiskBackedVideos } from "@/lib/diskBackedVideos";
import { toast } from "@/lib/notify";

/** A file as the app last read or wrote it. */
export interface FileIdentity {
  size: number;
  mtimeMs: number;
  /** Inode and device (Unix), when the platform reports them. */
  ino?: number | null;
  dev?: number | null;
}

/** Where a loaded video sits in the bound file. */
export interface VideoBinding {
  index: number;
  /** The dataset of its embedded images; null for an external video, or an
   *  embedded one whose dataset is unknown (the in-place save then refuses). */
  dataset: string | null;
}

interface FileBinding {
  path: string;
  identity: FileIdentity;
  count: number;
  videos: WeakMap<Video, VideoBinding>;
}

const bindings = new WeakMap<Labels, FileBinding>();

/**
 * The size, modification time, inode and device of `path` (desktop), or null
 * when size or time can't be read: no binding is recorded then, and the
 * in-place save refuses.
 */
export async function statFileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const info = (await stat(path)) as {
      size?: number;
      mtime?: Date | string | number | null;
      ino?: number | null;
      dev?: number | null;
    };
    const mtimeMs = info.mtime ? new Date(info.mtime).getTime() : NaN;
    if (typeof info.size !== "number" || !Number.isFinite(mtimeMs)) return null;
    return {
      size: info.size,
      mtimeMs,
      ino: typeof info.ino === "number" ? info.ino : null,
      dev: typeof info.dev === "number" ? info.dev : null,
    };
  } catch {
    return null;
  }
}

/** Same size and time, and same inode and device where both sides have them. */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  const same = (x: number | null | undefined, y: number | null | undefined) =>
    x == null || y == null || x === y;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && same(a.ino, b.ino) && same(a.dev, b.dev);
}

/** The dataset an embedded video's images were read from, as loaded. */
export function loadedVideoDataset(video: Video): string | null {
  const b = video.backend as { dataset?: unknown; inner?: { dataset?: unknown } } | null;
  const fromBackend = b?.dataset ?? b?.inner?.dataset;
  if (typeof fromBackend === "string" && fromBackend) return fromBackend;
  const fromMetadata = (video.backendMetadata as { dataset?: unknown } | undefined)?.dataset;
  return typeof fromMetadata === "string" && fromMetadata ? fromMetadata : null;
}

/** The same Video objects, in the same order. */
export function sameVideoList(a: readonly Video[], b: readonly Video[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Record that `labels` match the file at `path`, as it is now (`identity`).
 * `datasets` gives each embedded video's dataset in the file, by index (null
 * for an external video): "loaded" takes the ones the videos were read from.
 * A null identity clears the binding instead.
 */
export function bindLabelsToFile(
  labels: Labels,
  path: string,
  identity: FileIdentity | null,
  datasets: "loaded" | ReadonlyArray<string | null>
): void {
  if (!identity) {
    bindings.delete(labels);
    return;
  }
  const videos = new WeakMap<Video, VideoBinding>();
  labels.videos.forEach((video, index) => {
    const dataset = !video.hasEmbeddedImages
      ? null
      : datasets === "loaded"
        ? loadedVideoDataset(video)
        : (datasets[index] ?? null);
    videos.set(video, { index, dataset });
  });
  bindings.set(labels, { path, identity, count: labels.videos.length, videos });
}

/** Forget the binding: the in-place save refuses until the next one. */
export function clearFileBinding(labels: Labels): void {
  bindings.delete(labels);
}

/** After a verified in-place save: the file's new identity. */
export function refreshFileIdentity(labels: Labels, identity: FileIdentity | null): void {
  const binding = bindings.get(labels);
  if (!binding) return;
  if (!identity) bindings.delete(labels);
  else binding.identity = identity;
}

/**
 * True when `labels` have a record for `path` and the file is no longer the
 * one recorded (changed on disk since the app last read or wrote it, or its
 * size and time can't be read). False without a record: nothing to compare.
 */
export function recordedFileChanged(
  labels: Labels,
  path: string,
  current: FileIdentity | null
): boolean {
  const binding = bindings.get(labels);
  if (!binding || binding.path !== path) return false;
  return !current || !sameFileIdentity(binding.identity, current);
}

/** Why `labels` may not be patched into `path` in place, or null if they may. */
export function bindingRefusal(
  labels: Labels,
  path: string,
  current: FileIdentity | null
): string | null {
  const binding = bindings.get(labels);
  if (!binding || binding.path !== path) {
    return "the app has no record of this file as it last read or wrote it — full re-save";
  }
  if (!current || !sameFileIdentity(binding.identity, current)) {
    return "the file changed on disk since the app last read or wrote it — full re-save";
  }
  if (labels.videos.length !== binding.count) {
    return "the video list changed since the file was last read or written — full re-save";
  }
  for (const [index, video] of labels.videos.entries()) {
    const known = binding.videos.get(video);
    if (!known || known.index !== index) {
      return "the video list changed since the file was last read or written — full re-save";
    }
    if (video.hasEmbeddedImages && !known.dataset) {
      return "an embedded video's dataset is unknown — full re-save";
    }
  }
  return null;
}

/** The bound dataset of each loaded video (null when external or unknown). */
export function boundDatasets(labels: Labels): Array<string | null> {
  const binding = bindings.get(labels);
  return labels.videos.map((video) => binding?.videos.get(video)?.dataset ?? null);
}

// ---------------------------------------------------------------------------
// Embedded videos read under names the file no longer has
// ---------------------------------------------------------------------------

const staleNames = new WeakSet<Labels>();

/**
 * Mark labels whose embedded videos read their images from the project file
 * on disk (a large file's open) after that file was replaced: by a full save
 * or an export over it, or by another program. Such a reader keeps the old
 * file's layout and reads the new file's bytes at the old offsets, whatever
 * the dataset names (see diskBackedVideos.ts). Their images, and any writer
 * that copies them (full saves, package exports, clips, training copies),
 * could be wrong: those are refused until the project is reopened (the
 * in-place save, which keeps the images, still runs). A rebind of the
 * backends onto the new file clears the mark (see rebindEmbeddedVideos.ts).
 */
export function markStaleVideoNames(labels: Labels): void {
  staleNames.add(labels);
}

export function hasStaleVideoNames(labels: Labels): boolean {
  return staleNames.has(labels);
}

/**
 * Clear the mark once every embedded video that reads the file on disk reads
 * it by the names the file gives it (after a full save rebound them; see
 * rebindEmbeddedVideos.ts).
 */
export function clearStaleVideoNames(labels: Labels): void {
  staleNames.delete(labels);
}

/**
 * Whether a video's backend reads its images from the project file on disk
 * by dataset name: noted at a large file's open (see diskBackedVideos.ts).
 */
export function readsProjectFile(video: Video): boolean {
  return diskBackendOf(video) !== null;
}

/** What the app says when it won't copy images read under stale names. */
export const STALE_VIDEO_NAMES_MESSAGE =
  "This project reads its embedded images from its file on disk, and that file was " +
  "replaced since it was opened (by a save or an export over it, or by another program), " +
  "so the images it reads are no longer the right ones. Reopen the project first. " +
  "Nothing was written.";

/**
 * Tell the user, once marked, that the project must be reopened: the images
 * shown may be wrong, and writers that copy them wait until then.
 */
export function warnStaleVideoNames(): void {
  toast.warning("Reopen this project before you continue", {
    id: "stale-video-names",
    description:
      "Its file was replaced, and the open project still reads its embedded images through " +
      "the old file's layout: the images shown may be wrong until you reopen. Saves that " +
      "keep the video list still work; full saves, exports and training copies wait until " +
      "then.",
    duration: Infinity,
  });
}

/**
 * Refuse, with an error note, a writer that would copy the embedded images
 * of labels marked with stale video names (exports, saves). True if refused.
 */
export function refuseStaleVideoNames(labels: Labels | null | undefined, title: string): boolean {
  if (!labels || !hasStaleVideoNames(labels)) return false;
  toast.error(title, { description: STALE_VIDEO_NAMES_MESSAGE });
  return true;
}

/**
 * The project's own file was replaced by something other than a save (an
 * export written over it): the in-place save must not patch it, and if the
 * project reads its images from that file, they are no longer the right ones
 * until its videos are rebound to the new file. Marks them until then; the
 * caller rebinds (`rebindAfterExportOverProject`), which clears the mark, or
 * warns and keeps it.
 */
export function projectFileReplaced(labels: Labels): void {
  clearFileBinding(labels);
  if (hasDiskBackedVideos(labels)) markStaleVideoNames(labels);
}

/** Throw for a job that would copy embedded images under stale names. */
export function assertNoStaleVideoNames(labels: Labels): void {
  if (hasStaleVideoNames(labels)) throw new Error(STALE_VIDEO_NAMES_MESSAGE);
}
