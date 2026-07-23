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
import type { PlatformAPI } from "../platform/index";
import { getPlatform } from "../platform/index";
import {
  saveEmbeddedPkgStreaming,
  tempPathFor,
} from "@/lib/saveEmbeddedPkgStreaming";
import { saveLabelsInPlace } from "@/lib/saveLabelsInPlace";
import { shouldStreamEmbeddedSave } from "@/lib/saveRouting";
import { fileSize } from "@/lib/nativeRange";
import { renameFile, removeFile } from "@/lib/nativeWrite";
import { shouldOverwriteOpenedFile } from "@/lib/browserSaveTarget";

/**
 * Human-readable byte size for the save progress text (e.g. "3.8 GB", "742 MB").
 * Keeps the loading-overlay message informative about how big a full rewrite is.
 */
function formatBytes(n: number): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** ` (3.8 GB)` when a size estimate is known, else `` — appended to a save
 *  progress message. */
function sizeSuffix(bytes: number | null): string {
  return bytes != null ? ` (${formatBytes(bytes)})` : "";
}

/**
 * Crash-safe write of already-serialized SLP `bytes` over `destPath` (desktop):
 * write to a sibling temp on the SAME filesystem, then atomically rename it over
 * `destPath`. A `platform.writeFile` straight to `destPath` is a truncate-then-
 * write in place, so a crash / network drop / disk-full mid-write would destroy
 * the user's only copy. Used for the in-memory embedded-pkg save path (small
 * files below the streaming threshold); the streaming path already does its own
 * temp+rename. On any failure the sibling temp is best-effort deleted and the
 * original `destPath` is untouched (the rename never ran).
 */
async function writeSlpBytesAtomic(
  platform: PlatformAPI,
  destPath: string,
  bytes: Uint8Array
): Promise<void> {
  const tempPath = tempPathFor(destPath);
  try {
    await platform.writeFile(tempPath, bytes);
    await renameFile(tempPath, destPath);
  } catch (err) {
    await removeFile(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Ensure we hold readwrite permission on `handle` so a Save can overwrite the
 * opened file without a Save-As dialog. Queries first (silent when already
 * granted — e.g. a prior save this session), then requests (a one-time browser
 * "allow this site to edit this file?" prompt). Returns false when permission
 * isn't granted, so the caller falls back to the Save-As picker. Must be reached
 * within the save gesture for the request prompt to be allowed.
 */
async function ensureReadWritePermission(
  handle: FileSystemFileHandle
): Promise<boolean> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  };
  // Engines without the permission API: assume writable and let the write
  // attempt (guarded by the caller's try/catch) be the arbiter.
  if (!h.queryPermission || !h.requestPermission) return true;
  const opts = { mode: "readwrite" as const };
  if ((await h.queryPermission(opts)) === "granted") return true;
  return (await h.requestPermission(opts)) === "granted";
}

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

    if (platform.isTauri) {
      const existingPath = !forceDialog ? store.projectPath : null;
      // The currently-open project's on-disk path — the streaming writer reads
      // embedded images FROM here, regardless of whether we're saving in place
      // or to a new Save-As destination.
      const sourcePath = store.projectPath;
      const hasEmbeddedImages = labels.videos.some((v) => v.hasEmbeddedImages);

      // Only route to the streaming writer when the output would exceed the
      // ~4 GB wasm heap wall — smaller embedded saves take the faster in-memory
      // path (which still preserves already-embedded frames). Estimate the
      // output size from the source pkg.slp on disk; the raw-copy path copies
      // its embedded blobs verbatim (never adds any), so source size is a close,
      // safe-on-the-high-side proxy. See saveRouting.ts. A failed probe => null
      // => stream (conservative). Probe once (only depends on sourcePath).
      let estimatedOutputBytes: number | null = null;
      if (hasEmbeddedImages && sourcePath) {
        try {
          estimatedOutputBytes = await fileSize(sourcePath);
        } catch (probeErr) {
          console.warn(
            `[save] source size probe failed for ${sourcePath}; defaulting to streaming`,
            probeErr
          );
          estimatedOutputBytes = null;
        }
      }
      const useStreaming = shouldStreamEmbeddedSave({
        isTauri: true,
        hasEmbeddedImages,
        hasSourcePath: !!sourcePath,
        estimatedOutputBytes,
      });

      if (existingPath) {
        // FAST PATH: for an in-place re-save of an already-embedded pkg.slp, try
        // patching ONLY the label tables in place first (no multi-GB image
        // re-copy). saveLabelsInPlace probes + gates the file and returns
        // {ok:false} when the edit isn't confined to the label tables (or COI /
        // the probe is unavailable) — then we fall through to the existing
        // streaming/in-memory full re-save below. It THROWS only if a failure
        // occurs after the in-place write began (the file may be inconsistent and
        // can't be rolled back), which propagates to the outer catch and surfaces
        // as a save error rather than silently full-rewriting. existingPath ===
        // sourcePath here (both are store.projectPath for a non-forced save).
        let savedInPlace = false;
        if (hasEmbeddedImages && sourcePath) {
          // Reuse the load overlay's progress mechanism (isLoading +
          // loadingMessage, rendered by AppShell) so the user can tell the fast
          // in-place path from a full rewrite.
          store.setLoading(true, "Saving changes in place...");
          const res = await saveLabelsInPlace(labels, existingPath);
          if (res.ok) {
            console.log(`[save] Saved via in-place label update (Tauri, fast path): ${existingPath}`);
            savedInPlace = true;
          } else {
            console.log(
              `[save] In-place not applicable (${res.reason}); falling back to full re-save`
            );
          }
        }
        if (!savedInPlace) {
          // Full rewrite (streaming or in-memory) — distinct text from the
          // in-place path, with the file size when we have an estimate.
          store.setLoading(true, `Rewriting file${sizeSuffix(estimatedOutputBytes)}...`);
          if (useStreaming && sourcePath) {
            console.log(
              `[save] Saving via streaming embedded-pkg writer (Tauri, in-place, ~${estimatedOutputBytes} bytes): ${existingPath}`
            );
            await saveEmbeddedPkgStreaming(labels, existingPath, sourcePath);
          } else {
            console.log(`[save] Saving via in-memory backend (Tauri, in-place): ${existingPath}`);
            const bytes = await saveSlpToBytes(labels);
            if (hasEmbeddedImages) {
              // Never truncate the embedded original in place — write+rename atomically.
              await writeSlpBytesAtomic(platform, existingPath, bytes);
            } else {
              await platform.writeFile(existingPath, bytes);
            }
          }
        }
        displayName = existingPath;
      } else {
        const savePath = await platform.showSaveDialog({
          filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
          defaultName: saveName,
        });
        if (!savePath) return;

        // Save-As is always a full write to a new path; show it (with size when
        // known) so it reads consistently with the in-place vs rewrite text.
        store.setLoading(true, `Writing file${sizeSuffix(estimatedOutputBytes)}...`);
        if (useStreaming && sourcePath) {
          console.log(
            `[save] Saving via streaming embedded-pkg writer (Tauri, Save As, ~${estimatedOutputBytes} bytes): ${savePath}`
          );
          await saveEmbeddedPkgStreaming(labels, savePath, sourcePath);
        } else {
          console.log(`[save] Saving via in-memory backend (Tauri, Save As): ${savePath}`);
          const bytes = await saveSlpToBytes(labels);
          if (hasEmbeddedImages) {
            // Never truncate an embedded destination in place — write+rename atomically.
            await writeSlpBytesAtomic(platform, savePath, bytes);
          } else {
            await platform.writeFile(savePath, bytes);
          }
        }
        store.set("projectPath", savePath);
        displayName = savePath;
      }
    } else if ("showSaveFilePicker" in window) {
      // Browser (File System Access API).
      const bytes = await saveSlpToBytes(labels);
      const blob = new Blob([bytes], { type: "application/octet-stream" });

      const existingHandle = store.projectFileHandle;
      const overwriteInPlace = shouldOverwriteOpenedFile({
        forceDialog,
        hasHandle: !!existingHandle,
      });

      // SAVE (not Save-As) with a retained handle: overwrite the opened file in
      // place — no dialog, matching a native / PyQt save. The bytes are fully
      // built above and createWritable writes atomically via a swap file, so
      // overwriting the same file can't corrupt it. The first such save may
      // prompt once for write permission; it's silent for the rest of the session.
      let savedInPlace = false;
      if (overwriteInPlace && existingHandle) {
        try {
          if (await ensureReadWritePermission(existingHandle)) {
            console.log(
              `[save] Saving in place to the opened file (browser): ${existingHandle.name} (${bytes.byteLength} bytes)`
            );
            const writable = await existingHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            displayName = existingHandle.name;
            savedInPlace = true;
          }
        } catch (err) {
          // Stale handle / revoked permission / write failure → fall back to the
          // Save-As picker rather than surfacing an error.
          console.warn(
            "[save] in-place save to the opened file failed; prompting Save As",
            err
          );
        }
      }

      if (!savedInPlace) {
        // Save-As, no retained handle, or a failed in-place attempt: prompt for a
        // location, then RETAIN the chosen handle so subsequent saves write back
        // to it in place.
        console.log(
          `[save] Saving via browser Save-As picker (${bytes.byteLength} bytes)`
        );
        try {
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
          store.set("projectFileHandle", handle);
          store.set("filename", handle.name);
          displayName = handle.name;
        } catch (err: unknown) {
          // User cancelled the save dialog
          if (err instanceof DOMException && err.name === "AbortError") return;
          throw err;
        }
      }
    } else {
      // Fallback: anchor download
      const bytes = await saveSlpToBytes(labels);
      console.log(`[save] Saving via browser anchor download (${bytes.byteLength} bytes)`);
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
