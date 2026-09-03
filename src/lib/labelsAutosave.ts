/**
 * Debounced background auto-save of the labels DRAFT — a crash-recovery net for
 * BOTH runtimes. Like a video editor auto-saving its edit list: as you edit, the
 * labels are persisted to a small local draft a beat after you stop — instant,
 * silent, no toast, no image copy (refs only, NO pixels → no memory ceiling).
 *
 *  - Browser: writes the draft to OPFS (see labelsDraft.ts). EVERY browser project
 *    gets it (the browser is unstable). For a large embedded pkg the draft is also
 *    ⌘S's primary save target, so a draft-write marks the project clean; for a
 *    small/regular .slp the draft is ONLY a net, so it stays dirty until ⌘S.
 *  - Desktop (Tauri): writes the SAME imageless draft to an app-local data dir
 *    (see tauriDraft.ts). Here the draft is PURELY a crash-recovery net — ⌘S
 *    writes the real disk file — so a draft-write NEVER marks the project clean;
 *    it stays dirty vs disk until ⌘S, which clears the draft. On launch, a
 *    lingering draft means unsaved work when the app last stopped → recover prompt
 *    (see draftRestoreTauri.ts).
 */
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import { decideBrowserSaveAction } from "@/lib/saveRouting";
import { isOpfsSaveSupported } from "@/lib/saveEmbeddedPkgOpfs";
import { newDraftPath, isLabelsDraftSupported } from "@/lib/labelsDraft";
import { recordDraftSave } from "@/lib/draftManifest";
import { newTauriDraftPath, recordTauriDraftSave } from "@/lib/tauriDraft";
import { computeAutosaveDebounceMs } from "@/lib/autosaveDebounce";

/** Duration (ms) of the most recent draft write, measured around the actual
 *  save. Seeds the adaptive debounce so a slow (large-project) write backs off
 *  the next schedule. 0 until the first save. */
let lastAutosaveWriteMs = 0;

/** Serialize the whole draft each time, so overlapping runs would double-write;
 *  a single-flight guard keeps only one in flight. */
let inFlight = false;

/** Explain (once) why crash-recovery auto-save is off in this browser, so a
 *  silent no-op doesn't look like a bug. */
let warnedDraftUnsupported = false;
function warnDraftUnsupportedOnce(): void {
  if (warnedDraftUnsupported) return;
  warnedDraftUnsupported = true;
  console.info(
    "[autosave] crash-recovery draft disabled in this browser " +
      "(no FileSystemFileHandle.createWritable — e.g. Safari). Your edits still " +
      "save normally via ⌘S / Save As.",
  );
}

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
  if (inFlight) return;
  // Desktop: a disk-backed crash-recovery net (never marks the project clean).
  if (isTauri) {
    await maybeAutosaveTauriDraft(reArm);
    return;
  }
  const store = useAppStore.getState();
  const labels = store.labels;
  // The draft is WRITTEN to OPFS via createWritable, which Safari's OPFS lacks
  // (see isLabelsDraftSupported). Where unsupported, skip the draft entirely —
  // no error, no re-arm/retry loop — and note it once; ⌘S still saves normally.
  if (!isLabelsDraftSupported()) {
    if (labels && store.hasChanges) warnDraftUnsupportedOnce();
    return;
  }
  // Don't race a manual save/compile (they own the overlay), and only save when
  // the project is actually dirty and loaded.
  if (!labels || !store.hasChanges || store.isLoading) {
    if (labels && store.hasChanges && reArm) reArm();
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
    const writeT0 = performance.now();
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
    lastAutosaveWriteMs = performance.now() - writeT0;
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
 * Desktop (Tauri) auto-save: write the imageless labels draft to an app-local
 * data dir a beat after edits settle — a pure crash-recovery net. Unlike the
 * browser large-pkg case, this NEVER calls `clearChanges()`: ⌘S writes the real
 * disk file, so the project stays dirty vs disk until then (and a successful ⌘S /
 * discard clears the draft). Keeps the shared single-flight guard + `reArm` retry.
 */
async function maybeAutosaveTauriDraft(reArm?: () => void): Promise<void> {
  const store = useAppStore.getState();
  const labels = store.labels;
  // Only save when the project is actually dirty and loaded (and not mid-load).
  if (!labels || !store.hasChanges || store.isLoading) {
    if (labels && store.hasChanges && reArm) reArm();
    return;
  }

  inFlight = true;
  try {
    // Mint (once per session) or reuse the draft path. The full disk path is
    // resolved async (app-data dir), then committed to the store so continued
    // edits + a later ⌘S target/clear the same draft.
    const minting = !store.labelsDraftPath;
    const draftPath =
      store.labelsDraftPath ??
      (await newTauriDraftPath(store.filename ?? undefined));
    store.set("labelsDraftPath", draftPath);

    // Capture the ORIGINAL file's identity snapshot ONCE, when minting, so
    // restore can detect an on-disk divergence before re-linking for an in-place
    // ⌘S. The source doesn't change while editing in memory, so later saves keep
    // the recorded snapshot (recordTauriDraftSave preserves it). Best-effort.
    let sourceSize: number | undefined;
    let sourceLastModified: number | undefined;
    if (minting && store.projectPath) {
      try {
        const { stat } = await import("@tauri-apps/plugin-fs");
        const info = await stat(store.projectPath);
        sourceSize = info.size ?? undefined;
        sourceLastModified = info.mtime
          ? new Date(info.mtime).getTime()
          : undefined;
      } catch {
        /* best-effort snapshot — restore falls back to re-linking in place */
      }
    }

    const writeT0 = performance.now();
    await recordTauriDraftSave(labels, {
      draftPath,
      projectPath: store.projectPath,
      displayName: store.filename ?? "project",
      savedAt: Date.now(),
      sourceSize,
      sourceLastModified,
    });
    lastAutosaveWriteMs = performance.now() - writeT0;
    // NOTE: intentionally NO store.clearChanges() — desktop ⌘S owns the disk
    // file; the draft is only a net, so the project stays dirty until ⌘S.
    console.log("[autosave] Tauri labels draft saved ->", draftPath);
  } catch (err) {
    console.warn("[autosave] Tauri draft failed:", err);
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
// While a node-drag gesture is active, autosave must NOT serialize the whole
// project — on a large project that write freezes the drag. VideoPlayer toggles
// this; a debounce that lands mid-gesture re-arms past it instead of saving so
// the save happens once, after release. (#329)
let autosaveInteracting = false;
export function setLabelsAutosaveInteracting(active: boolean): void {
  autosaveInteracting = active;
}

export function setupLabelsAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    // Adaptive debounce: the draft write re-serializes the WHOLE project, so on
    // a large project wait proportionally longer. A fixed 1.5s fired the
    // multi-second serialize right after an edit-pause and froze the next
    // interaction (the "freeze on click"). Estimated from the labeled-frame
    // count, refined by the last measured write.
    const frameCount = useAppStore.getState().labels?.labeledFrames.length ?? 0;
    const delay = computeAutosaveDebounceMs(frameCount, lastAutosaveWriteMs);
    timer = setTimeout(() => {
      if (autosaveInteracting) {
        arm(); // defer: never serialize mid node-drag gesture (#329)
        return;
      }
      void maybeAutosaveLabelsDraft(arm);
    }, delay);
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
