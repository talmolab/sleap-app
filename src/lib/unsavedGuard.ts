/**
 * Guard against discarding unsaved work when replacing the current project.
 *
 * "Unsaved work" is broader than in-memory edits: after a browser large-pkg ⌘S,
 * the edits are saved to a durable OPFS working copy (so `hasChanges` is
 * cleared) but not yet exported to disk (`workingCopyPendingExport`). Replacing
 * the project in that state would orphan the working copy and lose those edits,
 * so every in-app project-replacement path must consult BOTH flags — matching
 * the AppShell beforeunload guard. (Browser close/refresh is covered by
 * beforeunload; these helpers cover in-app New/Open/Import.)
 */
import { useAppStore, type AppState } from "@/stores/appStore";
import { removeWorkingCopy } from "@/lib/opfsWorkingCopy";

/** True when replacing the project would lose work: in-memory edits, or a
 *  working copy saved locally to OPFS but not yet exported to disk. Pure. */
export function hasUnsavedWork(
  state: Pick<AppState, "hasChanges" | "workingCopyPendingExport">,
): boolean {
  return state.hasChanges || state.workingCopyPendingExport;
}

/** The confirm-dialog message for discarding unsaved work. `verb` names the
 *  replacing action ("Opening a new project", "Creating a new project", …).
 *  Pure. */
export function discardPromptMessage(opts: {
  workingCopyPendingExport: boolean;
  verb: string;
}): string {
  if (opts.workingCopyPendingExport) {
    return `You have edits saved in your browser but not yet written to disk. ${opts.verb} will discard them. Continue?`;
  }
  return `You have unsaved changes. ${opts.verb} will discard them. Continue?`;
}

/**
 * Prompt (only when there is unsaved work) before replacing the current
 * project; returns true to proceed. On a confirmed discard of a not-yet-exported
 * OPFS working copy, its file is removed best-effort (fire-and-forget) so it
 * doesn't orphan — `setLabels` only nulls the in-memory handle, not the OPFS
 * file. Reads the live store, so callers need not pass state.
 */
export function confirmDiscardUnsavedWork(verb: string): boolean {
  const store = useAppStore.getState();
  if (!hasUnsavedWork(store)) return true;
  const proceed = window.confirm(
    discardPromptMessage({
      workingCopyPendingExport: store.workingCopyPendingExport,
      verb,
    }),
  );
  if (!proceed) return false;
  const wc = store.workingCopy;
  if (wc) void removeWorkingCopy(wc);
  return true;
}
