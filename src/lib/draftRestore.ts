/**
 * Restore a recoverable labels draft (resume-after-close).
 *
 * The draft holds the edited labels but no images. To resume WITH images we
 * re-open the ORIGINAL file (lazily — the range reader reads image datasets on
 * demand, no multi-GB copy) and graft its per-video backends onto the draft's
 * videos by index. `Video.backend` is a plain assignable field, so this needs no
 * io change and no image copy: the restored project renders frames on demand
 * straight from the original, exactly like a normal open. The user keeps editing
 * (⌘S / auto-save update the same draft) and Exports to disk when ready.
 */
import { loadSlp, type Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { resolveExternalVideos } from "@/lib/resolveVideos";
import { removeLabelsDraft } from "@/lib/labelsDraft";
import { deleteDraftEntry, type DraftManifestEntry } from "@/lib/draftManifest";
import { toast } from "@/lib/notify";

const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/** File System Access permission API (not in the standard DOM lib types). */
interface PermissionedHandle {
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
}

async function readOpfsFile(opfsPath: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(opfsPath, { create: false });
  return fh.getFile();
}

/** Prompt the user to re-select the original file (drag-drop opens have no
 *  durable handle, or a saved handle's permission was revoked). */
async function pickOriginal(): Promise<FileSystemFileHandle | null> {
  if (!("showOpenFilePicker" in window)) return null;
  try {
    const [handle] = await (
      window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }
    ).showOpenFilePicker({
      types: [
        {
          description: "SLEAP Labels",
          accept: { "application/octet-stream": [".slp"] },
        },
      ],
    });
    return handle ?? null;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/** Ensure read access to the original: use the saved handle if its permission
 *  is (or can be re-)granted, else ask the user to re-select the file. Must be
 *  called from a user gesture (the Restore click). */
async function resolveSourceHandle(
  entry: DraftManifestEntry,
): Promise<FileSystemFileHandle | null> {
  const handle = entry.sourceHandle as (FileSystemFileHandle & PermissionedHandle) | null;
  if (handle?.requestPermission) {
    const state =
      (await handle.queryPermission?.({ mode: "read" })) ?? "prompt";
    if (state === "granted") return handle;
    const asked = await handle.requestPermission({ mode: "read" });
    if (asked === "granted") return handle;
  } else if (handle) {
    // Handle without the permission API (older engines) — try to read directly.
    return handle;
  }
  // No usable handle → re-select.
  return pickOriginal();
}

/** Graft each original video's (lazy) backend onto the draft's video at the same
 *  index, so the restored labels render frames from the original on demand. */
function graftBackends(draft: Labels, original: Labels): number {
  const n = Math.min(draft.videos.length, original.videos.length);
  for (let i = 0; i < n; i++) {
    draft.videos[i].backend = original.videos[i].backend;
  }
  return n;
}

/**
 * Restore `entry` as the active project. Returns true on success, false if the
 * user cancelled (e.g. dismissed the file re-picker). Throws surface as a toast.
 */
export async function restoreDraft(entry: DraftManifestEntry): Promise<boolean> {
  const store = useAppStore.getState();
  store.setLoading(true, "Restoring unsaved work...");
  try {
    const sourceHandle = await resolveSourceHandle(entry);
    if (!sourceHandle) return false; // cancelled the re-picker

    // Draft labels (imageless — don't open its empty backends).
    const draftFile = await readOpfsFile(entry.draftPath);
    const draftLabels = await loadSlp(draftFile, {
      openVideos: false,
      h5: { h5wasmUrl: H5WASM_URL },
    });

    // Original, opened lazily for its on-demand image backends.
    store.setLoading(true, "Re-opening the original for images...");
    const originalFile = await sourceHandle.getFile();
    const originalLabels = await loadSlp(originalFile, {
      openVideos: true,
      h5: { h5wasmUrl: H5WASM_URL },
    });

    const grafted = graftBackends(draftLabels, originalLabels);
    if (grafted < draftLabels.videos.length) {
      // Video sets diverged (e.g. a video was added/removed since) — some frames
      // will lack images. Surface it rather than silently showing black frames.
      toast.warning("Some videos couldn't be matched", {
        description:
          "The original file's videos don't line up with the saved draft; those frames may be blank.",
      });
    }
    await resolveExternalVideos(draftLabels);

    // Make the restored draft the active project: keep the original as the image
    // source + the same draft path so further ⌘S/auto-save continue it, and it
    // still needs an explicit Export to reach disk.
    store.setLabels(
      draftLabels,
      entry.displayName,
      undefined,
      originalFile,
      sourceHandle,
    );
    store.set("labelsDraftPath", entry.draftPath);
    store.set("pendingExport", true);
    toast.success("Restored unsaved work", {
      description: `${entry.displayName} — export to disk when ready`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Couldn't restore unsaved work", { description: msg });
    console.error("[restoreDraft] failed:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/** Discard a recoverable draft: remove its OPFS file + manifest entry. */
export async function discardDraft(entry: DraftManifestEntry): Promise<void> {
  await removeLabelsDraft(entry.draftPath);
  await deleteDraftEntry(entry.draftPath);
}
