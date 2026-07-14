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
  type Labels,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "../stores/appStore";
import { toast } from "@/lib/notify";
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

function reportParseProgress(current: number, total: number, message?: string): void {
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
 * Load an SLP project from a File object.
 * Shows loading indicator, handles errors, and sends toast notifications.
 */
export async function loadProjectFromFile(file: File): Promise<boolean> {
  const store = useAppStore.getState();

  // Check for unsaved changes
  if (store.hasChanges) {
    const confirmed = window.confirm(
      "You have unsaved changes. Opening a new project will discard them. Continue?"
    );
    if (!confirmed) return false;
  }

  store.setLoading(true, `Reading ${file.name}...`);

  try {
    const labels = await loadSlp(file, {
      openVideos: true,
      h5: { h5wasmUrl: H5WASM_URL },
      onProgress: reportParseProgress,
    });
    store.setLoading(true, "Locating videos...");
    await resolveExternalVideos(labels);
    store.setLabels(labels, file.name);
    await openFirstLabeledFrame(labels);
    toast.success(`Loaded ${file.name}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });
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

  // Check for unsaved changes
  if (store.hasChanges) {
    const confirmed = window.confirm(
      "You have unsaved changes. Opening a new project will discard them. Continue?"
    );
    if (!confirmed) return false;
  }

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
      // Inject the ImageVideo byte reader. Reads via a native Rust command
      // (std::fs::read) rather than the fs plugin, whose per-call path scope
      // validation adds ~4 s/frame on SMB mounts (vs ~32 ms native) —
      // pathological for ImageVideo (one read per displayed frame). Paths arrive
      // already resolved (the FsResolver ran during loadSlp), so the reader reads
      // each one directly — no candidate generation.
      const { invoke } = await import("@tauri-apps/api/core");
      const nativeReadImage = async (p: string): Promise<Uint8Array> => {
        const buf = await invoke<ArrayBuffer>(sleapCmd("read_image_file"), {
          path: p,
        });
        return new Uint8Array(buf);
      };
      setImageBytesReader(nativeReadImage);
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

  if (store.hasChanges) {
    const confirmed = window.confirm(
      "You have unsaved changes. Importing a file will discard them. Continue?"
    );
    if (!confirmed) return false;
  }

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

  if (store.hasChanges) {
    const confirmed = window.confirm(
      "You have unsaved changes. Importing a file will discard them. Continue?"
    );
    if (!confirmed) return false;
  }

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
