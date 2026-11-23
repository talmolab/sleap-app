/**
 * After a full save, point the open project's embedded videos at the file just
 * written.
 *
 * A project file over the eager-load limit is opened with backends that read
 * each embedded video's images from the file on disk, by dataset name, through
 * one range reader (sleap-io.js `StreamingHdf5VideoBackend`, built per video
 * from `videos_json` by `readSlpStreaming`). A full save replaces that file
 * and writes each embedded video under a name of its new index
 * (`video{i}/video`), so after removing a video the old names belong to other
 * videos, and the reader's view of the file is the old one. Left alone, the
 * views would show another video's images and the next full save would copy
 * them.
 *
 * So after every full save (over the project file, and Save As), each written
 * embedded video that reads the file on disk gets a new backend: on its name in
 * the written file's `videos_json`, through one new range reader on that file,
 * built as the loader builds them (deferred: per-video metadata is read on
 * first use). It replaces the old backend inside any grayscale or crop
 * wrapper, at the same video, and the old backends and their reader are
 * closed. Before anything is swapped, the new backends are checked: names must
 * be unique among the embedded videos, and a video whose stored frames were
 * known must find the same frame numbers under its new name. Any failure
 * leaves the old backends in place (the caller then refuses further full
 * saves until the project is reopened).
 *
 * Eager loads keep the whole file in memory: their backends (the same
 * class, over a reader of the file's bytes) keep reading the file as it was
 * opened, by the names it had then, so they need nothing here. Only readers
 * noted as reading the disk (`diskBackedVideos.ts`: a large file's open, and
 * the ones opened here) are rebound.
 */
import {
  StreamingH5File,
  StreamingHdf5VideoBackend,
  type Labels,
  type Video,
  type VideoBackend,
} from "@talmolab/sleap-io.js";
import { fileSize, readRange } from "./nativeRange";
import { embeddedSource } from "./embeddedVideoSources";
import { diskBackendOf, markDiskReader, readerOf } from "./diskBackedVideos";

/** A wrapper backend (grayscale, crop) around another one. */
interface Wrapper {
  inner: VideoBackend;
  filename?: string;
}

// Same derivation as loadProject.ts: h5wasm is served same-origin so the
// streaming Worker can load it under cross-origin isolation.
const H5WASM_URL =
  typeof location !== "undefined" ? `${location.origin}/h5wasm/h5wasm.js` : undefined;

/**
 * The first embedded video of `labels` whose images can't be read for a full
 * save from `sourcePath`: it reads the file on disk, and the record says its
 * images aren't in that file (it was removed before a full save, then
 * restored by undo). Null when there is none.
 */
export function unreadableEmbeddedVideo(labels: Labels, sourcePath: string): Video | null {
  return (
    labels.videos.find(
      (video) =>
        video.hasEmbeddedImages &&
        diskBackendOf(video) !== null &&
        embeddedSource(video, sourcePath).kind === "stale"
    ) ?? null
  );
}

export type RebindResult = { ok: true; rebound: number } | { ok: false; reason: string };

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

function groupOf(dataset: string): string {
  return dataset.endsWith("/video") ? dataset.slice(0, -"/video".length) : dataset;
}

/**
 * Rebind the embedded videos of `written` (the list a full save just wrote to
 * `path`, in order) that read a file on disk to their datasets in that file
 * (`datasets`, by index, from its `videos_json`; null if it couldn't be read).
 * `labels` are the open project's, whose videos decide which old readers are
 * still in use. Never throws.
 */
export async function rebindEmbeddedVideos(
  labels: Labels,
  path: string,
  written: readonly Video[],
  datasets: ReadonlyArray<string | null> | null
): Promise<RebindResult> {
  const targets = written.flatMap((video, index) => {
    const disk = video.hasEmbeddedImages ? diskBackendOf(video) : null;
    return disk
      ? [
          {
            video,
            index,
            leaf: disk.leaf as StreamingHdf5VideoBackend,
            parent: disk.parent as Wrapper | null,
          },
        ]
      : [];
  });
  if (targets.length === 0) return { ok: true, rebound: 0 };
  if (!datasets || datasets.length !== written.length) {
    return { ok: false, reason: "the written file's video list could not be read back" };
  }
  const names = written.flatMap((video, i) =>
    video.hasEmbeddedImages && datasets[i] ? [datasets[i]] : []
  );
  if (new Set(names).size !== names.length) {
    return { ok: false, reason: "two embedded videos have the same dataset in the written file" };
  }

  let reader: StreamingH5File | null = new StreamingH5File();
  try {
    await reader.openRange(
      { size: await fileSize(path), readRange: (offset, length) => readRange(path, offset, length) },
      { h5wasmUrl: H5WASM_URL, filenameHint: path }
    );
    const groups = new Set(reader.keys());
    const built: Array<(typeof targets)[number] & { dataset: string; next: StreamingHdf5VideoBackend }> =
      [];
    for (const target of targets) {
      const dataset = datasets[target.index];
      if (!dataset) {
        return { ok: false, reason: `video ${target.index}'s dataset in the written file is unknown` };
      }
      const old = target.leaf;
      const next = new StreamingHdf5VideoBackend({
        filename: path,
        h5file: reader,
        datasetPath: dataset,
        format: old.embeddedFormat,
        channelOrder: old.embeddedChannelOrder,
        shape: old.shape ? [...old.shape] : undefined,
        fps: old.fps,
        deferred: true,
      });
      // A video whose stored frames were read must find the same ones.
      if (old.isLoaded) {
        if (old.frameNumbers.length > 0 && !groups.has(groupOf(dataset))) {
          return { ok: false, reason: `${dataset} is not in the written file` };
        }
        await next.ensureLoaded();
        if (!sameNumbers(next.frameNumbers, old.frameNumbers)) {
          return {
            ok: false,
            reason: `${dataset} in the written file doesn't hold video ${target.index}'s frames`,
          };
        }
      }
      built.push({ ...target, dataset, next });
    }

    // Swap them in, keeping each video's wrappers.
    for (const { video, parent, leaf, dataset, next } of built) {
      if (parent) {
        parent.inner = next;
        if (parent.filename === leaf.filename) parent.filename = next.filename;
      } else {
        video.backend = next;
      }
      (video.backendMetadata as Record<string, unknown>).dataset = dataset;
    }
    markDiskReader(reader);
    reader = null; // the new backends own it now

    // Close the old backends, and each old reader no open video still reads.
    const stillRead = new Set(
      labels.videos.flatMap((video) => {
        const disk = diskBackendOf(video);
        return disk ? [readerOf(disk.leaf)] : [];
      })
    );
    const oldReaders = new Set<object | null>();
    for (const { leaf } of built) {
      try {
        leaf.close();
      } catch {
        /* closing only drops caches */
      }
      oldReaders.add(readerOf(leaf));
    }
    for (const old of oldReaders) {
      if (!old || stillRead.has(old)) continue;
      try {
        await (old as { close?: () => Promise<void> }).close?.();
      } catch {
        /* already closed */
      }
    }
    return { ok: true, rebound: built.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (reader) await reader.close().catch(() => {});
  }
}
