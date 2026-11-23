/**
 * Which embedded videos read their images from the project file on disk.
 *
 * Such a reader opens the file once and keeps its HDF5 structure, while each
 * read fetches the bytes from the file now at that path. After any full save
 * over the file (a new file renamed into place), it reads bytes at the old
 * file's offsets from the new one: other images, or none, whatever the
 * dataset names. So the save marks the labels until the project is reopened
 * (see `markStaleVideoNames`), unless the backends are reopened on the new
 * file.
 *
 * A large file's open (the range reader) gives each embedded video a
 * streaming backend that reads the file on disk by dataset name. An eager
 * load's embedded backends can be the same class (in the app, sleap-io.js
 * reads the bytes through its worker), but their reader holds the file's
 * bytes in memory: they keep reading the file as it was opened, by the names
 * it had then, whatever a later save writes. So the class alone can't tell;
 * the open notes the readers that read the disk ({@link markDiskBackedVideos}).
 */
import * as sio from "@talmolab/sleap-io.js";
import type { Labels, Video } from "@talmolab/sleap-io.js";

/** A wrapper backend (grayscale, crop) around another one. */
interface Wrapper {
  inner: unknown;
}

interface DiskBackend {
  /** The backend that reads the file on disk. */
  leaf: object;
  /** The wrapper holding it, or null when it is the video's backend. */
  parent: Wrapper | null;
}

/** The range readers that read a project file on disk. */
const diskReaders = new WeakSet<object>();

/** Labels whose open noted at least one such reader. */
const diskLabels = new WeakSet<Labels>();

/** The range reader a streaming backend reads through (private in sleap-io.js). */
export function readerOf(backend: object): object | null {
  const reader = (backend as { h5file?: unknown }).h5file;
  return reader && typeof reader === "object" ? reader : null;
}

/** The streaming backend of `video`, inside any wrappers, with its wrapper. */
function streamingBackendOf(video: Video): DiskBackend | null {
  // Read as a static member access, so a test that mocks sleap-io.js
  // without it reads undefined.
  const Streaming = (sio as unknown as { StreamingHdf5VideoBackend?: new (...a: never[]) => object })
    .StreamingHdf5VideoBackend;
  if (typeof Streaming !== "function") return null;
  let parent: Wrapper | null = null;
  let backend: unknown = video.backend;
  for (let depth = 0; backend && depth < 4; depth++) {
    if (backend instanceof Streaming) return { leaf: backend, parent };
    const inner = (backend as { inner?: unknown }).inner;
    if (!inner) return null;
    parent = backend as Wrapper;
    backend = inner;
  }
  return null;
}

/**
 * Note that the embedded videos of `labels` read their images from the file
 * on disk (a large file's open, through the range reader).
 */
export function markDiskBackedVideos(labels: Labels): void {
  for (const video of labels.videos) {
    const found = streamingBackendOf(video);
    const reader = found && readerOf(found.leaf);
    if (reader) {
      diskReaders.add(reader);
      diskLabels.add(labels);
    }
  }
}

/** Note one range reader that reads a project file on disk (a rebind's; see rebindEmbeddedVideos.ts). */
export function markDiskReader(reader: object): void {
  diskReaders.add(reader);
}

/**
 * Whether any video of `labels` was opened reading the file on disk, even
 * one removed since (an undo can bring it back, still on that reader).
 */
export function hasDiskBackedVideos(labels: Labels): boolean {
  return diskLabels.has(labels) || labels.videos.some((video) => diskBackendOf(video) !== null);
}

/**
 * Readers closed by a rebind (rebindEmbeddedVideos.ts) once no open video read
 * them. A video removed before that save and restored by undo still holds
 * one: its images are not in the written file, and a closed reader would
 * never answer, so its reads fail at once instead.
 */
const retiredReaders = new WeakSet<object>();

/** Why a video on a retired reader can't be read. */
export const RETIRED_READER_MESSAGE =
  "This video's images are no longer in the project file: a save or export wrote the file " +
  "without it, after it was removed. Remove the video, or reopen the project.";

/** Reader methods that read the file (sleap-io.js `StreamingH5File`). */
const READ_METHODS = ["getKeys", "getAttr", "getAttrs", "getDatasetMeta", "getDatasetValue"];

/**
 * Close a disk reader no open video reads any more, and make every later read
 * through it fail with {@link RETIRED_READER_MESSAGE} (a closed sleap-io.js
 * reader leaves its reads waiting forever).
 */
export async function retireDiskReader(reader: object): Promise<void> {
  retiredReaders.add(reader);
  const methods = reader as Record<string, unknown>;
  const close = typeof methods.close === "function" ? (methods.close as () => unknown).bind(reader) : null;
  for (const name of READ_METHODS) {
    methods[name] = () => Promise.reject(new Error(RETIRED_READER_MESSAGE));
  }
  methods.keys = () => {
    throw new Error(RETIRED_READER_MESSAGE);
  };
  try {
    await close?.();
  } catch {
    /* already closed */
  }
}

/** Whether `video` reads its images through a reader a rebind retired. */
export function readsRetiredReader(video: Video): boolean {
  const found = streamingBackendOf(video);
  const reader = found && readerOf(found.leaf);
  return !!reader && retiredReaders.has(reader);
}

/** The backend of `video` that reads its embedded images from a file on disk, if any. */
export function diskBackendOf(video: Video): DiskBackend | null {
  const found = streamingBackendOf(video);
  const reader = found && readerOf(found.leaf);
  return reader && diskReaders.has(reader) ? found : null;
}
