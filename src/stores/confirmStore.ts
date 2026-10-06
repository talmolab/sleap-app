/**
 * App-wide promise-based confirm, rendered as an in-WebView React modal
 * ({@link import("@/components/dialogs/ConfirmDialog").ConfirmDialog}) styled to
 * match SLEAP — NOT a native OS dialog and NOT `window.confirm`.
 *
 * Why not `window.confirm`: in the Tauri WebView it's shimmed to a dialog-plugin
 * command that doesn't exist ("dialog.confirm not allowed. Command not found")
 * and is async, so `if (!window.confirm(...))` silently bypasses the guard. The
 * plugin's own `confirm()` works but shows a plain native OS alert that clashes
 * with the app's look. This helper avoids both: one consistent, styled prompt in
 * the browser AND desktop.
 *
 * Usage: `if (!(await confirmDialog({ message: "…?" }))) return;`
 */

import { create } from "zustand";

export interface ConfirmRequest {
  /** Header text (default "Confirm"). */
  title?: string;
  /** Body — `\n` renders as line breaks. */
  message: string;
  /** Confirm button label (default "OK"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** Style the confirm button as destructive (default false). */
  destructive?: boolean;
}

interface ConfirmStore {
  request: ConfirmRequest | null;
  /** Show the modal; resolves true=confirm, false=cancel/dismiss. */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  /** Answer the active request (from the dialog buttons / dismiss). */
  respond: (ok: boolean) => void;
}

// Single pending resolver — confirms are sequential; a new request supersedes any
// pending one (resolved false). Not render state, so kept out of the store.
let resolver: ((ok: boolean) => void) | null = null;

export const useConfirmStore = create<ConfirmStore>((set) => ({
  request: null,
  confirm: (req) =>
    new Promise<boolean>((resolve) => {
      resolver?.(false); // supersede any prior pending confirm
      resolver = resolve;
      set({ request: req });
    }),
  respond: (ok) => {
    const r = resolver;
    resolver = null;
    set({ request: null });
    r?.(ok);
  },
}));

/** Promise-based confirm. Resolves `true` (confirmed) or `false` (cancel/dismiss). */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().confirm(req);
}
