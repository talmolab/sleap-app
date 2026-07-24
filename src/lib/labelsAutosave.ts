/**
 * Debounced background auto-save of the labels DRAFT for the browser EDL-style
 * fast-save (see labelsDraft.ts). Like a video editor auto-saving its edit list:
 * as you edit, the labels are persisted to a small local OPFS draft a beat after
 * you stop — instant, silent, no toast, no image copy. The heavy full-file
 * "compile" stays a manual, explicit Export.
 *
 * Only large embedded pkgs in the browser get auto-save (the case where a manual
 * save is otherwise expensive); small files and the desktop are untouched —
 * their normal ⌘S is already cheap. Eligibility reuses the same routing as ⌘S
 * (`decideBrowserSaveAction` → "save-labels-draft").
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
  // Don't race a manual save/compile (they own the loading overlay). If there is
  // still work, re-arm so we retry once it settles rather than stalling.
  if (!labels || !store.hasChanges || store.isLoading) {
    if (labels && store.hasChanges && reArm) reArm();
    return;
  }

  const source = store.projectFileHandle ?? store.projectFile;
  const eligible =
    decideBrowserSaveAction({
      hasEmbeddedImages: labels.videos.some((v) => v.hasEmbeddedImages),
      hasSource: !!source,
      isOpfsSupported: isOpfsSaveSupported(),
      estimatedOutputBytes: store.projectFile?.size ?? null,
      forceDialog: false,
    }) === "save-labels-draft";
  if (!eligible) return;

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
    });
    store.set("pendingExport", true);
    // Only mark clean if NO edit landed during the write; otherwise keep it
    // dirty and re-arm so the trailing edit is persisted (not silently dropped).
    if (useAppStore.getState().editSeq === seqAtStart) {
      store.clearChanges();
    } else if (reArm) {
      reArm();
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
