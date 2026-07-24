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
import { removeLabelsDraft } from "@/lib/labelsDraft";

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
 * project; returns true to proceed. On a confirmed discard, the local labels
 * draft is removed best-effort (fire-and-forget) so it doesn't orphan —
 * `setLabels` only nulls the in-memory path, not the OPFS file. Reads the live
 * store, so callers need not pass state.
 */
export function confirmDiscardUnsavedWork(verb: string): boolean {
  const store = useAppStore.getState();
  if (!hasUnsavedWork(store)) return true;
  const proceed = window.confirm(
    discardPromptMessage({ pendingExport: store.pendingExport, verb }),
  );
  if (!proceed) return false;
  const draft = store.labelsDraftPath;
  if (draft) void removeLabelsDraft(draft);
  return true;
}
