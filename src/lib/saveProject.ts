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
import { newDraftPath, removeLabelsDraft } from "@/lib/labelsDraft";
import { recordDraftSave, deleteDraftEntry } from "@/lib/draftManifest";
import { removeTauriDraft } from "@/lib/tauriDraft";
import { isSameSaveTarget } from "@/lib/saveTargetGuard";
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
 * Outcome of an in-memory browser save.
 *  - `durable: true`  — a VERIFIED write to a file we hold (File System Access
 *    in-place overwrite or Save-As): the bytes are on disk, so the crash-recovery
 *    draft can be dropped.
 *  - `durable: false` — a fire-and-forget anchor download (non-Chromium): the
 *    browser was HANDED a blob but we never see whether it landed, and it writes
 *    a NEW copy in Downloads, not the opened file. The recovery draft must be
 *    KEPT as a safety net in this case.
 */
interface InMemorySaveResult {
  name: string;
  durable: boolean;
}

/**
 * In-memory browser save (small files, or when the OPFS streaming path is
 * unavailable / falls back): serialize the whole file to bytes and deliver via
 * the File System Access API (Chromium) or an anchor download (elsewhere).
 * Returns the saved name + whether the write was durable (see
 * {@link InMemorySaveResult}), or null if the user cancelled the location picker.
 */
async function saveBrowserInMemory(
  labels: Labels,
  saveName: string,
  forceDialog: boolean
): Promise<InMemorySaveResult | null> {
  const store = useAppStore.getState();
  const bytes = await saveSlpToBytes(labels);
  const blob = new Blob([bytes], { type: "application/octet-stream" });

  if ("showSaveFilePicker" in window) {
    // SAVE (not Save-As) with a retained handle → overwrite the opened file in
    // place — no dialog, matching a native / PyQt save (#234). createWritable
    // writes atomically via a swap file, so overwriting the same file is safe;
    // the first such save may prompt once for write permission.
    const existingHandle = store.projectFileHandle;
    if (shouldOverwriteOpenedFile({ forceDialog, hasHandle: !!existingHandle }) && existingHandle) {
      try {
        if (await ensureReadWritePermission(existingHandle)) {
          console.log(
            `[save] Saving in place to the opened file (browser): ${existingHandle.name} (${bytes.byteLength} bytes)`
          );
          const writable = await existingHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          return { name: existingHandle.name, durable: true };
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
    // Save-As, no retained handle, or a failed in-place attempt: prompt for a
    // location, then RETAIN the chosen handle so subsequent saves write in place.
    console.log(
      `[save] Saving via browser Save-As picker (${bytes.byteLength} bytes)`
    );
    try {
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
      store.set("projectFileHandle", handle);
      store.set("filename", handle.name);
      return { name: handle.name, durable: true };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  // Non-Chromium: anchor download. This is NOT durable — the browser is handed a
  // blob (landing a NEW copy in Downloads, not the opened file) with no way to
  // observe success/failure, so the caller must KEEP the crash-recovery draft.
  console.log(
    `[save] Saving via browser anchor download (${bytes.byteLength} bytes)`
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = saveName;
  a.click();
  // Revoke on the next tick, not synchronously: revoking immediately after
  // click() can abort the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { name: saveName, durable: false };
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
        // Track the newly-saved name (basename) so the window title updates and,
        // for the .vNNN versioning, the NEXT Save As increments from the name we
        // just wrote instead of the stale opened name. The browser Save-As path
        // already does this via handle.name.
        store.set("filename", savePath.split(/[/\\]/).pop() ?? savePath);
        displayName = savePath;
      }

      // A verified write to the real disk file makes the crash-recovery draft
      // redundant — drop it + its manifest entry so it can't trigger a spurious
      // "recover unsaved work?" prompt on the next launch. (A cancelled Save-As
      // returned above, before reaching here, so the draft is kept in that case.)
      const tauriDraft = store.labelsDraftPath;
      if (tauriDraft) {
        void removeTauriDraft(tauriDraft);
        store.set("labelsDraftPath", null);
      }
    } else {
      // Browser save (EDL model): for a LARGE embedded pkg.slp the LABELS are the
      // working project and the images are a referenced, unchanging asset.
      //  - ⌘S / auto-save  -> persist ONLY the labels to a small OPFS draft
      //    (instant; no multi-GB image copy — the images stay in the original).
      //  - Save As / Export -> "compile" the full pkg.slp by merging the current
      //    labels with the ORIGINAL file's images (the one image pass, on demand).
      // Everything else (small files, no opened source, OPFS/picker unavailable)
      // uses the whole-file in-memory save. Routing: decideBrowserSaveAction.
      const hasEmbeddedImages = labels.videos.some((v) => v.hasEmbeddedImages);
      // Prefer the durable handle (re-read fresh at save time) over the File
      // snapshot, which can go stale by the time we read the images.
      const source = store.projectFileHandle ?? store.projectFile;
      // Size proxy for the large-pkg decision: the opened File's byte size.
      const estimatedOutputBytes = store.projectFile?.size ?? null;
      const action = decideBrowserSaveAction({
        hasEmbeddedImages,
        hasSource: !!source,
        isOpfsSupported: isOpfsSaveSupported(),
        estimatedOutputBytes,
        forceDialog,
      });

      if (action === "save-labels-draft") {
        // ⌘S / auto-save: persist just the labels (a bare-bones imageless .slp)
        // to a small OPFS draft. Instant — no image copy. The edit is durably
        // saved locally; the disk file is written only on an explicit Export.
        store.setLoading(true, "Saving labels...");
        const draftPath = store.labelsDraftPath ?? newDraftPath(saveName);
        // Commit the draft path synchronously (before any await) so a concurrent
        // auto-save sees it and doesn't mint a second draft (first-save race).
        store.set("labelsDraftPath", draftPath);
        // Persist the draft + record it in the manifest (with the original's
        // handle) so it's recoverable after a tab close (see draftManifest.ts).
        await recordDraftSave(labels, {
          draftPath,
          sourceHandle: store.projectFileHandle,
          displayName: saveName,
          savedAt: Date.now(),
          // Identity snapshot of the opened source (see draftManifest.ts) so a
          // later restore can detect an on-disk divergence before overwriting.
          sourceSize: store.projectFile?.size,
          sourceLastModified: store.projectFile?.lastModified,
        });
        store.set("pendingExport", true);
        store.clearChanges();
        console.log(`[save] Saved labels draft -> ${draftPath}`);
        toast.success("Saved locally", {
          description:
            "Labels saved instantly in your browser. Use Save As to export the full file to disk.",
        });
        return; // handled with our own toast — skip the shared success below
      }

      if (action === "compile-export") {
        // Save As / Export: compile the full pkg.slp to the chosen disk file by
        // merging the current labels with the original's images. Acquire the
        // destination NOW, synchronously off the save gesture (transient
        // activation), before the slow compile consumes it.
        if (!source) {
          throw new Error("no opened source to compile the embedded pkg from");
        }
        let destHandle: FileSystemFileHandle;
        try {
          destHandle = await pickSlpSaveDestination(saveName);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          throw err;
        }
        // DATA-LOSS GUARD: never compile INTO the file we read images FROM — the
        // destination's createWritable() truncates it first, so a mid-write
        // failure would zero the only copy (this already destroyed a test file).
        if (await isSameSaveTarget(source, destHandle)) {
          toast.warning("Choose a different filename", {
            description:
              "Saving over the currently-open project isn't supported in the browser yet. Pick a new filename so the original stays safe.",
          });
          return;
        }
        // Past the picker there is no gesture left to open another one, so a
        // build/stream failure here surfaces as a save error (the outer catch).
        store.setLoading(true, "Exporting to disk...");
        console.log("[save] Compiling full pkg.slp to disk (browser export)");
        let lastPct = -1;
        displayName = await saveEmbeddedPkgOpfs(
          labels,
          source,
          destHandle,
          (done, total) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            if (pct === lastPct) return; // throttle to once-per-percent
            lastPct = pct;
            store.setLoading(true, `Exporting to disk (${pct}%)`, pct);
          }
        );
        // Exported to disk: clear the pending flag and drop the local draft +
        // its manifest entry (its edits now live in the on-disk file, so there
        // is nothing left to recover).
        store.set("pendingExport", false);
        const draft = store.labelsDraftPath;
        if (draft) {
          void removeLabelsDraft(draft);
          void deleteDraftEntry(draft);
          store.set("labelsDraftPath", null);
        }
      } else {
        // action === "in-memory": small/regular file. Overwrite the opened file
        // in place (#234) when possible, else Save-As, else anchor download.
        const res = await saveBrowserInMemory(labels, saveName, forceDialog);
        if (res === null) return; // user cancelled the save dialog
        displayName = res.name;
        if (res.durable) {
          // VERIFIED write to disk (in-place or Save-As) → the disk copy is now
          // current, so drop any crash-recovery draft + its manifest entry + the
          // pending-export flag (nothing left to recover). Auto-save re-creates a
          // draft only if the user edits again.
          const draft = store.labelsDraftPath;
          if (draft) {
            void removeLabelsDraft(draft);
            void deleteDraftEntry(draft);
            store.set("labelsDraftPath", null);
          }
          store.set("pendingExport", false);
        }
        // else: anchor download — unverifiable and NOT the opened file, so KEEP
        // the recovery draft as a safety net. A later durable save / Export /
        // discard clears it; if the download silently failed, the user can still
        // resume from the draft.
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
