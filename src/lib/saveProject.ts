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
import { planEmbedPreservingSave } from "./embedPreservingSave";

/**
 * Save a Labels object as an SLP file.
 *
 * Uses the File System Access API (showSaveFilePicker) when available for a
 * native save dialog, otherwise falls back to an anchor-based download.
 *
 * @param labels - The Labels object to serialize.
 * @param filename - Optional filename hint (e.g. from the loaded project).
 * @param forceDialog - When true, always show the save dialog (Save As).
 */
export async function saveProjectAsSlp(
  labels: Labels,
  filename?: string,
  forceDialog = false
): Promise<void> {
  const store = useAppStore.getState();
  store.setLoading(true, "Saving project...");

  const saveName = filename
    ? filename.replace(/\.slp$/, "") + ".slp"
    : "labels.slp";

  let displayName = saveName;

  try {
    const platform = await getPlatform();
    const existingPath =
      platform.isTauri && !forceDialog ? store.projectPath : null;

    const isEmbedded = labels.videos.some((v) => v.hasEmbeddedImages);
    // Size-guard (#213): a >1 GB embedded pkg is opened via the range reader and can't
    // be re-embedded in wasm memory (saveSlpToBytes builds the whole file in MEMFS).
    // Refuse fast rather than OOM mid-save.
    if (isEmbedded && store.isRangeLoaded) {
      toast.error("Save aborted — package too large to re-save here", {
        description:
          "This embedded package was opened via the large-file range reader and can't be re-embedded in memory yet. Use the desktop PyQt SLEAP app. Your file was not modified.",
      });
      return;
    }

    // Embedded (pkg.slp) projects: saveSlpToBytes drops the embedded image
    // datasets unless an embed mode is passed (#213). The plan picks the mode
    // and temporarily marks not-otherwise-covered embedded frames as
    // suggestions so the save is lossless.
    const plan = await planEmbedPreservingSave(labels);
    let bytes: Uint8Array;
    try {
      if (plan.unreadable.length > 0) {
        if (existingPath) {
          // Overwriting in place would destroy images we cannot re-read.
          toast.error("Save aborted to protect embedded frames", {
            description:
              `${plan.unreadable.length} embedded video(s) could not be read back. ` +
              "The file was NOT overwritten. Use Save As to write a copy.",
          });
          return;
        }
        toast.warning("Some embedded frames will be missing", {
          description:
            `${plan.unreadable.length} embedded video(s) could not be read back; ` +
            "the saved copy will not include their images. The original file is untouched.",
        });
      }
      bytes = await saveSlpToBytes(
        labels,
        plan.embed ? { embed: plan.embed } : undefined
      );
    } finally {
      plan.restore();
    }
    console.log(`[save] Saving project via ${platform.isTauri ? "Tauri" : "browser"} backend (${bytes.byteLength} bytes)`);

    if (platform.isTauri) {
      if (existingPath) {
        await platform.writeFile(existingPath, bytes);
        displayName = existingPath;
      } else {
        const savePath = await platform.showSaveDialog({
          filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
          defaultName: saveName,
        });
        if (!savePath) return;
        if (plan.unreadable.length > 0 && savePath === store.projectPath) {
          // Same protection as the in-place branch: this copy is missing
          // embedded images, so it must not replace the original.
          toast.error("Save aborted to protect embedded frames", {
            description:
              "The chosen path is the open project file, and some embedded " +
              "videos could not be read back. Pick a different file name.",
          });
          return;
        }
        await platform.writeFile(savePath, bytes);
        store.set("projectPath", savePath);
        displayName = savePath;
      }
    } else if ("showSaveFilePicker" in window) {
      // Browser: File System Access API (always shows picker)
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
        displayName = handle.name;
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
    toast.success("Project saved", { description: displayName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Failed to save project", { description: msg });
    console.error("[saveProjectAsSlp] Failed to save:", err);
  } finally {
    store.setLoading(false);
  }
}
