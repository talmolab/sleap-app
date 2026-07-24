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
import { reportParseProgress } from "@/lib/loadProject";
import { resolveExternalVideos } from "@/lib/resolveVideos";
import { removeLabelsDraft } from "@/lib/labelsDraft";
import { deleteDraftEntry, type DraftManifestEntry } from "@/lib/draftManifest";
import { videoSignature, buildBackendGraftPlan } from "@/lib/videoGraft";
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
function graftBackends(
  draft: Labels,
  original: Labels,
  draftSigs: string[],
): { matched: number; total: number } {
  const originalSigs = original.videos.map((v) =>
    videoSignature({ filename: v.filename, shape: v.shape }),
  );
  const plan = buildBackendGraftPlan(draftSigs, originalSigs);
  let matched = 0;
  plan.forEach((origIdx, i) => {
    if (origIdx != null) {
      // Same video (by signature) — attach its on-demand backend.
      draft.videos[i].backend = original.videos[origIdx].backend;
      matched++;
    }
    // else: no matching original video → leave backend null (blank frames),
    // NEVER graft a mismatched video's images.
  });
  return { matched, total: draft.videos.length };
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

    // Original, opened lazily for its on-demand image backends. Reuse the same
    // parse-progress reporter as Open Project so the overlay shows a real bar,
    // not just a spinner.
    store.setLoading(true, "Re-opening the original for images...");
    const originalFile = await sourceHandle.getFile();
    const originalLabels = await loadSlp(originalFile, {
      openVideos: true,
      h5: { h5wasmUrl: H5WASM_URL },
      onProgress: reportParseProgress,
    });

    // Match the draft's videos to the original by SIGNATURE (identity), not
    // position, so a removed/reordered video — or a wrong re-picked file — never
    // silently grafts the wrong images. Prefer the signatures recorded at save
    // time (captured with live backends); fall back to the loaded draft's.
    const draftSigs =
      entry.videoSignatures?.length === draftLabels.videos.length
        ? entry.videoSignatures
        : draftLabels.videos.map((v) =>
            videoSignature({ filename: v.filename, shape: v.shape }),
          );
    const { matched, total } = graftBackends(draftLabels, originalLabels, draftSigs);
    if (matched === 0 && total > 0) {
      // No video lined up — almost certainly the wrong file was selected. Abort
      // rather than load an all-blank project over the user's labels.
      toast.error("That file doesn't match the saved draft", {
        description:
          "None of the draft's videos were found in the selected file. Restore cancelled — choose the original project file.",
      });
      return false;
    }
    if (matched < total) {
      toast.warning("Some videos couldn't be matched", {
        description: `${total - matched} of ${total} video(s) weren't found in the original; those frames will be blank.`,
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
    if (err instanceof DOMException && err.name === "NotFoundError") {
      // The draft's OPFS file is gone (discarded elsewhere / evicted). Prune the
      // stale manifest entry so it stops reappearing as a phantom restore card.
      void deleteDraftEntry(entry.draftPath);
      toast.error("That unsaved draft is no longer available", {
        description: "It was removed or evicted; the entry has been cleared.",
      });
      return false;
    }
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
