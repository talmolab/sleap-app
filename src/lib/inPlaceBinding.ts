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
 * - The file must be the one the app last read or wrote: its size and
 *   modification time are recorded when the project is opened, after every
 *   full rewrite, and after each verified in-place save, and must still match.
 * - The loaded video list must map one to one, in order, onto that file's
 *   entries, by object identity: each Video is recorded with the index (and,
 *   when embedded, the dataset) it had in that file. A video the map doesn't
 *   know (restored by undo after a rewrite, or a replaced video), another
 *   order or another count refuses.
 *
 * No binding (a project opened some other way, a stat that failed) refuses the
 * in-place save: the full re-save is always correct, and records a binding.
 */
import type { Labels, Video } from "@talmolab/sleap-io.js";

/** A file as the app last read or wrote it. */
export interface FileIdentity {
  size: number;
  mtimeMs: number;
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
 * The size and modification time of `path` (desktop), or null when they
 * can't be read: no binding is recorded then, and the in-place save refuses.
 */
export async function statFileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(path);
    const mtimeMs = info.mtime ? new Date(info.mtime).getTime() : NaN;
    if (typeof info.size !== "number" || !Number.isFinite(mtimeMs)) return null;
    return { size: info.size, mtimeMs };
  } catch {
    return null;
  }
}

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The dataset an embedded video's images were read from, as loaded. */
export function loadedVideoDataset(video: Video): string | null {
  const b = video.backend as { dataset?: unknown; inner?: { dataset?: unknown } } | null;
  const fromBackend = b?.dataset ?? b?.inner?.dataset;
  if (typeof fromBackend === "string" && fromBackend) return fromBackend;
  const fromMetadata = (video.backendMetadata as { dataset?: unknown } | undefined)?.dataset;
  return typeof fromMetadata === "string" && fromMetadata ? fromMetadata : null;
}

/**
 * Record that `labels` match the file at `path`, as it is now (`identity`):
 *  - "loaded": they were just read from it; each embedded video's dataset is
 *    the one it was read from.
 *  - "written": they were just written to it in full; sleap-io.js stores the
 *    images of the video at index i in `video{i}/video`.
 * A null identity clears the binding instead.
 */
export function bindLabelsToFile(
  labels: Labels,
  path: string,
  identity: FileIdentity | null,
  how: "loaded" | "written"
): void {
  if (!identity) {
    bindings.delete(labels);
    return;
  }
  const videos = new WeakMap<Video, VideoBinding>();
  labels.videos.forEach((video, index) => {
    const dataset = !video.hasEmbeddedImages
      ? null
      : how === "written"
        ? `video${index}/video`
        : loadedVideoDataset(video);
    videos.set(video, { index, dataset });
  });
  bindings.set(labels, { path, identity, count: labels.videos.length, videos });
}

/** Forget the binding: the in-place save refuses until the next one. */
export function clearFileBinding(labels: Labels): void {
  bindings.delete(labels);
}

/** After a verified in-place save: the file's new size and time. */
export function refreshFileIdentity(labels: Labels, identity: FileIdentity | null): void {
  const binding = bindings.get(labels);
  if (!binding) return;
  if (!identity) bindings.delete(labels);
  else binding.identity = identity;
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
