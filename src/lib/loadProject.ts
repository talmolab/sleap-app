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

import { loadSlp, setImageBytesReader } from "@talmolab/sleap-io.js";
import { useAppStore } from "../stores/appStore";
import { toast } from "@/lib/notify";
import { resolveExternalVideos } from "./resolveVideos";
import { setImageProjectDir, createImageReader } from "./imageVideoReader";

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

  store.setLoading(true, `Loading ${file.name}...`);

  try {
    const labels = await loadSlp(file, {
      openVideos: true,
    });
    await resolveExternalVideos(labels);
    store.setLabels(labels, file.name);
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
  store.setLoading(true, `Loading ${filename}...`);

  try {
    // Make ImageVideo (image-sequence) frames resolvable on desktop: resolve
    // relative image paths against the project directory, and read their bytes
    // through Tauri's plugin-fs. This MUST be set before loadSlp, which opens
    // ImageVideoBackend inline (it decodes frame 0 for the shape). When a path
    // can't be resolved the reader throws and sleap-io.js's load guard records
    // video.backendError instead of aborting the load.
    const sep = path.includes("\\") ? "\\" : "/";
    setImageProjectDir(path.substring(0, path.lastIndexOf(sep)));
    if (exists) setImageBytesReader(createImageReader(readFile, exists));

    const bytes = await readFile(path);
    const labels = await loadSlp(bytes, {
      openVideos: true,
      h5: { filenameHint: path },
    });

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

    const missingVideos = labels.videos.filter((v) => v.backend === null && !v.hasEmbeddedImages);

    toast.success(`Loaded ${filename}`, {
      description: `${labels.videos.length} video(s), ${labels.labeledFrames.length} labeled frames`,
    });

    if (missingVideos.length > 0) {
      toast.info(`${missingVideos.length} video(s) not found`, {
        description: "Use the Videos panel to locate them.",
      });
    }

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
