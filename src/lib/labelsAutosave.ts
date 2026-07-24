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
import { saveLabelsDraft, newDraftPath } from "@/lib/labelsDraft";

/** Save the draft this long after edits settle. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

/** Serialize the whole draft each time, so overlapping runs would double-write;
 *  a single-flight guard keeps only one in flight. */
let inFlight = false;

/**
 * Auto-save the current labels to the OPFS draft IF the project is a browser
 * large-embedded-pkg with unsaved edits and no save/compile already running.
 * Silent (no toast/overlay). Best-effort: on failure it leaves `hasChanges` set
 * so a later auto-save or manual ⌘S retries.
 */
export async function maybeAutosaveLabelsDraft(): Promise<void> {
  if (inFlight || isTauri) return;
  const store = useAppStore.getState();
  const labels = store.labels;
  // Don't race a manual save/compile (they own the loading overlay), and only
  // act when there is something to save.
  if (!labels || !store.hasChanges || store.isLoading) return;

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
  try {
    const draftPath = store.labelsDraftPath ?? newDraftPath(store.filename ?? undefined);
    await saveLabelsDraft(labels, draftPath);
    store.set("labelsDraftPath", draftPath);
    store.set("pendingExport", true);
    store.clearChanges();
    console.log("[autosave] labels draft saved ->", draftPath);
  } catch (err) {
    // Keep hasChanges set (don't clear) so the next edit/⌘S retries.
    console.warn("[autosave] failed:", err);
  } finally {
    inFlight = false;
  }
}

/**
 * Wire debounced auto-save to label edits. Subscribes to `hasChanges`; each time
 * it flips true, (re)arms a debounce timer that auto-saves the draft once edits
 * settle. Returns an unsubscribe/teardown. Call once (e.g. an AppShell effect).
 */
export function setupLabelsAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = useAppStore.subscribe(
    (s) => s.hasChanges,
    (hasChanges) => {
      if (!hasChanges) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void maybeAutosaveLabelsDraft();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
  );
  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
