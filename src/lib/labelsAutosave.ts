/**
 * Debounced background auto-save of the labels DRAFT for the browser EDL-style
 * fast-save (see labelsDraft.ts). Like a video editor auto-saving its edit list:
 * as you edit, the labels are persisted to a small local OPFS draft a beat after
 * you stop — instant, silent, no toast, no image copy. The heavy full-file
 * "compile" stays a manual, explicit Export.
 *
 * EVERY browser project gets this crash-recovery net (the browser is an unstable
 * environment), not just large pkgs. For a large embedded pkg the draft is also
 * ⌘S's primary save target, so a draft-write marks the project clean; for a
 * small/regular .slp the draft is ONLY a net (⌘S writes disk), so it stays dirty
 * until saved to disk. The desktop is untouched (its ⌘S already writes to disk).
 */
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import { decideBrowserSaveAction } from "@/lib/saveRouting";
import { isOpfsSaveSupported } from "@/lib/saveEmbeddedPkgOpfs";
import { newDraftPath } from "@/lib/labelsDraft";
import { recordDraftSave } from "@/lib/draftManifest";

/** Save the draft this long after edits settle. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

/** Serialize the whole draft each time, so overlapping runs would double-write;
 *  a single-flight guard keeps only one in flight. */
let inFlight = false;

/**
 * Auto-save the current labels to the OPFS draft IF the project is a browser
 * large-embedded-pkg with unsaved edits and no save/compile already running.
 * Silent (no toast/overlay). `reArm` (when given) is invoked to reschedule a
 * retry whenever this run is skipped (busy), fails, or an edit lands mid-save —
 * because the edit-counter subscription only fires on NEW edits, so a run that
 * can't complete must re-arm itself or autosave would stall until the next edit.
 */
export async function maybeAutosaveLabelsDraft(
  reArm?: () => void,
): Promise<void> {
  if (inFlight || isTauri) return;
  const store = useAppStore.getState();
  const labels = store.labels;
  // OPFS is where the draft lives (broadly available — not gated on the Chromium
  // save picker). Don't race a manual save/compile (they own the overlay).
  const hasOpfs =
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function";
  if (!labels || !store.hasChanges || store.isLoading || !hasOpfs) {
    if (labels && store.hasChanges && hasOpfs && reArm) reArm();
    return;
  }

  // Auto-save a crash-recovery draft for ANY browser project — not just large
  // pkgs. Whether ⌘S's PRIMARY target is the draft (large embedded pkg) or the
  // disk file (small/regular .slp) decides whether a successful draft-write also
  // marks the project clean: for a large pkg the draft IS the save, so clearing
  // hasChanges is correct; for a small file the disk copy is still stale, so it
  // stays dirty (the draft is only a safety net) until ⌘S writes disk.
  const source = store.projectFileHandle ?? store.projectFile;
  const targetIsDraft =
    decideBrowserSaveAction({
      hasEmbeddedImages: labels.videos.some((v) => v.hasEmbeddedImages),
      hasSource: !!source,
      isOpfsSupported: isOpfsSaveSupported(),
      estimatedOutputBytes: store.projectFile?.size ?? null,
      forceDialog: false,
    }) === "save-labels-draft";

  inFlight = true;
  const seqAtStart = store.editSeq;
  try {
    // Mint + COMMIT the draft path synchronously (before any await) so a
    // concurrent manual ⌘S sees it and doesn't mint a second draft.
    const draftPath =
      store.labelsDraftPath ?? newDraftPath(store.filename ?? undefined);
    store.set("labelsDraftPath", draftPath);
    await recordDraftSave(labels, {
      draftPath,
      sourceHandle: store.projectFileHandle,
      displayName: store.filename ?? "project",
      savedAt: Date.now(),
      // Identity snapshot of the source we based this draft on, so restore can
      // detect if the on-disk file diverges before a later in-place ⌘S.
      sourceSize: store.projectFile?.size,
      sourceLastModified: store.projectFile?.lastModified,
    });
    store.set("pendingExport", true);
    // Mark clean only when the draft is the primary save target AND no edit
    // landed mid-write. A mid-write edit already re-armed via the editSeq
    // subscription; a small file stays dirty until ⌘S writes disk.
    if (targetIsDraft && useAppStore.getState().editSeq === seqAtStart) {
      store.clearChanges();
    }
    console.log("[autosave] labels draft saved ->", draftPath);
  } catch (err) {
    // Keep hasChanges set + re-arm so a later tick retries.
    console.warn("[autosave] failed:", err);
    if (reArm) reArm();
  } finally {
    inFlight = false;
  }
}

/**
 * Wire debounced auto-save to label edits. Subscribes to the `editSeq` counter
 * (bumped on every edit — unlike the `hasChanges` boolean, which transitions
 * only once), so each edit resets the debounce; the save fires once edits
 * settle. Skips/failures re-arm themselves. Returns a teardown. Call once.
 */
export function setupLabelsAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void maybeAutosaveLabelsDraft(arm);
    }, AUTOSAVE_DEBOUNCE_MS);
  };
  const unsub = useAppStore.subscribe(
    (s) => s.editSeq,
    () => {
      if (useAppStore.getState().hasChanges) arm();
    },
  );
  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
