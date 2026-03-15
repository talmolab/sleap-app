/**
 * Save project helper.
 *
 * Serializes Labels to SLP (HDF5) format and triggers a browser download
 * using the File System Access API when available, with anchor fallback.
 */

import type { Labels } from "@talmolab/sleap-io.js";
import { saveSlpToBytes } from "@talmolab/sleap-io.js";
import { useAppStore } from "../stores/appStore";
import { toast } from "@/lib/notify";
import { getPlatform } from "../platform/index";

/**
 * Save a Labels object as an SLP file.
 *
 * Uses the File System Access API (showSaveFilePicker) when available for a
 * native save dialog, otherwise falls back to an anchor-based download.
 *
 * @param labels - The Labels object to serialize.
 * @param filename - Optional filename hint (e.g. from the loaded project).
 */
export async function saveProjectAsSlp(
  labels: Labels,
  filename?: string
): Promise<void> {
  const store = useAppStore.getState();
  store.setLoading(true, "Saving project...");

  const saveName = filename
    ? filename.replace(/\.slp$/, "") + ".slp"
    : "labels.slp";

  try {
    const bytes = await saveSlpToBytes(labels);
    const platform = await getPlatform();
    console.log(`[save] Saving project via ${platform.isTauri ? "Tauri" : "browser"} backend (${bytes.byteLength} bytes)`);

    if (platform.isTauri) {
      // Tauri: use native save dialog + filesystem write
      const savePath = await platform.showSaveDialog({
        filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
        defaultName: saveName,
      });
      if (!savePath) return;
      await platform.writeFile(savePath, bytes);
    } else if ("showSaveFilePicker" in window) {
      // Browser: File System Access API
      try {
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const handle = await (
          window as unknown as {
            showSaveFilePicker: (
              opts: unknown
            ) => Promise<FileSystemFileHandle>;
          }
        ).showSaveFilePicker({
          types: [
            {
              description: "SLEAP Labels",
              accept: { "application/octet-stream": [".slp"] },
            },
          ],
          suggestedName: saveName,
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (err: unknown) {
        // User cancelled the save dialog
        if (err instanceof DOMException && err.name === "AbortError") return;
        throw err;
      }
    } else {
      // Fallback: anchor download
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = saveName;
      a.click();
      URL.revokeObjectURL(url);
    }

    store.clearChanges();
    toast.success("Project saved", { description: saveName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to save project", { description: msg });
    console.error("[saveProjectAsSlp] Failed to save:", err);
  } finally {
    store.setLoading(false);
  }
}
