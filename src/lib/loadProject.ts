/**
 * Consolidated project loading helper.
 *
 * Single entry point for loading SLP files from any source:
 * - File picker (OpenProjectCommand)
 * - Drag-and-drop (AppShell, WelcomeScreen)
 * - Platform API
 *
 * Handles loading state, toast notifications, and unsaved changes confirmation.
 */

import {
  loadSlp,
  readSlpStreaming,
  setImageBytesReader,
  loadAnalysisH5,
  loadNwb,
  readCoco,
  isCocoData,
  type CocoJson,
  type ReadCocoOptions,
  type Labels,
  type DlcFileSystem,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "../stores/appStore";
import { useEnvironmentStore } from "../stores/environmentStore";
import {
  buildDlcLabels,
  dlcProjectPathHint,
  enumerateBrowserDlcDir,
  enumerateTauriDlcDir,
  joinPosix,
} from "./dlcFileSystem";
import { consumeLastBrowserFileHandle } from "../platform/index";
import { toast } from "@/lib/notify";
import { confirmDiscardUnsavedWork } from "./unsavedGuard";
import { resolveExternalVideos } from "./resolveVideos";
import { installTauriFsResolver } from "./fsResolver";
import { fileSize, readRange } from "./nativeRange";
import { sleapCmd } from "./sleapPlugin";

// Files larger than this open via the B-seam native range reader (lazy, on-disk)
// instead of reading the whole file into WASM memory. Below it, eager is simpler
// and avoids per-chunk IPC overhead.
const RANGE_READER_THRESHOLD = 1_000_000_000; // 1 GB

// Defer opening external video decoders until a video is first viewed (open one,
// not all N): resolveExternalVideos records the located path and
// ensureVideoBackend opens the decoder on first view.
const LAZY_VIDEO_BACKENDS = true;

// Open large embedded pkg.slp fast: build videos from videos_json alone and defer
// every per-video HDF5 read to a backend that reads them on first view
// (sleap-io.js `lazyVideoMetadata`). Cuts a many-video open from ~30s to ~3s by
// skipping the ~13 serial reads/video for videos never opened. Set false for the
// eager path (reads all per-video metadata up front).
const LAZY_VIDEO_METADATA = true;

// Serve h5wasm same-origin so the streaming Worker can load it under cross-origin
// isolation (COOP/COEP) — COEP blocks the default cross-origin CDN importScripts.
// public/h5wasm/h5wasm.js ships with the app (dev: Vite; prod: Tauri asset protocol).
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/**
 * Bridge sleap-io.js load progress into the loading overlay.
 * The library reports (completed, total, stage) where `stage` names the step
 * about to run — "Reading frames", "Opening videos (3/27)", … — ending with
 * (total, total, "Finalizing"). Stage granularity varies by reader path.
 */
export function formatLoadProgress(
  current: number,
  total: number,
  message?: string
): string {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return `${message ?? "Parsing"}... (${pct}%)`;
}

export function reportParseProgress(
  current: number,
  total: number,
  message?: string
): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  useAppStore
    .getState()
    .setLoading(true, formatLoadProgress(current, total, message), pct);
}

/**
 * After a project loads, open on its first labeled frame instead of frame 0.
 * Embedded pkg.slp videos store frames at their ORIGINAL source indices — often
 * far from 0 (e.g. 76978+) — so frame 0 is usually an empty/black non-embedded
 * position, making a fully-loaded project look blank on open. Selects that
 * frame's video too (multi-video packages). No-op when there are no labeled
 * frames.
 *
 * For a deferred (lazyVideoMetadata) backend we pre-open it here so video.shape[0]
 * is the true source frame count BEFORE setFrameIdx runs — otherwise setFrameIdx
 * would clamp the first labeled frame (a large source index) down into the
 * JSON-seeded range and the opening view would land off-target/blank.
 */
async function openFirstLabeledFrame(labels: Labels): Promise<void> {
  const firstLF = labels.labeledFrames[0];
  if (!firstLF) return;
  const store = useAppStore.getState();
  const video = firstLF.video;
  if (video) {
    store.setVideo(video);
    const backend = video.backend as unknown as {
      ensureLoaded?: () => Promise<void>;
    } | null;
    if (backend?.ensureLoaded) {
      try {
        await backend.ensureLoaded();
        store.markVideoUpdated();
      } catch {
        /* non-deferred backend or a read failure — keep the seeded shape */
      }
    }
  }
  store.setFrameIdx(firstLF.frameIdx);
}

/**
 * Route sleap-io.js's ImageVideo frame reads through a native Rust command
 * (`std::fs::read`) instead of the Tauri fs plugin, whose per-call path-scope
 * validation adds ~4 s/frame on SMB mounts (vs ~32 ms native) — pathological
 * for ImageVideo (one read per displayed frame). Paths arrive already resolved,
 * so the reader reads each one directly (no candidate generation). Call once,
 * before opening a project whose videos may be image sequences (SLP with
 * ImageVideo, or a COCO dataset). No-op outside a Tauri runtime: the dynamic
 * `@tauri-apps/api/core` import fails there (e.g. under the unit-test runner)
 * and is swallowed, leaving whatever image reader the browser build uses.
 */
export async function installTauriImageReader(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const nativeReadImage = async (p: string): Promise<Uint8Array> => {
      const buf = await invoke<ArrayBuffer>(sleapCmd("read_image_file"), {
        path: p,
      });
      return new Uint8Array(buf);
    };
    setImageBytesReader(nativeReadImage);
  } catch {
    /* not a Tauri runtime — keep the default reader */
  }
}

/**
 * Load an SLP project from a File object.
 * Shows loading indicator, handles errors, and sends toast notifications.
 */
export async function loadProjectFromFile(file: File): Promise<boolean> {
  const store = useAppStore.getState();

  // Confirm discarding unsaved work (in-memory edits OR a not-yet-exported OPFS
  // working copy) before replacing the current project.
  if (!confirmDiscardUnsavedWork("Opening a new project")) return false;

  store.setLoading(true, `Reading ${file.name}...`);

  try {
    const labels = await loadSlp(file, {
      openVideos: true,
      h5: { h5wasmUrl: H5WASM_URL },
      onProgress: reportParseProgress,
    });
    store.setLoading(true, "Locating videos...");
    await resolveExternalVideos(labels);
    // Retain the source File AND, when this open came from the file picker, its
    // durable FileSystemFileHandle, so a plain Save can write back to the opened
    // file in place (#234) AND a large embedded-pkg re-save/export can re-read
    // its images fresh via the OPFS writer (see saveProjectAsSlp /
    // saveEmbeddedPkgOpfs). The handle is preferred because a File snapshot goes
    // stale after a dialog / elapsed time / on a network volume. Name-match
    // guards against a stale handle from a prior pick (a later drag-drop sets none).
    const picked = consumeLastBrowserFileHandle();
    const handle = picked && picked.name === file.name ? picked : null;
    store.setLabels(labels, file.name, undefined, file, handle);
    await openFirstLabeledFrame(labels);
    toast.success(`Loaded ${file.name}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    // Fire-and-forget: best-effort, no-ops on browser, must not add latency.
    useEnvironmentStore.getState().checkSleapNnUpdateAndNotify();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to load project", { description: msg });
    console.error("Failed to load project:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Load an SLP project from a file path (Tauri only).
 * Reads the file bytes first, then loads. Attempts to auto-resolve
 * external video paths relative to the SLP file's directory.
 */
export async function loadProjectFromPath(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
  exists?: (path: string) => Promise<boolean>
): Promise<boolean> {
  const store = useAppStore.getState();

  // Confirm discarding unsaved work (in-memory edits OR a not-yet-exported OPFS
  // working copy) before replacing the current project.
  if (!confirmDiscardUnsavedWork("Opening a new project")) return false;

  const filename = path.split(/[\\/]/).pop() ?? path;
  store.setLoading(true, `Reading ${filename}...`);

  try {
    if (exists) {
      // Register the FS resolver BEFORE loadSlp so sleap-io.js resolves external
      // and ImageVideo source paths against the labels dir itself (issue #213):
      // it builds a working backend when the media resolves and withholds an
      // unreadable image sequence as backendError.kind === "image-sequence". Uses
      // the plugin-fs `exists` (path resolution is a handful of probes per video,
      // not the per-frame hot path).
      installTauriFsResolver(exists);
      // Inject the native ImageVideo byte reader (see installTauriImageReader).
      await installTauriImageReader();
    }

    // Adaptive load: stream large files lazily via native range reads (B-seam)
    // so the whole file is never materialized in WASM memory; small files load
    // eagerly (simpler, no per-chunk IPC). Falls back to eager if the size probe
    // fails (e.g. non-Tauri).
    let fileBytes = 0;
    try {
      fileBytes = await fileSize(path);
    } catch {
      fileBytes = 0;
    }

    let labels: Labels;
    if (fileBytes > RANGE_READER_THRESHOLD) {
      store.setLoading(true, `Streaming ${filename}...`);
      const rangeSource = {
        size: fileBytes,
        readRange: (offset: number, length: number) =>
          readRange(path, offset, length),
      };
      labels = await readSlpStreaming(rangeSource, {
        // Embedded (pkg.slp) videos: build from videos_json and open each video's
        // backend on first view (LAZY_VIDEO_METADATA) so a many-video package
        // opens fast. Eager path (openVideos) reads all per-video metadata now.
        openVideos: !LAZY_VIDEO_METADATA,
        lazyVideoMetadata: LAZY_VIDEO_METADATA,
        filenameHint: path,
        h5wasmUrl: H5WASM_URL,
        onProgress: reportParseProgress,
      });
    } else {
      const bytes = await readFile(path);
      store.setLoading(true, `Parsing ${filename}...`);
      labels = await loadSlp(bytes, {
        openVideos: true,
        h5: { filenameHint: path, h5wasmUrl: H5WASM_URL },
        onProgress: reportParseProgress,
      });
    }

    store.setLoading(true, "Locating videos...");
    // Try auto-resolving video paths if we have filesystem access
    if (exists) {
      await resolveExternalVideos(labels, {
        projectPath: path,
        exists,
        readFile,
        lazy: LAZY_VIDEO_BACKENDS,
      });
    } else {
      await resolveExternalVideos(labels);
    }

    store.setLabels(labels, filename, path);
    await openFirstLabeledFrame(labels);

    toast.success(`Loaded ${filename}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    // Fire-and-forget: best-effort, no-ops on browser, must not add latency.
    useEnvironmentStore.getState().checkSleapNnUpdateAndNotify();

    // Missing / unsupported-codec videos are summarized (codec-aware) by
    // resolveExternalVideos above — no separate toast here (avoids a duplicate).
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to load project", { description: msg });
    console.error("Failed to load project:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Load-to-Labels (no activate) — used by Merge into Project
// ---------------------------------------------------------------------------

/**
 * Load a `.slp` into a `Labels` object WITHOUT activating it in the store.
 *
 * Used by Merge into Project: the picked "donor" file is merged into the current
 * project, not opened as a new one. This is a DELIBERATELY lightweight load —
 * annotations + video metadata only:
 *   - it does NOT drive the global loading overlay (no `onProgress:
 *     reportParseProgress` — that flips `setLoading(true)`, and only the
 *     activate-a-project loaders clear it in their `finally`; a donor load would
 *     otherwise leave the overlay stuck on "Finalizing…"), and
 *   - it does NOT open or resolve video backends (`openVideos: false`, no
 *     `resolveExternalVideos`). The merge matches videos by BASENAME, which needs
 *     only the stored filename; a matched donor video is discarded in favor of the
 *     project's, and a new one is appended unresolved (locate it later like any
 *     external video). This avoids hanging on an unreachable external video.
 * The dialog shows its own "Reading & matching…" indicator during this.
 */
export async function loadLabelsFromSlpFile(file: File): Promise<Labels> {
  return await loadSlp(file, {
    openVideos: false,
    h5: { h5wasmUrl: H5WASM_URL },
  });
}

/** Tauri path variant of {@link loadLabelsFromSlpFile} (load-to-Labels, no activate). */
export async function loadLabelsFromSlpPath(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>
): Promise<Labels> {
  const bytes = await readFile(path);
  return await loadSlp(bytes, {
    openVideos: false,
    h5: { filenameHint: path, h5wasmUrl: H5WASM_URL },
  });
}

// ---------------------------------------------------------------------------
// SLEAP Analysis HDF5 import
// ---------------------------------------------------------------------------

/**
 * `loadAnalysisH5` types its source as `string`, but the underlying `openH5File`
 * accepts bytes (Uint8Array / ArrayBuffer) at runtime — that's how the browser
 * reads an HDF5 file it never has a path for. The public 0.5.3 signature hasn't
 * been widened yet, so we pass bytes through a single localized cast here.
 * Follow-up: widen `loadAnalysisH5`'s signature upstream and drop this shim.
 */
type AnalysisSource = string | ArrayBuffer | Uint8Array;
function readAnalysisLabels(source: AnalysisSource): Promise<Labels> {
  return loadAnalysisH5(source as string);
}

/**
 * Import a SLEAP Analysis HDF5 (`.analysis.h5`) file into a new project.
 *
 * Analysis files are small (per-frame point arrays, no embedded media), so this
 * skips the SLP loaders' range-reader / image-reader machinery. The reader
 * auto-builds a {@link Video} from the file's stored `video_path`; that video is
 * then resolved like any external video (auto-located next to the file on
 * desktop, or shown as missing — user can Replace Videos — in the browser).
 */
export async function loadAnalysisProjectFromFile(file: File): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  store.setLoading(true, `Reading ${file.name}...`);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    store.setLoading(true, `Parsing ${file.name}...`);
    const labels = await readAnalysisLabels(bytes);
    store.setLoading(true, "Locating videos...");
    await resolveExternalVideos(labels);
    store.setLabels(labels, file.name);
    openFirstLabeledFrame(labels);
    toast.success(`Imported ${file.name}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import Analysis HDF5", { description: msg });
    console.error("Failed to import Analysis HDF5:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Import a SLEAP Analysis HDF5 file from a path (Tauri only).
 * Reads the bytes via the platform, then imports like
 * {@link loadAnalysisProjectFromFile}, resolving the stored video path relative
 * to the analysis file's directory when filesystem access is available.
 */
export async function loadAnalysisProjectFromPath(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
  exists?: (path: string) => Promise<boolean>
): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  const filename = path.split(/[\\/]/).pop() ?? path;
  store.setLoading(true, `Reading ${filename}...`);

  try {
    const bytes = await readFile(path);
    store.setLoading(true, `Parsing ${filename}...`);
    const labels = await readAnalysisLabels(bytes);

    store.setLoading(true, "Locating videos...");
    if (exists) {
      await resolveExternalVideos(labels, { projectPath: path, exists, readFile });
    } else {
      await resolveExternalVideos(labels);
    }

    store.setLabels(labels, filename, path);
    openFirstLabeledFrame(labels);
    toast.success(`Imported ${filename}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import Analysis HDF5", { description: msg });
    console.error("Failed to import Analysis HDF5:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// NWB (ndx-pose) predictions import
// ---------------------------------------------------------------------------

/**
 * `loadNwb` types its source as `string`, but the underlying `openH5File`
 * accepts bytes (Uint8Array / ArrayBuffer) at runtime — that's how the browser
 * reads an HDF5 file it has no path for. Mirrors {@link readAnalysisLabels}.
 * Follow-up: widen `loadNwb`'s upstream signature and drop this cast.
 */
function readNwbLabels(source: AnalysisSource): Promise<Labels> {
  return loadNwb(source as string);
}

/**
 * Import an NWB (ndx-pose) predictions file (`.nwb`) into a new project.
 *
 * NWB predictions files are pose-data-only (no embedded pixels); the reader
 * builds a {@link Video} from the file's stored `original_videos` path, which is
 * then resolved like any external video (auto-located next to the file on
 * desktop, or shown as missing — user can Replace Videos — in the browser).
 */
export async function loadNwbProjectFromFile(file: File): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  store.setLoading(true, `Reading ${file.name}...`);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    store.setLoading(true, `Parsing ${file.name}...`);
    const labels = await readNwbLabels(bytes);
    store.setLoading(true, "Locating videos...");
    await resolveExternalVideos(labels);
    store.setLabels(labels, file.name);
    openFirstLabeledFrame(labels);
    toast.success(`Imported ${file.name}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import NWB", { description: msg });
    console.error("Failed to import NWB:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Import an NWB predictions file from a path (Tauri only). Reads the bytes via
 * the platform, then imports like {@link loadNwbProjectFromFile}, resolving the
 * stored video path relative to the NWB file's directory when filesystem access
 * is available.
 */
export async function loadNwbProjectFromPath(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
  exists?: (path: string) => Promise<boolean>
): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  const filename = path.split(/[\\/]/).pop() ?? path;
  store.setLoading(true, `Reading ${filename}...`);

  try {
    const bytes = await readFile(path);
    store.setLoading(true, `Parsing ${filename}...`);
    const labels = await readNwbLabels(bytes);

    store.setLoading(true, "Locating videos...");
    if (exists) {
      await resolveExternalVideos(labels, { projectPath: path, exists, readFile });
    } else {
      await resolveExternalVideos(labels);
    }

    store.setLabels(labels, filename, path);
    openFirstLabeledFrame(labels);
    toast.success(`Imported ${filename}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import NWB", { description: msg });
    console.error("Failed to import NWB:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// COCO keypoint-dataset import
// ---------------------------------------------------------------------------

/**
 * Parse a COCO annotations JSON string into {@link Labels} via sleap-io.js
 * `readCoco`. We `JSON.parse` + validate up front (rather than handing the raw
 * string to `readCoco`) so a wrong file yields a clear, user-facing error —
 * "not valid JSON" vs "not a COCO dataset" — instead of a cryptic downstream
 * throw. `readCoco` builds ONE image-sequence {@link Video} (its frames are the
 * dataset images) plus one LabeledFrame per annotated image; keypoint names
 * become the skeleton nodes. Image paths are resolved via `options.resolveImage`
 * (see callers); the reader itself never touches the filesystem, which is what
 * makes it browser-safe.
 */
function readCocoLabels(text: string, options?: ReadCocoOptions): Labels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  if (!isCocoData(parsed)) {
    throw new Error(
      "File is not a COCO annotations dataset (needs top-level images, annotations, and categories arrays)."
    );
  }
  return readCoco(parsed as CocoJson, options);
}

/**
 * Resolve a COCO image `file_name` relative to the dataset root (the JSON file's
 * directory) on desktop. Already-absolute paths (POSIX `/…` or Windows
 * `C:\…`/`C:/…`) are kept as-is; relative ones are joined under the root. This
 * callback is synchronous (io calls it inline while building videos), so the
 * root is derived from the JSON path string by the caller rather than via an
 * async Tauri path API.
 */
function resolveCocoImageUnderRoot(
  fileName: string,
  datasetRoot: string | undefined
): string {
  if (!datasetRoot) return fileName;
  if (/^(\/|[A-Za-z]:[\\/])/.test(fileName)) return fileName;
  return `${datasetRoot}/${fileName}`;
}

/**
 * Import a COCO keypoints dataset from a File object (browser).
 *
 * The browser has no by-path filesystem read, so external image files can't be
 * located: we fall back to io's default identity resolver (datasetRoot omitted →
 * `file_name` kept verbatim). Import still succeeds — the skeleton, keypoints,
 * and per-image labeled frames all load; the image-sequence video simply shows
 * as missing until the user relocates it via the Videos panel.
 */
export async function loadCocoProjectFromFile(file: File): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  store.setLoading(true, `Reading ${file.name}...`);

  try {
    const text = await file.text();
    store.setLoading(true, `Parsing ${file.name}...`);
    const labels = readCocoLabels(text);
    store.setLoading(true, "Locating videos...");
    await resolveExternalVideos(labels);
    store.setLabels(labels, file.name);
    await openFirstLabeledFrame(labels);
    toast.success(`Imported ${file.name}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import COCO dataset", { description: msg });
    console.error("Failed to import COCO dataset:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Import a COCO keypoints dataset from a file path (Tauri only).
 *
 * Resolves each image `file_name` relative to the JSON file's directory (the
 * dataset root), then — like opening an SLP whose video is an image sequence —
 * installs the desktop FS resolver + native image reader and runs
 * {@link resolveExternalVideos} so the located frames render on first view.
 */
export async function loadCocoProjectFromPath(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
  exists?: (path: string) => Promise<boolean>
): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  const filename = path.split(/[\\/]/).pop() ?? path;
  store.setLoading(true, `Reading ${filename}...`);

  try {
    const bytes = await readFile(path);
    store.setLoading(true, `Parsing ${filename}...`);
    // Dataset root = the JSON file's directory (string dirname; the resolveImage
    // callback is synchronous, so we can't await a Tauri path API here). Passed
    // as datasetRoot AND to resolveImage, which additionally leaves any
    // already-absolute file_names untouched.
    const datasetRoot = path
      .slice(0, path.length - filename.length)
      .replace(/[\\/]$/, "");
    const text = new TextDecoder().decode(bytes);
    const labels = readCocoLabels(text, {
      datasetRoot,
      resolveImage: resolveCocoImageUnderRoot,
    });

    store.setLoading(true, "Locating videos...");
    if (exists) {
      // Desktop: build the ImageVideo backend via the native byte reader and
      // resolve the (now absolute) image-sequence paths against the dataset dir,
      // exactly like opening an SLP that references an image sequence.
      installTauriFsResolver(exists);
      await installTauriImageReader();
      await resolveExternalVideos(labels, { projectPath: path, exists, readFile });
    } else {
      await resolveExternalVideos(labels);
    }

    store.setLabels(labels, filename, path);
    await openFirstLabeledFrame(labels);
    toast.success(`Imported ${filename}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import COCO dataset", { description: msg });
    console.error("Failed to import COCO dataset:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/** Optional image/video resolution wiring for a DLC import (per runtime). */
interface DlcResolve {
  exists?: (path: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Installs the runtime's image-bytes reader before video resolution. */
  installImageReader?: () => Promise<void> | void;
}

/**
 * Core DLC import: build `Labels` from an already-enumerated {@link DlcFileSystem}
 * tree, resolve the image-sequence video(s), and install into the store like
 * opening a project. `mode` picks single-dataset vs merge-every-subdir-folder;
 * `resolve` supplies the runtime's `exists`/`readFile`/image reader (omit for
 * the annotations-only path exercised under the unit-test runner).
 */
export async function loadDlcFromFileSystem(
  fs: DlcFileSystem,
  root: string,
  mode: "single" | "folder",
  displayName: string,
  resolve?: DlcResolve,
  opts?: { entryFile?: string }
): Promise<boolean> {
  const store = useAppStore.getState();

  if (!confirmDiscardUnsavedWork("Importing a file")) return false;

  store.setLoading(true, `Reading ${displayName}...`);

  try {
    store.setLoading(true, `Parsing ${displayName}...`);
    const labels = await buildDlcLabels(fs, root, mode, opts?.entryFile);

    store.setLoading(true, "Locating videos...");
    if (resolve?.installImageReader) await resolve.installImageReader();
    if (resolve?.exists) {
      await resolveExternalVideos(labels, {
        projectPath: dlcProjectPathHint(fs, root),
        exists: resolve.exists,
        readFile:
          resolve.readFile ??
          (async () => {
            throw new Error("readFile not available");
          }),
      });
    } else {
      await resolveExternalVideos(labels);
    }

    store.setLabels(labels, displayName);
    await openFirstLabeledFrame(labels);
    toast.success(`Imported ${displayName}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to import DeepLabCut dataset", { description: msg });
    console.error("Failed to import DeepLabCut dataset:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Import DLC from a browser directory handle (File System Access API). Enumerates
 * the picked folder, installs an image reader backed by the retained `File`
 * handles (so frames render), and resolves the image-sequence video against the
 * in-memory tree.
 */
export async function loadDlcFromBrowserDir(
  dirHandle: unknown,
  mode: "single" | "folder"
): Promise<boolean> {
  const tree = await enumerateBrowserDlcDir(
    dirHandle as Parameters<typeof enumerateBrowserDlcDir>[0]
  );
  const { fileByPath } = tree;
  return loadDlcFromFileSystem(tree.fs, tree.root, mode, tree.root, {
    exists: async (p) => tree.fs.exists(p),
    readFile: async (p) => {
      const file = fileByPath.get(p);
      if (!file) throw new Error(`Not found: ${p}`);
      return new Uint8Array(await file.arrayBuffer());
    },
    installImageReader: () => {
      setImageBytesReader(async (p: string) => {
        const file = fileByPath.get(p);
        if (!file) throw new Error(`Image not found: ${p}`);
        return new Uint8Array(await file.arrayBuffer());
      });
    },
  });
}

/**
 * Import DLC from a directory path on disk (Tauri). Enumerates via the fs plugin,
 * installs the native image reader, and resolves image-sequence frames against
 * the real filesystem — exactly like opening an SLP whose video is an image
 * sequence.
 */
export async function loadDlcFromTauriDir(
  rootDir: string,
  mode: "single" | "folder",
  readFile: (path: string) => Promise<Uint8Array>,
  exists: (path: string) => Promise<boolean>,
  entryFile?: string
): Promise<boolean> {
  const tree = await enumerateTauriDlcDir(rootDir);
  const displayName = (entryFile ?? rootDir).split(/[\\/]/).pop() || rootDir;
  installTauriFsResolver(exists);
  return loadDlcFromFileSystem(
    tree.fs,
    tree.root,
    mode,
    displayName,
    { exists, readFile, installImageReader: installTauriImageReader },
    // Normalize the picked path to the same POSIX form the enumerator keys the
    // in-memory tree by (matters on Windows, where the native path uses `\`).
    { entryFile: entryFile ? joinPosix(entryFile) : undefined }
  );
}
