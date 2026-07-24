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
import {
  shouldStreamEmbeddedSave,
  decideBrowserSaveAction,
} from "@/lib/saveRouting";
import { fileSize } from "@/lib/nativeRange";
import { renameFile, removeFile } from "@/lib/nativeWrite";
import {
  saveEmbeddedPkgOpfs,
  isOpfsSaveSupported,
  pickSlpSaveDestination,
} from "@/lib/saveEmbeddedPkgOpfs";
import {
  seedWorkingCopy,
  commitToWorkingCopy,
  exportWorkingCopy,
  newWorkingCopyPath,
  type WorkingCopy,
} from "@/lib/opfsWorkingCopy";
import { isSameSaveTarget } from "@/lib/saveTargetGuard";

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
 * In-memory browser save (small files, or when the OPFS streaming path is
 * unavailable / falls back): serialize the whole file to bytes and deliver via
 * the File System Access API (Chromium) or an anchor download (elsewhere).
 * Returns the saved name, or null if the user cancelled the save-location picker.
 */
async function saveBrowserInMemory(
  labels: Labels,
  saveName: string
): Promise<string | null> {
  const bytes = await saveSlpToBytes(labels);
  if ("showSaveFilePicker" in window) {
    console.log(
      `[save] Saving via browser File System Access API (${bytes.byteLength} bytes)`
    );
    try {
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
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
      return handle.name;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }
  console.log(
    `[save] Saving via browser anchor download (${bytes.byteLength} bytes)`
  );
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = saveName;
  a.click();
  URL.revokeObjectURL(url);
  return saveName;
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
    } else {
      // Browser save. A LARGE already-embedded pkg.slp uses a durable OPFS
      // working copy: ⌘S seeds it once then patches it IN PLACE (instant — no
      // multi-GB disk write), and an explicit Save As / Export streams that copy
      // to the user's chosen file. Everything else (small files, no opened
      // source, OPFS/picker unavailable) uses the whole-file in-memory save
      // (which still preserves already-embedded frames). Routing decided by
      // decideBrowserSaveAction — see saveRouting.ts.
      const hasEmbeddedImages = labels.videos.some((v) => v.hasEmbeddedImages);
      // Prefer the durable handle (re-read fresh at save time) over the File
      // snapshot, which can go stale by the time we read the images.
      const source = store.projectFileHandle ?? store.projectFile;
      const workingCopy = store.workingCopy;
      // Size proxy for the seed-vs-in-memory decision: the opened File's byte
      // size. The raw-copy path never ADDS embedded data, so this tracks output
      // size closely and errs high (the safe side). null => over-threshold.
      const estimatedOutputBytes = store.projectFile?.size ?? null;
      const action = decideBrowserSaveAction({
        hasEmbeddedImages,
        hasSource: !!source,
        isOpfsSupported: isOpfsSaveSupported(),
        estimatedOutputBytes,
        hasWorkingCopy: !!workingCopy,
        forceDialog,
      });

      if (action === "seed-working-copy" || action === "commit-working-copy") {
        // ⌘S fast-save: maintain the durable OPFS working copy. No disk picker;
        // the edit is safe in OPFS and the user writes it to disk with an
        // explicit Save As / Export (which clears the pending-export flag).
        let wc: WorkingCopy;
        if (action === "seed-working-copy") {
          // A large-pkg seed is only routed here when a source is present (the
          // routing gate requires it); assert for the type narrower.
          if (!source) {
            throw new Error("no opened source to seed the working copy from");
          }
          // Seeding copies the embedded images into OPFS once — as slow as a
          // full save; every subsequent ⌘S is then an instant in-place patch.
          store.setLoading(true, "Preparing fast save (one-time)...");
          console.log("[save] Seeding OPFS working copy (browser fast-save)");
          wc = await seedWorkingCopy(labels, source, newWorkingCopyPath(saveName));
        } else {
          // Usually an instant label-table patch; a structural edit (track/video
          // change) re-seeds a fresh copy, which is slower but still local.
          store.setLoading(true, "Saving locally...");
          console.log(
            "[save] Committing edit to OPFS working copy (browser fast-save)"
          );
          wc = await commitToWorkingCopy(labels, workingCopy!, {
            projectName: saveName,
          });
        }
        store.set("workingCopy", wc);
        store.set("workingCopyPendingExport", true);
        store.clearChanges();
        toast.success("Saved locally", {
          description:
            "Saved in your browser. Use Save As to write the full file to disk.",
        });
        return; // handled with our own toast — skip the shared success below
      }

      if (action === "export-working-copy" || action === "opfs-stream") {
        // Save As / Export: write the full file to the user's chosen disk file.
        // Acquire the destination NOW, synchronously off the save gesture:
        // showSaveFilePicker requires transient activation, which the slow build
        // / stream would otherwise consume ("Must be handling a user gesture").
        let destHandle: FileSystemFileHandle;
        try {
          destHandle = await pickSlpSaveDestination(saveName);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          throw err;
        }
        // DATA-LOSS GUARD: never stream INTO the file we read images FROM — the
        // destination's createWritable() truncates it first, so a mid-save
        // failure would zero the only copy (this already destroyed a test file).
        // Exporting the working copy reads OPFS (not `source`), but the guard
        // still protects the currently-open original from being overwritten.
        if (source && (await isSameSaveTarget(source, destHandle))) {
          toast.warning("Choose a different filename", {
            description:
              "Saving over the currently-open project isn't supported in the browser yet. Pick a new filename so the original stays safe.",
          });
          return;
        }
        // Past the picker there is no gesture left to open another one, so a
        // build/stream failure here surfaces as a save error (the outer catch).
        if (action === "export-working-copy" && workingCopy) {
          // Bring the working copy CURRENT with any edits made since the last
          // ⌘S before streaming it — otherwise we'd export stale bytes (the
          // working copy only reflects the last seed/commit) and then clear the
          // dirty flag, silently dropping the newest edits from the disk file.
          // This is the cheap in-place label patch on the common path (a
          // structural edit re-seeds); no multi-GB image re-copy.
          let wc = workingCopy;
          if (store.hasChanges) {
            store.setLoading(true, "Saving changes...");
            wc = await commitToWorkingCopy(labels, wc, { projectName: saveName });
            store.set("workingCopy", wc);
          }
          store.setLoading(true, "Exporting to disk...");
          console.log("[save] Exporting OPFS working copy to disk");
          displayName = await exportWorkingCopy(wc, destHandle);
        } else {
          if (!source) {
            throw new Error("no opened source to stream the embedded pkg from");
          }
          store.setLoading(true, "Saving large project (streaming to disk)...");
          console.log("[save] Saving via browser OPFS streaming writer");
          displayName = await saveEmbeddedPkgOpfs(labels, source, destHandle);
        }
        store.set("workingCopyPendingExport", false);
      } else {
        // action === "in-memory"
        const name = await saveBrowserInMemory(labels, saveName);
        if (name === null) return; // user cancelled the save dialog
        displayName = name;
      }
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
