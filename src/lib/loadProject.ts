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
  type Labels,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "../stores/appStore";
import { toast } from "@/lib/notify";
import { resolveExternalVideos } from "./resolveVideos";
import { setImageProjectDir, createImageReader } from "./imageVideoReader";
import { fileSize, readRange } from "./nativeRange";

// Files larger than this open via the B-seam native range reader (lazy, on-disk)
// instead of reading the whole file into WASM memory. Below it, eager is simpler
// and avoids per-chunk IPC overhead.
const RANGE_READER_THRESHOLD = 1_000_000_000; // 1 GB

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
  useAppStore.getState().setLoading(true, formatLoadProgress(current, total, message));
}

/**
 * After a project loads, open on its first labeled frame instead of frame 0.
 * Embedded pkg.slp videos store frames at their ORIGINAL source indices — often
 * far from 0 (e.g. 76978+) — so frame 0 is usually an empty/black non-embedded
 * position, making a fully-loaded project look blank on open. Selects that
 * frame's video too (multi-video packages). No-op when there are no labeled
 * frames. (Full effect needs the sleap-io.js frame-axis fix so shape[0] spans
 * the original range; otherwise setFrameIdx clamps — but never a regression.)
 */
function openFirstLabeledFrame(labels: Labels): void {
  const firstLF = labels.labeledFrames[0];
  if (!firstLF) return;
  const store = useAppStore.getState();
  if (firstLF.video) store.setVideo(firstLF.video);
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
    openFirstLabeledFrame(labels);
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
    // Make ImageVideo (image-sequence) frames resolvable on desktop: resolve
    // relative image paths against the project directory, and read their bytes
    // through Tauri's plugin-fs. This MUST be set before loadSlp, which opens
    // ImageVideoBackend inline (it decodes frame 0 for the shape). When a path
    // can't be resolved the reader throws and sleap-io.js's load guard records
    // video.backendError instead of aborting the load.
    const sep = path.includes("\\") ? "\\" : "/";
    setImageProjectDir(path.substring(0, path.lastIndexOf(sep)));
    if (exists) {
      // Read image bytes via a native Rust command (std::fs::read) instead of the
      // fs plugin, whose per-call path scope-validation adds ~4 s/frame on SMB
      // mounts (vs ~32 ms native) — pathological for ImageVideo, which reads one
      // image per displayed frame. The plugin's exists()/readFile are still used
      // for path resolution (once per video) and the .slp itself.
      const { invoke } = await import("@tauri-apps/api/core");
      const nativeReadImage = async (p: string): Promise<Uint8Array> => {
        const buf = await invoke<ArrayBuffer>("read_image_file", { path: p });
        return new Uint8Array(buf);
      };
      setImageBytesReader(createImageReader(nativeReadImage, exists));
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
        openVideos: true,
        filenameHint: path,
        h5wasmUrl: H5WASM_URL,
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
      });
    } else {
      await resolveExternalVideos(labels);
    }

    store.setLabels(labels, filename, path);
    openFirstLabeledFrame(labels);

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
