/**
 * Guard against discarding unsaved work when replacing the current project.
 *
 * "Unsaved work" is broader than in-memory edits: after a browser large-pkg ⌘S,
 * the edits are saved to a durable local labels DRAFT (so `hasChanges` is
 * cleared) but not yet exported/compiled to disk (`pendingExport`). Replacing
 * the project in that state would orphan the draft and lose those edits, so
 * every in-app project-replacement path must consult BOTH flags — matching the
 * AppShell beforeunload guard. (Browser close/refresh is covered by beforeunload;
 * these helpers cover in-app New/Open/Import.)
 */
import { useAppStore, type AppState } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import { removeLabelsDraft } from "@/lib/labelsDraft";
import { deleteDraftEntry } from "@/lib/draftManifest";
import { removeTauriDraft } from "@/lib/tauriDraft";
import { confirmDialog } from "@/stores/confirmStore";

/** True when replacing the project would lose work: in-memory edits, or a labels
 *  draft saved locally but not yet exported/compiled to disk. Pure. */
export function hasUnsavedWork(
  state: Pick<AppState, "hasChanges" | "pendingExport">,
): boolean {
  return state.hasChanges || state.pendingExport;
}

/** The confirm-dialog message for discarding unsaved work. `verb` names the
 *  replacing action ("Opening a new project", "Creating a new project", …).
 *  Pure. */
export function discardPromptMessage(opts: {
  pendingExport: boolean;
  verb: string;
}): string {
  if (opts.pendingExport) {
    return `You have edits saved in your browser but not yet exported to disk. ${opts.verb} will discard them. Continue?`;
  }
  return `You have unsaved changes. ${opts.verb} will discard them. Continue?`;
}

/**
 * Prompt (only when there is unsaved work) before replacing the current
 * project; resolves true to proceed. On a confirmed discard, the local labels
 * draft is removed best-effort — BOTH its OPFS file and its manifest entry, so
 * it doesn't reappear as a phantom (un-restorable) "Restore unsaved work?" card.
 * `setLabels` only nulls the in-memory path. Reads the live store, so callers
 * need not pass state.
 *
 * ASYNC: routes through the in-app {@link confirmDialog} (a styled React modal),
 * NOT `window.confirm` — which is broken in the Tauri WebView (shimmed to a
 * missing dialog-plugin command and async, so `if (!window.confirm(...))`
 * silently bypasses the guard and discards unsaved work). Every caller MUST
 * `await` this: a bare `if (!confirmDiscardUnsavedWork(...))` tests a Promise
 * (always truthy) and would never cancel.
 */
export async function confirmDiscardUnsavedWork(
  verb: string,
): Promise<boolean> {
  const store = useAppStore.getState();
  if (!hasUnsavedWork(store)) return true;
  const proceed = await confirmDialog({
    title: "Discard unsaved changes?",
    message: discardPromptMessage({ pendingExport: store.pendingExport, verb }),
    confirmLabel: "Discard",
    cancelLabel: "Cancel",
    destructive: true,
  });
  if (!proceed) return false;
  const draft = store.labelsDraftPath;
  if (draft) {
    if (isTauri) {
      // Desktop: the draft is a disk file + a JSON-manifest entry.
      void removeTauriDraft(draft);
    } else {
      // Browser: the draft is an OPFS file + an IndexedDB manifest entry.
      void removeLabelsDraft(draft);
      void deleteDraftEntry(draft);
    }
  }
  return true;
}
