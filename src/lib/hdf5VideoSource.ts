/**
 * External HDF5 video sources — a `.pkg.slp` / `.h5` / `.hdf5` file used as a
 * video, rather than as the project file.
 *
 * A `.slp` does NOT only reference `.mp4`/`.avi` media. When a project is
 * predicted (or re-saved) against a training package, each video's stored source
 * is the PACKAGE itself plus the HDF5 dataset holding its embedded images:
 *
 *   videos_json[0].backend = {
 *     type: "HDF5Video", filename: "/data/labels.v001.pkg.slp",
 *     dataset: "video0/video", has_embedded_images: true, shape: [...]
 *   }
 *
 * This is NOT the embedded case: `filename` is `"."` for embedded videos (the
 * `.slp` is its own container), so sleap-io.js reports `hasEmbeddedImages ===
 * false` and the package is an ordinary external file that has to be located
 * like any missing `.mp4`. Python treats these as first-class video sources —
 * `HDF5Video.EXTS = ("h5", "hdf5", "slp")` (sleap-io
 * `io/video_reading.py:1221`) — and the legacy Qt GUI's locate/replace dialog
 * derives its file filter from the MISSING FILE'S OWN extension
 * (`sleap/gui/dialogs/missingfiles.py:113`), so a missing `.pkg.slp` source is
 * offered a `*.slp` picker rather than a video-only one.
 *
 * Two things this module exists for:
 *
 * 1. **Opening one in a WebView.** `createVideoBackend()` routes these
 *    extensions to sleap-io.js's `Hdf5VideoBackend`, but it opens them through
 *    `openH5File()`, which has no Node opener in a browser/Tauri WebView: a
 *    native PATH falls through to the URL opener and is fetched against the app
 *    origin (404). So the app has to open the container itself — by byte range
 *    where cross-origin isolation allows it, so a multi-GB package is never
 *    materialized in WASM memory, exactly like the `.slp` streaming reader.
 * 2. **Finding the right dataset.** The stored `backendMetadata.dataset` is the
 *    authority when relinking a known video; a freshly-picked package (Replace
 *    Video) has none, so the dataset is auto-detected with the same heuristics
 *    Python applies when `dataset=None` (`video_reading.py:1313-1341`).
 */

import {
  StreamingH5File,
  StreamingHdf5VideoBackend,
  GrayscaleVideoBackend,
  isStreamingSupported,
  type VideoBackend,
  type Video,
} from "@talmolab/sleap-io.js";
import { getPlatform } from "../platform/index";
import { fileSize, readRange } from "./nativeRange";

/**
 * Extensions whose video data lives INSIDE an HDF5 container. Mirrors Python
 * `HDF5Video.EXTS` (sleap-io `io/video_reading.py:1221`) exactly — `.slp`
 * covers `.pkg.slp`, which is just a `.slp` with embedded image datasets.
 *
 * Deliberately NOT folded into `SUPPORTED_VIDEO_EXTS`: that list gates the
 * video IMPORT/drop paths (`pickedFromPaths`, the window dropzone), where a
 * `.slp` must keep meaning "open this project", not "import this as a video".
 * These extensions are only offered where the target is known to be a video —
 * the locate/relink and Replace Video pickers.
 */
export const HDF5_VIDEO_EXTS: readonly string[] = ["slp", "h5", "hdf5"];

/** Lowercased final extension of a path, or "" if none. Ignores `?query`. */
function ext(name: string): string {
  const base = name.split(/[?#]/)[0] ?? name;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

/**
 * True when `name` is an HDF5 container we can read video out of (`.pkg.slp`,
 * `.slp`, `.h5`, `.hdf5`). Pure. Note a plain labels `.slp` also passes here —
 * it has the right container format but no video dataset, which
 * {@link detectHdf5VideoDataset} reports as `null` so the caller can say so.
 */
export function isHdf5VideoPath(name: string | string[]): boolean {
  const first = Array.isArray(name) ? (name[0] ?? "") : name;
  return HDF5_VIDEO_EXTS.includes(ext(first));
}

/**
 * The HDF5 dataset path recorded for this video by the `.slp` that referenced
 * it (`videos_json[i].backend.dataset`, e.g. `"video0/video"`), or null when
 * absent. This is the authority when RELINKING a known video: a package can
 * hold many videos (`video0`, `video1`, …) and only the stored dataset says
 * which one this `Video` is.
 */
export function storedHdf5Dataset(video: Video): string | null {
  const meta = video.backendMetadata as Record<string, unknown> | undefined;
  const ds = meta?.dataset;
  return typeof ds === "string" && ds !== "" ? ds : null;
}

/**
 * Serve h5wasm same-origin so the streaming Worker can load it under
 * cross-origin isolation (COOP/COEP) — COEP blocks the cross-origin CDN
 * `importScripts` the library defaults to. Mirrors `loadProject.ts`'s
 * `H5WASM_URL`; `public/h5wasm/h5wasm.js` ships with the app.
 */
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/**
 * Is the SharedArrayBuffer range bridge usable? Needs cross-origin isolation
 * (COOP+COEP) on top of Worker support; without it the container is read whole
 * instead of by range.
 */
function canRangeStream(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && isStreamingSupported();
}

/**
 * The read-only slice of {@link StreamingH5File} the dataset-detection helpers
 * below need. Structural (like `FsDirLike` in `resolveVideos.ts`) so the
 * detection rules are unit-testable against a mock container instead of
 * requiring a real HDF5 file and a Worker.
 */
export interface Hdf5Structure {
  /** Root-level names (groups and datasets), as reported at open. */
  keys(): string[];
  /** Children of `path`; rejects when `path` is a dataset, not a group. */
  getKeys(path: string): Promise<string[]>;
  /** Shape/dtype of the dataset at `path`; rejects when `path` is a group. */
  getDatasetMeta(path: string): Promise<{ shape: number[]; dtype: string }>;
}

/**
 * Numeric suffix of a `video<N>` group name, or `Infinity` for anything else,
 * so `video0` sorts before `video10` and before an unnumbered group.
 */
function videoGroupOrder(name: string): number {
  const m = /^video(\d+)$/.exec(name);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * A root-level rank-4 dataset (`[frames, H, W, C]`) — a raw HDF5 movie rather
 * than a SLEAP package — or null. Python's first `dataset=None` heuristic
 * (sleap-io `video_reading.py:1316-1322`), bounded to the root level: the
 * unbounded `visititems` walk Python can afford natively would be one worker
 * round-trip per node here, and no layout in the wild nests one deeper.
 */
async function detectRank4Dataset(
  h5: Hdf5Structure
): Promise<string | null> {
  for (const key of h5.keys()) {
    try {
      const meta = await h5.getDatasetMeta(key);
      if (meta?.shape?.length === 4) return key;
    } catch {
      /* a group, not a dataset */
    }
  }
  return null;
}

/**
 * Every `video<N>/video` dataset in an open container, lowest index first.
 * A SLEAP package stores one such group per video, so this both detects the
 * embedded-image layout and tells "one video in here" from "several, and
 * nothing says which one is wanted".
 */
export async function listHdf5VideoDatasets(
  h5: Hdf5Structure
): Promise<string[]> {
  const found: string[] = [];
  const groups = [...h5.keys()].sort(
    (a, b) => videoGroupOrder(a) - videoGroupOrder(b)
  );
  for (const key of groups) {
    let children: string[];
    try {
      children = await h5.getKeys(key);
    } catch {
      continue; // a dataset, not a group
    }
    if (children.includes("video")) found.push(`${key}/video`);
  }
  return found;
}

/**
 * Find the video dataset inside an open HDF5 container, applying Python's
 * `dataset=None` heuristics (sleap-io `video_reading.py:1313-1341`) in the same
 * order: a rank-4 array first, then a `video` dataset inside a group. Returns
 * the dataset path (e.g. `"video0/video"`), or null when the file holds no video
 * data — which is exactly what a plain labels `.slp` looks like, so callers can
 * say so instead of failing opaquely.
 */
export async function detectHdf5VideoDataset(
  h5: Hdf5Structure
): Promise<string | null> {
  return (
    (await detectRank4Dataset(h5)) ??
    (await listHdf5VideoDatasets(h5))[0] ??
    null
  );
}

/**
 * Reading an HDF5 container goes through a Web Worker (h5wasm off the main
 * thread) in every mode — range, buffer, or WORKERFS — so say so plainly rather
 * than failing deep inside the worker bootstrap.
 */
function requireWorkerSupport(): void {
  if (!isStreamingSupported()) {
    throw new Error(
      "Reading video from a .pkg.slp / .h5 file requires Web Worker support."
    );
  }
}

/**
 * Containers currently open, keyed by path — ONE per file, shared by every
 * video that lives in it.
 *
 * This is not just an optimization. A project predicted against a package
 * references that one package once per video: a 4-video test split gives four
 * `Video`s whose source is the same `.pkg.slp`, differing only in `dataset`
 * (`video0/video` … `video3/video`), and a 27-video package gives 27. Opening
 * per video would spin up a Web Worker, an h5wasm heap and a SharedArrayBuffer
 * range bridge apiece over identical bytes. sleap-io.js is built for this —
 * `StreamingHdf5VideoBackend.close()` deliberately leaves the `h5file` alone
 * "as it may be shared across multiple backends" — so the backends are thin
 * per-dataset slicers over one shared reader.
 *
 * Cached as the PROMISE so concurrent opens of the same path (all four videos
 * resolving at once) share one in-flight open rather than racing.
 */
const openContainers = new Map<string, Promise<StreamingH5File>>();

/**
 * Close every cached container. Called at the top of `resolveExternalVideos`,
 * which every project open runs before any container is opened — so the readers
 * held for the PREVIOUS project's videos are dropped instead of accumulating
 * one package per open. Safe to call when nothing is cached.
 */
export async function releaseHdf5Containers(): Promise<void> {
  const held = [...openContainers.values()];
  openContainers.clear();
  await Promise.all(
    held.map((p) =>
      p.then(
        (h5) => h5.close().catch(() => {}),
        () => {} // a failed open was already evicted below
      )
    )
  );
}

/**
 * Open an HDF5 container for video reading, by native PATH (desktop) — lazily
 * by byte range where cross-origin isolation permits it, so a multi-GB package
 * is never read whole into WASM memory (the same B-seam bridge the `.slp`
 * streaming reader uses). Falls back to a whole-file read when
 * SharedArrayBuffer is unavailable. Shared per path; see {@link openContainers}.
 */
export function openHdf5ContainerForPath(
  path: string
): Promise<StreamingH5File> {
  const cached = openContainers.get(path);
  if (cached) return cached;
  const opening = openContainerUncached(path).catch((err) => {
    openContainers.delete(path); // don't cache a failure
    throw err;
  });
  openContainers.set(path, opening);
  return opening;
}

async function openContainerUncached(path: string): Promise<StreamingH5File> {
  requireWorkerSupport();
  const h5 = new StreamingH5File();
  if (canRangeStream()) {
    const size = await fileSize(path);
    await h5.openRange(
      { size, readRange: (offset, length) => readRange(path, offset, length) },
      { h5wasmUrl: H5WASM_URL, filenameHint: path }
    );
    return h5;
  }
  const platform = await getPlatform();
  const bytes = await platform.readFile(path);
  await h5.openBuffer(bytes, { h5wasmUrl: H5WASM_URL, filenameHint: path });
  return h5;
}

/** Shape/format hints carried over from the `.slp` that referenced the package. */
export interface Hdf5VideoHints {
  /** Stored dataset path (`backendMetadata.dataset`); auto-detected when absent. */
  dataset?: string | null;
  /** `[frames, H, W, C]` from `videos_json`, used until the attrs are read. */
  shape?: [number, number, number, number];
  /** Embedded image encoding (`"png"`/`"jpg"`/`"hdf5"`). */
  format?: string;
  /** `"RGB"` / `"BGR"` — matters for correctly decoding legacy packages. */
  channelOrder?: string;
  fps?: number;
  /**
   * Asked which dataset to use when `dataset` is unset AND the container holds
   * more than one video — a freshly-picked multi-video `.pkg.slp`. Injected (not
   * called directly) so this module stays free of UI; return null to abort.
   * Without it the lowest-indexed video is taken, which is right for the
   * single-video case and a silent coin-flip otherwise.
   */
  pickDataset?: (datasets: string[]) => Promise<string | null>;
}

/** Thrown when an HDF5 container holds no readable video dataset. */
export class NoHdf5VideoDatasetError extends Error {
  constructor(name: string) {
    super(
      `"${name}" contains no video data. A project .slp only holds labels; ` +
        `pick the package (.pkg.slp) or HDF5 movie that holds the images.`
    );
    this.name = "NoHdf5VideoDatasetError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the user cancels the multi-video dataset prompt. */
export class Hdf5DatasetPickCanceled extends Error {
  constructor() {
    super("Canceled");
    this.name = "Hdf5DatasetPickCanceled";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Settle on the dataset to read: the stored one wins; otherwise detect what the
 * container holds, asking `pickDataset` only when the choice is genuinely
 * ambiguous (several videos in one package and nothing recorded to say which).
 *
 * Throws {@link NoHdf5VideoDatasetError} for a container with no video data (a
 * plain labels `.slp`) and {@link Hdf5DatasetPickCanceled} when the user backs
 * out of the prompt — both distinguishable by the caller.
 */
export async function resolveHdf5Dataset(
  h5: Hdf5Structure,
  name: string,
  hints?: Hdf5VideoHints
): Promise<string> {
  if (hints?.dataset) return hints.dataset;
  const datasets = await listHdf5VideoDatasets(h5);
  if (datasets.length === 0) {
    // No `<group>/video` group: still possibly a raw rank-4 HDF5 movie.
    const rank4 = await detectRank4Dataset(h5);
    if (!rank4) throw new NoHdf5VideoDatasetError(name);
    return rank4;
  }
  if (datasets.length === 1 || !hints?.pickDataset) return datasets[0]!;
  const picked = await hints.pickDataset(datasets);
  if (!picked) throw new Hdf5DatasetPickCanceled();
  return picked;
}

/**
 * Wrap an already-open container as a video backend.
 *
 * {@link StreamingHdf5VideoBackend} in DEFERRED mode, always: the per-video
 * metadata lives in the CONTAINER, not in the `.slp` that referenced it —
 * `frame_numbers` (the source→storage map, and therefore the video's true frame
 * extent), `frame_sizes`, and the dataset's `format`/`channel_order`/
 * `height`/`width`/`channels` attrs. Deferred mode reads them from this file on
 * the first frame. Getting that from anywhere else is not a detail: a package
 * normally embeds only the LABELED frames, so an empty frame map makes every
 * seek land on the wrong image (or on nothing).
 */
async function buildDeferredHdf5Backend(
  h5: StreamingH5File,
  filename: string,
  name: string,
  hints?: Hdf5VideoHints,
  grayscale?: boolean | null
): Promise<VideoBackend> {
  // NB: no close() on failure — the container is shared with this package's
  // other videos (see openContainers); it is released per project open.
  const dataset = await resolveHdf5Dataset(h5, name, hints);
  const backend = new StreamingHdf5VideoBackend({
    filename,
    h5file: h5,
    datasetPath: dataset,
    format: hints?.format,
    channelOrder: hints?.channelOrder,
    shape: hints?.shape,
    fps: hints?.fps,
    deferred: true,
  });
  return grayscale === undefined
    ? backend
    : GrayscaleVideoBackend.wrap({ inner: backend, grayscale });
}

/**
 * Build a video backend for an HDF5 container at a native PATH (desktop). The
 * container is opened by this app, not by `createVideoBackend` — see the module
 * header for why a native path cannot go through `openH5File` in a WebView.
 */
export async function createHdf5BackendForPath(
  path: string,
  hints?: Hdf5VideoHints,
  grayscale?: boolean | null
): Promise<VideoBackend> {
  const h5 = await openHdf5ContainerForPath(path);
  const name = path.split(/[\\/]/).pop() ?? path;
  return buildDeferredHdf5Backend(h5, path, name, hints, grayscale);
}

/**
 * Browser counterpart of {@link createHdf5BackendForPath}: open a picked `File`
 * through WORKERFS (zero-copy — the container is never read into memory whole)
 * and build the same deferred backend.
 */
export async function createHdf5BackendForFile(
  file: File,
  hints?: Hdf5VideoHints,
  grayscale?: boolean | null
): Promise<VideoBackend> {
  requireWorkerSupport();
  const h5 = new StreamingH5File();
  await h5.openLocal(file, { h5wasmUrl: H5WASM_URL, filenameHint: file.name });
  try {
    // The Video's canonical filename stays the bare name in the browser (no
    // absolute path is exposed), matching the other browser-side backends.
    return await buildDeferredHdf5Backend(
      h5,
      file.name,
      file.name,
      hints,
      grayscale
    );
  } catch (err) {
    // Unlike the by-path opens, a File container is NOT shared (each pick is its
    // own File), so nothing else is holding this reader — close it.
    await h5.close().catch(() => {});
    throw err;
  }
}

/**
 * Hints for a Video that is being relinked to a (possibly moved) HDF5
 * container: prefer everything the referencing `.slp` recorded, since it names
 * which dataset in the package this Video is.
 */
export function hdf5HintsForVideo(video: Video): Hdf5VideoHints {
  const meta = (video.backendMetadata ?? {}) as Record<string, unknown>;
  const shape = video.shape as [number, number, number, number] | undefined;
  return {
    dataset: storedHdf5Dataset(video),
    shape,
    format: typeof meta.format === "string" ? meta.format : undefined,
    channelOrder:
      typeof meta.channel_order === "string" ? meta.channel_order : undefined,
    fps: typeof meta.fps === "number" ? meta.fps : undefined,
  };
}
