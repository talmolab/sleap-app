/**
 * Cross-runtime discovery of recoverable crash-recovery drafts for the Welcome
 * screen's "Restore unsaved work?" card. A single in-app surface for BOTH runtimes
 * (replacing the old desktop `window.confirm` auto-prompt): the browser lists its
 * OPFS drafts (IndexedDB manifest), desktop lists its on-disk drafts (JSON
 * manifest). Both are normalized to {@link RecoverableDraft} so the card renders
 * one list and calls the right restore/discard per entry — recovery is always
 * USER-INITIATED (a click), never an automatic pop-up, so it can't double-fire and
 * is trivially escapable (just start a New/Open project instead).
 */
import { isTauri } from "@/lib/platform";
import {
  listDraftEntries,
  type DraftManifestEntry,
} from "@/lib/draftManifest";
import { restoreDraft, discardDraft } from "@/lib/draftRestore";
import { listTauriDraftEntries, removeTauriDraft } from "@/lib/tauriDraft";
import type { TauriDraftManifestEntry } from "@/lib/tauriDraftManifest";
import { restoreTauriDraft } from "@/lib/draftRestoreTauri";

/** A recoverable draft, normalized across the browser (OPFS) + desktop (disk)
 *  sources so the Welcome card is source-agnostic. `restore`/`discard` are thin
 *  closures over the already-tested per-runtime helpers. */
export interface RecoverableDraft {
  /** Stable key for React + de-dup (the draft's path). */
  key: string;
  /** Project name to show ("minimal_instance.slp"). */
  displayName: string;
  /** Epoch ms the draft was last written (for "saved N ago"). */
  savedAt: number;
  /** Restore this draft as the active project (loads labels, re-links source). */
  restore: () => Promise<unknown>;
  /** Permanently discard this draft (delete file/entry). */
  discard: () => Promise<void>;
}

/** Map desktop (Tauri) draft entries to the normalized card shape. Pure. */
export function normalizeTauriDrafts(
  entries: TauriDraftManifestEntry[],
): RecoverableDraft[] {
  return entries.map((e) => ({
    key: e.draftPath,
    displayName: e.displayName,
    savedAt: e.savedAt,
    restore: () => restoreTauriDraft(e),
    discard: () => removeTauriDraft(e.draftPath),
  }));
}

/** Map browser (OPFS) draft entries to the normalized card shape. Pure. */
export function normalizeBrowserDrafts(
  entries: DraftManifestEntry[],
): RecoverableDraft[] {
  return entries.map((e) => ({
    key: e.draftPath,
    displayName: e.displayName,
    savedAt: e.savedAt,
    restore: () => restoreDraft(e),
    discard: () => discardDraft(e),
  }));
}

/**
 * Discover recoverable drafts for the current runtime, newest-first, normalized.
 * Desktop → on-disk drafts; browser → OPFS drafts. Best-effort: a discovery
 * failure (IndexedDB unavailable in private mode, no Tauri fs) yields an empty
 * list rather than throwing, so the Welcome screen still renders.
 */
export async function loadRecoverableDrafts(): Promise<RecoverableDraft[]> {
  try {
    if (isTauri) {
      return normalizeTauriDrafts(await listTauriDraftEntries());
    }
    return normalizeBrowserDrafts(await listDraftEntries());
  } catch {
    return [];
  }
}
