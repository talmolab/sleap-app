/**
 * Desktop (Tauri) crash-recovery: restore a lingering labels draft on launch.
 *
 * The desktop draft ({@link import("@/lib/tauriDraft")}) is imageless — it holds
 * the edited labels + video REFS, no pixels. Because a successful ⌘S / discard
 * clears the draft, ANY draft still on disk at launch means work was unsaved when
 * the app last stopped (a crash, or an unsaved quit). On startup we offer to
 * recover the newest such draft; on accept we re-open its labels and re-attach the
 * ORIGINAL project file's images (desktop paths are durable, so this reuses the
 * same resolver / streaming machinery as {@link import("@/lib/loadProject")}):
 *
 *  - Regular / external-video / image-sequence projects: the draft already carries
 *    the full labels + real on-disk video refs, so we just resolve those videos by
 *    path (installTauriFsResolver + installTauriImageReader + resolveExternalVideos).
 *  - Embedded pkg.slp projects: the draft has no pixels, so we re-open the ORIGINAL
 *    pkg (lazily — the range reader reads image datasets on demand) and graft its
 *    per-video backends onto the draft's videos BY SIGNATURE (identity), never by
 *    position, so a diverged/reordered video set can't silently attach the wrong
 *    footage.
 *
 * The recovered project is re-linked to the original's disk path so a later ⌘S
 * overwrites it in place — UNLESS the on-disk file diverged since the draft was
 * saved (another process wrote it), in which case we still restore the labels but
 * force Save-As so ⌘S can't clobber the newer file. The project stays DIRTY vs
 * disk after restore (the draft is only a net; the disk file is still stale until
 * the user ⌘S-es).
 *
 * The prompt + real filesystem reads are Tauri-only, so this is manual/tauri-pilot-
 * verified (happy-dom has no Tauri fs), like the browser {@link
 * import("@/lib/draftRestore")}.
 */
import {
  loadSlp,
  readSlpStreaming,
  type Labels,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import { toast } from "@/lib/notify";
import {
  reportParseProgress,
  installTauriImageReader,
} from "@/lib/loadProject";
import { resolveExternalVideos } from "@/lib/resolveVideos";
import { installTauriFsResolver } from "@/lib/fsResolver";
import { fileSize, readRange } from "@/lib/nativeRange";
import { videoSignature, buildBackendGraftPlan } from "@/lib/videoGraft";
import { isSourceChanged } from "@/lib/draftStaleness";
import {
  listTauriDraftEntries,
  removeTauriDraft,
  tauriDraftExists,
} from "@/lib/tauriDraft";
import type { TauriDraftManifestEntry } from "@/lib/tauriDraftManifest";

// Same threshold + h5wasm URL as loadProject.ts: files over ~1 GB open via the
// native range reader (lazy, on-disk) instead of being read whole into WASM.
const RANGE_READER_THRESHOLD = 1_000_000_000;
const LAZY_VIDEO_METADATA = true;
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/**
 * Read a `.slp` from a disk `path`, size-adaptively: stream large files via the
 * native range reader (never materialized in WASM), read small ones eagerly.
 * Mirrors loadProject.ts's adaptive read; kept self-contained here so the
 * critical project-open path stays untouched.
 */
async function readLabelsFromPath(
  path: string,
  readFile: (p: string) => Promise<Uint8Array>,
  opts?: { lazyVideoMetadata?: boolean },
): Promise<Labels> {
  const lazyMeta = opts?.lazyVideoMetadata ?? LAZY_VIDEO_METADATA;
  let bytes = 0;
  try {
    bytes = await fileSize(path);
  } catch {
    bytes = 0;
  }
  if (bytes > RANGE_READER_THRESHOLD) {
    return readSlpStreaming(
      { size: bytes, readRange: (o: number, l: number) => readRange(path, o, l) },
      {
        openVideos: !lazyMeta,
        lazyVideoMetadata: lazyMeta,
        filenameHint: path,
        h5wasmUrl: H5WASM_URL,
        onProgress: reportParseProgress,
      },
    );
  }
  const raw = await readFile(path);
  return loadSlp(raw, {
    openVideos: true,
    h5: { filenameHint: path, h5wasmUrl: H5WASM_URL },
    onProgress: reportParseProgress,
  });
}

/** Graft each original video's (lazy) backend onto the draft's video with the
 *  same SIGNATURE so recovered labels render frames from the original on demand.
 *  Unmatched draft videos keep a null backend (blank frames) — never a wrong one. */
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
      draft.videos[i].backend = original.videos[origIdx].backend;
      matched++;
    }
  });
  return { matched, total: draft.videos.length };
}

/**
 * Decide whether it's safe to re-link the original's disk path so a later ⌘S
 * overwrites it IN PLACE. If the on-disk file changed since the draft was saved
 * (size or mtime), or we can't verify (no snapshot / stat failed), return null so
 * the caller forces Save-As rather than risk clobbering a newer file. On desktop
 * a stat is cheap and paths are durable, so a clean stat is the norm.
 */
async function safeRestoreProjectPath(
  entry: TauriDraftManifestEntry,
): Promise<string | null> {
  if (!entry.projectPath) return null;
  if (entry.sourceSize == null && entry.sourceLastModified == null) {
    // No snapshot recorded — can't verify; assume unchanged on desktop (durable
    // single-user paths) and re-link in place.
    return entry.projectPath;
  }
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(entry.projectPath);
    const current = {
      size: info.size ?? 0,
      lastModified: info.mtime ? new Date(info.mtime).getTime() : 0,
    };
    const changed = isSourceChanged(
      { size: entry.sourceSize, lastModified: entry.sourceLastModified },
      current,
    );
    if (changed) {
      toast.warning("The project file changed since this draft", {
        description:
          "Recovered your unsaved edits, but the file on disk changed since — use Save As to avoid overwriting the other version.",
      });
      return null;
    }
    return entry.projectPath;
  } catch {
    return null; // unverifiable → safe fallback (Save-As on the next save)
  }
}

/**
 * Restore `entry` as the active project. Returns true on success, false on a
 * handled failure (the draft file vanished / the original couldn't be matched).
 * Errors surface as a toast.
 */
export async function restoreTauriDraft(
  entry: TauriDraftManifestEntry,
): Promise<boolean> {
  const store = useAppStore.getState();
  store.setLoading(true, "Recovering unsaved work...");
  try {
    const { readFile, exists } = await import("@tauri-apps/plugin-fs");
    // Resolve external / image-sequence sources against disk (same as an open).
    installTauriFsResolver(exists);
    await installTauriImageReader();

    // The draft itself is always imageless (small) → an eager read is fine.
    const draftBytes = await readFile(entry.draftPath);
    const draftLabels = await loadSlp(draftBytes, {
      // Embedded pkg: skip opening (imageless) — we graft the original's backends.
      openVideos: !entry.embedded,
      h5: {
        filenameHint: entry.projectPath ?? entry.draftPath,
        h5wasmUrl: H5WASM_URL,
      },
    });

    if (entry.embedded && entry.projectPath && (await exists(entry.projectPath))) {
      // Re-open the ORIGINAL pkg (lazily) and graft its image backends by
      // signature so the recovered labels render frames from the original.
      store.setLoading(true, "Re-opening the original for images...");
      const originalLabels = await readLabelsFromPath(entry.projectPath, readFile);
      const draftSigs =
        entry.videoSignatures?.length === draftLabels.videos.length
          ? entry.videoSignatures
          : draftLabels.videos.map((v) =>
              videoSignature({ filename: v.filename, shape: v.shape }),
            );
      const { matched, total } = graftBackends(
        draftLabels,
        originalLabels,
        draftSigs,
      );
      if (matched === 0 && total > 0) {
        toast.warning("Couldn't re-attach images", {
          description:
            "The original project's videos didn't match the recovered draft; frames may be blank until you relocate the videos.",
        });
      } else if (matched < total) {
        toast.warning("Some videos couldn't be matched", {
          description: `${total - matched} of ${total} video(s) weren't found in the original; those frames will be blank.`,
        });
      }
    }

    store.setLoading(true, "Locating videos...");
    if (entry.embedded) {
      // Embedded pkg: images come from the grafted backends above; there are no
      // external video files to relocate (resolveExternalVideos only touches
      // videos still MISSING, so it leaves the grafted ones intact).
      await resolveExternalVideos(draftLabels);
    } else if (entry.projectPath) {
      // External videos / image sequences: resolve them against disk relative to
      // the original project's directory, exactly like loadProjectFromPath.
      await resolveExternalVideos(draftLabels, {
        projectPath: entry.projectPath,
        exists,
        readFile,
        lazy: true,
      });
    } else {
      await resolveExternalVideos(draftLabels);
    }

    // Re-link the original's disk path so a later ⌘S overwrites it in place —
    // unless it diverged on disk (then force Save-As so we never clobber it).
    const projectPath = await safeRestoreProjectPath(entry);
    const filename =
      (entry.projectPath ?? entry.displayName).split(/[\\/]/).pop() ??
      entry.displayName;
    store.setLabels(draftLabels, filename, projectPath ?? undefined);

    // The desktop draft is only a net — the recovered project is still DIRTY vs
    // disk until the user ⌘S-es. Mark it changed and keep editing on the SAME
    // draft (a subsequent ⌘S clears it).
    store.markChanged();
    store.set("labelsDraftPath", entry.draftPath);
    toast.success("Recovered unsaved work", {
      description: `${entry.displayName} — save to disk when ready`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error("Couldn't recover unsaved work", { description: msg });
    console.error("[draftRestoreTauri] restore failed:", err);
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * On launch, offer to recover the newest lingering draft (crash / unsaved quit).
 * No-op when: not Tauri, a project is already loaded (e.g. a file-association
 * launch), or no recorded draft still exists on disk. On decline, the draft +
 * manifest entry are removed so it won't re-prompt. Best-effort — never throws.
 */
export async function maybeRestoreTauriDraft(): Promise<void> {
  if (!isTauri) return;
  // Don't fight an initial-file / drag-drop open that already loaded a project.
  if (useAppStore.getState().projectLoaded) return;
  try {
    const entries = await listTauriDraftEntries();
    // Newest entry whose draft file still exists on disk.
    let entry: TauriDraftManifestEntry | null = null;
    for (const e of entries) {
      if (await tauriDraftExists(e.draftPath)) {
        entry = e;
        break;
      }
    }
    if (!entry) return;
    // Re-check: an initial-file open may have completed while we read the manifest.
    if (useAppStore.getState().projectLoaded) return;

    const accepted = window.confirm(
      `Recover unsaved work from "${entry.displayName}"?\n\n` +
        "SLEAP found labels that weren't saved to disk before it last closed. " +
        "Choose Cancel to discard them.",
    );
    if (accepted) {
      await restoreTauriDraft(entry);
    } else {
      await removeTauriDraft(entry.draftPath);
    }
  } catch (err) {
    console.warn("[draftRestoreTauri] recovery check failed:", err);
  }
}
