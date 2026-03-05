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

import { loadSlp } from "@talmolab/sleap-io.js";
import { useAppStore } from "../stores/appStore";
import { toast } from "sonner";
import { resolveExternalVideos } from "./resolveVideos";

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
      h5: { filenameHint: file.name },
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
 * Reads the file bytes first, then loads.
 */
export async function loadProjectFromPath(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>
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
    const bytes = await readFile(path);
    const labels = await loadSlp(bytes.buffer, {
      openVideos: true,
      h5: { filenameHint: path },
    });
    await resolveExternalVideos(labels);
    store.setLabels(labels, filename);
    toast.success(`Loaded ${filename}`, {
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
